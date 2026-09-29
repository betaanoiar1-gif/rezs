/**
 * Fault injection across the pipeline seams.
 *
 * Each test forces a specific real-world failure — an unreadable directory, a
 * provider outage, a truncated download, a task that vanishes, a process that
 * dies mid-render — and asserts the pipeline fails in a way an operator can
 * act on: a specific error code, a persisted state that matches reality, and
 * no half-written artifact left behind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;

const {
  ShortsProductionPreparationService
} = require('../services/shorts-production-preparation-service');
const { ShortsMaterialService } = require('../services/shorts-material-service');
const { StockMediaError } = require('../integrations/stock-media');
const { MoneyPrinterTurboClient, MptError } = require('../integrations/moneyprinterturbo');
const { Database } = require('../database/db');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const narrationWords = Array.from({ length: 175 }, (_, index) => `word${index + 1}`);
const narration = narrationWords.join(' ');

function validArtifact(changes = {}) {
  return {
    schema_version: 1,
    job_id: 'short_plan_fault',
    topic: 'Why do astronauts appear weightless in space?',
    content_angle: 'Explain orbital free fall visually',
    hook: 'Astronauts are still under gravity, so why do they float?',
    script: narration,
    estimated_duration_seconds: 70,
    scenes: [
      {
        scene_id: 1, start_seconds: 0, duration_seconds: 20,
        script_segment: narrationWords.slice(0, 50).join(' '),
        visual_description: 'Astronaut floating inside a spacecraft',
        visual_search_terms: ['astronaut', 'spacecraft']
      },
      {
        scene_id: 2, start_seconds: 20, duration_seconds: 50,
        script_segment: narrationWords.slice(50).join(' '),
        visual_description: 'Earth and spacecraft following curved paths',
        visual_search_terms: ['orbit', 'free fall']
      }
    ],
    metadata: { title: 'Why Astronauts Float', description: 'Orbital free fall explained.', hashtags: ['#space'], category: 27 },
    research: { available: false, claimed_verified: false, findings: [], sources: [] },
    ai_provider: { available: true, provider: 'fixture-provider', model: 'fixture-model' },
    validation: { passed: true },
    ...changes
  };
}

class MemoryDatabase {
  constructor(artifact = validArtifact()) {
    this.planning = { job_id: artifact.job_id, status: 'SUCCEEDED', artifact };
    this.preparations = new Map();
  }
  async getShortsPlanningJob(id) { return id === this.planning.job_id ? this.planning : null; }
  async createShortsProductionPreparation(item) {
    if (!this.preparations.has(item.preparation_id)) {
      this.preparations.set(item.preparation_id, { ...item, quality_result: null, specification: null });
    }
    return this.getShortsProductionPreparation(item.preparation_id);
  }
  async updateShortsProductionPreparation(id, changes) {
    this.preparations.set(id, { ...this.preparations.get(id), ...changes });
    return this.getShortsProductionPreparation(id);
  }
  async getShortsProductionPreparation(id) { return this.preparations.get(id) || null; }
}

function withMaterialsDir(t, directory) {
  const previousSource = process.env.REZS_SHORTS_MATERIALS_DIR;
  const previousManaged = process.env.REZS_MPT_LOCAL_VIDEOS_DIR;
  process.env.REZS_SHORTS_MATERIALS_DIR = directory;
  process.env.REZS_MPT_LOCAL_VIDEOS_DIR = directory;
  t.after(() => {
    if (previousSource === undefined) delete process.env.REZS_SHORTS_MATERIALS_DIR;
    else process.env.REZS_SHORTS_MATERIALS_DIR = previousSource;
    if (previousManaged === undefined) delete process.env.REZS_MPT_LOCAL_VIDEOS_DIR;
    else process.env.REZS_MPT_LOCAL_VIDEOS_DIR = previousManaged;
  });
}

function silentLogger() { return { warn() {}, info() {}, error() {}, debug() {} }; }

/* ------------------------------------------------------------------ */
/* Material acquisition faults                                         */
/* ------------------------------------------------------------------ */

test('an unreadable materials directory fails loudly instead of reporting no footage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-perm-'));
  await fs.writeFile(path.join(directory, 'clip.mp4'), Buffer.alloc(8));
  await fs.chmod(directory, 0o000);
  t.after(async () => {
    await fs.chmod(directory, 0o700).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Running as root defeats permission bits; skip rather than assert a lie.
  try {
    await fs.readdir(directory);
    t.skip('filesystem permissions are not enforced for this user');
    return;
  } catch {
    // Expected: the directory is genuinely unreadable.
  }

  withMaterialsDir(t, directory);
  const database = new MemoryDatabase();
  await assert.rejects(
    new ShortsProductionPreparationService({ database }).prepare('short_plan_fault'),
    error => {
      assert.equal(error.code, 'MATERIAL_DISCOVERY_FAILED');
      assert.equal(error.details.cause_code, 'EACCES');
      return true;
    }
  );
});

test('a plan with no acquirable footage is rejected, not marked production-ready', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  withMaterialsDir(t, directory);

  const database = new MemoryDatabase();
  await assert.rejects(
    new ShortsProductionPreparationService({ database }).prepare('short_plan_fault'),
    error => {
      assert.equal(error.code, 'NO_PRODUCTION_MATERIALS');
      return true;
    }
  );

  // The persisted record must agree: no specification may be left behind for
  // a later phase to pick up and submit.
  const preparation = [...database.preparations.values()][0];
  assert.equal(preparation.status, 'REJECTED');
  assert.equal(preparation.specification, null);
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'NO_PRODUCTION_MATERIALS'));
});

test('a total provider outage reports every term it tried', async () => {
  const service = new ShortsMaterialService({
    providers: [{
      provider: 'pixabay',
      isConfigured: () => true,
      async downloadBest() { throw new StockMediaError('connect ECONNREFUSED', 'PROVIDER_NETWORK_ERROR'); }
    }],
    logger: silentLogger()
  });

  await assert.rejects(
    service.discoverMaterials(validArtifact()),
    error => {
      assert.equal(error.code, 'NO_VIDEO_RESULTS');
      assert.ok(error.details.terms.length > 0, 'the terms tried must be reported');
      assert.ok(error.details.attempts.length > 0, 'per-term attempts must be reported');
      return true;
    }
  );
});

test('one provider failing hands over to the next instead of failing the plan', async () => {
  const calls = [];
  const service = new ShortsMaterialService({
    providers: [
      {
        provider: 'pixabay',
        isConfigured: () => true,
        async downloadBest(term) {
          calls.push(`pixabay:${term}`);
          throw new StockMediaError('rate limited', 'PROVIDER_RATE_LIMITED');
        }
      },
      {
        provider: 'pexels',
        isConfigured: () => true,
        async downloadBest(term) {
          calls.push(`pexels:${term}`);
          const id = `px-${calls.length}`;
          return {
            provider: 'pexels',
            asset_id: id,
            local_name: `pexels-${id}.mp4`,
            local_path: `/staged/pexels-${id}.mp4`,
            width: 1080,
            height: 1920,
            duration: 12
          };
        }
      }
    ],
    logger: silentLogger()
  });

  const materials = await service.discoverMaterials(validArtifact());
  assert.ok(materials.length > 0);
  assert.ok(calls.some(call => call.startsWith('pixabay:')), 'the first provider must be attempted');
  assert.ok(calls.some(call => call.startsWith('pexels:')), 'the second provider must take over');
  assert.ok(materials.every(material => material.provider === 'local'));
});

test('a misconfigured provider aborts immediately rather than retrying every term', async () => {
  let attempts = 0;
  const service = new ShortsMaterialService({
    providers: [{
      provider: 'pixabay',
      isConfigured: () => true,
      async downloadBest() {
        attempts += 1;
        throw new StockMediaError('missing API key', 'CONFIG_ERROR');
      }
    }],
    logger: silentLogger()
  });

  // A credential fault fails identically for every term; retrying it across
  // terms and providers only delays a certain failure.
  await assert.rejects(service.discoverMaterials(validArtifact()), error => {
    assert.equal(error.code, 'CONFIG_ERROR');
    return true;
  });
  assert.equal(attempts, 1);
});

/* ------------------------------------------------------------------ */
/* Artifact download faults                                            */
/* ------------------------------------------------------------------ */

test('a download that dies mid-stream leaves nothing at the destination', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const client = new MoneyPrinterTurboClient({
    artifactDir: root, maxRetries: 0, retryDelayMs: 0, logger: silentLogger(),
    fetch: async () => ({
      ok: true,
      status: 200,
      body: (async function* stream() {
        yield Buffer.from('half a video');
        throw new Error('socket hang up');
      })()
    })
  });

  await assert.rejects(client.download_artifact('/tasks/t/final.mp4', 'job/final.mp4'));
  // A partially written file that looks like a finished render is worse than
  // no file at all, because later stages treat existence as success.
  await assert.rejects(fs.stat(path.join(root, 'job', 'final.mp4')), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(path.join(root, 'job')).catch(() => []), []);
});

test('an empty artifact is refused rather than stored as a finished render', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-empty-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const client = new MoneyPrinterTurboClient({
    artifactDir: root, maxRetries: 0, retryDelayMs: 0, logger: silentLogger(),
    fetch: async () => ({
      ok: true,
      status: 200,
      body: (async function* stream() { /* no chunks at all */ })()
    })
  });

  await assert.rejects(client.download_artifact('/tasks/t/final.mp4', 'job/final.mp4'), error => {
    assert.ok(error instanceof MptError);
    assert.equal(error.code, 'EMPTY_ARTIFACT');
    return true;
  });
  await assert.rejects(fs.stat(path.join(root, 'job', 'final.mp4')), error => error.code === 'ENOENT');
});

test('an artifact reference escaping the artifact directory is refused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-traversal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const client = new MoneyPrinterTurboClient({
    artifactDir: root, maxRetries: 0, retryDelayMs: 0, logger: silentLogger(),
    fetch: async () => { throw new Error('the request must never be made'); }
  });

  for (const reference of ['../escape.mp4', '/etc/passwd', 'job/../../escape.mp4']) {
    await assert.rejects(
      client.download_artifact('/tasks/t/final.mp4', reference),
      error => error instanceof MptError,
      `reference must be refused: ${reference}`
    );
  }
});

/* ------------------------------------------------------------------ */
/* State integrity under crash and restart                            */
/* ------------------------------------------------------------------ */

test('a production job interrupted mid-render is resumable from its persisted state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-restart-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'jobs.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });

  // Simulate the process dying after submission but before the render finished.
  await database.createProductionJob({
    job_id: 'short_prod_restart',
    preparation_id: 'short_prep_restart',
    status: 'RUNNING',
    stage: 'POLLING',
    mpt_task_id: 'mpt-task-restart'
  });

  // A fresh process must be able to recover the external task handle; losing
  // it would orphan a render that is still running inside MoneyPrinterTurbo.
  const recovered = await database.getProductionJob('short_prod_restart');
  assert.equal(recovered.status, 'RUNNING');
  assert.equal(recovered.mpt_task_id, 'mpt-task-restart');
  assert.equal(recovered.retry_count, 0);

  const byPreparation = await database.getProductionJobByPreparation('short_prep_restart');
  assert.equal(byPreparation.job_id, 'short_prod_restart');
});

test('two concurrent submissions for one preparation cannot create two jobs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-race-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'jobs.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });

  // The UNIQUE constraint on preparation_id is the last line of defence
  // against a double-submit racing past the read-then-write check.
  const results = await Promise.allSettled([
    database.createProductionJob({ job_id: 'short_prod_a', preparation_id: 'short_prep_race', status: 'QUEUED', stage: 'QUEUED' }),
    database.createProductionJob({ job_id: 'short_prod_b', preparation_id: 'short_prep_race', status: 'QUEUED', stage: 'QUEUED' })
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('one MPT task id cannot be claimed by two production jobs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fault-task-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'jobs.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });

  await database.createProductionJob({ job_id: 'short_prod_1', preparation_id: 'short_prep_1', status: 'RUNNING', stage: 'POLLING', mpt_task_id: 'shared-task' });
  await database.createProductionJob({ job_id: 'short_prod_2', preparation_id: 'short_prep_2', status: 'QUEUED', stage: 'QUEUED' });

  // Without this, two jobs would poll one render and both claim its artifact.
  await assert.rejects(database.updateProductionJob('short_prod_2', { mpt_task_id: 'shared-task' }));
});
