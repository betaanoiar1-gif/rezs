const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { Database } = require('../database/db');
const {
  ShortsProductionExecutionService,
  validateVideoArtifact,
  stableProductionJobId,
  sanitizeError
} = require('../services/shorts-production-execution-service');

function preparation(changes = {}) {
  return {
    preparation_id: 'short_prep_test', planning_job_id: 'short_plan_test', status: 'PRODUCTION_READY',
    quality_result: { passed: true },
    specification: {
      duration_seconds: 70,
      mpt_request: { video_subject: 'Astronauts', video_script: 'Approved script', video_terms: ['orbit'], video_aspect: '9:16' },
      scenes: [{ scene_id: 1 }], metadata: { title: 'Title' }
    }, ...changes
  };
}

class MemoryDatabase {
  constructor(prep = preparation()) {
    this.prep = prep;
    this.jobs = new Map();
    this.planning = { job_id: prep.planning_job_id, status: 'SUCCEEDED', artifact: { script: 'Approved script' } };
  }
  async getShortsProductionPreparation(id) { return id === this.prep.preparation_id ? this.prep : null; }
  async getShortsPlanningJob(id) { return id === this.planning.job_id ? this.planning : null; }
  async getProductionJobByPreparation(id) { return [...this.jobs.values()].find(job => job.preparation_id === id) || null; }
  async createProductionJob(job) { this.jobs.set(job.job_id, { retry_count: 0, last_error: null, artifact_path: null, validation_result: null, ...job }); return this.getProductionJob(job.job_id); }
  async getProductionJob(id) { return this.jobs.get(id) || null; }
  async updateProductionJob(id, changes) { this.jobs.set(id, { ...this.jobs.get(id), ...changes }); return this.getProductionJob(id); }
}

function harness({ prep = preparation(), submitError, pollResult, validator, task, downloadError } = {}) {
  const database = new MemoryDatabase(prep);
  let submissions = 0;
  let submittedSpecification;
  const productionService = {
    client: null,
    submit: async (id, specification) => {
      submissions += 1; submittedSpecification = specification;
      if (submitError) throw submitError;
      return database.updateProductionJob(id, { status: 'RUNNING', stage: 'RENDERING', mpt_task_id: 'mpt-task-1' });
    },
    poll: async id => {
      const result = pollResult || { status: 'SUCCEEDED', stage: 'RENDERED' };
      return database.updateProductionJob(id, result);
    },
    downloadArtifact: async (id, reference) => {
      if (downloadError) throw downloadError;
      return database.updateProductionJob(id, { status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED', artifact_reference: reference, artifact_path: '/safe/final.mp4' });
    }
  };
  const client = { get_task_status: async () => task || ({ videos: ['/tasks/mpt-task-1/final-1.mp4'] }) };
  const service = new ShortsProductionExecutionService({
    database, client, productionService,
    artifactValidator: validator || (async () => ({ passed: true, file_size: 1234, duration_seconds: 70, resolution: '1080x1920', video_codec: 'h264', audio_codec: 'aac' }))
  });
  return { database, service, submissions: () => submissions, submittedSpecification: () => submittedSpecification };
}

test('PRODUCTION_READY preparation submits the exact approved MPT request', async () => {
  const h = harness();
  const approved = JSON.parse(JSON.stringify(h.database.prep.specification));
  const job = await h.service.start('short_prep_test');
  assert.equal(job.status, 'RUNNING');
  assert.equal(job.mpt_task_id, 'mpt-task-1');
  assert.deepEqual(h.submittedSpecification(), approved.mpt_request);
  assert.deepEqual(h.database.prep.specification, approved);
});

test('REJECTED preparation cannot bypass Phase 3B', async () => {
  const h = harness({ prep: preparation({ status: 'REJECTED', quality_result: { passed: false } }) });
  await assert.rejects(h.service.start('short_prep_test'), error => error.code === 'PREPARATION_NOT_READY');
  assert.equal(h.submissions(), 0);
});

test('missing preparation returns structured error', async () => {
  const h = harness();
  await assert.rejects(h.service.start('missing'), error => error.code === 'PREPARATION_NOT_FOUND');
});

test('MPT submission failure persists FAILED without an artifact', async () => {
  const h = harness({ submitError: new Error('gateway unavailable') });
  await assert.rejects(h.service.start('short_prep_test'), error => error.code === 'MPT_SUBMISSION_FAILED');
  const job = [...h.database.jobs.values()][0];
  assert.equal(job.status, 'FAILED');
  assert.equal(job.stage, 'SUBMISSION_FAILED');
  assert.equal(job.artifact_path, null);
});

test('successful submission persists RUNNING', async () => {
  const h = harness();
  const job = await h.service.start('short_prep_test');
  assert.equal(job.status, 'RUNNING');
  assert.equal((await h.service.get(job.job_id)).status, 'RUNNING');
});

test('MPT success downloads and validates the final artifact', async () => {
  const h = harness();
  const submitted = await h.service.start('short_prep_test');
  const result = await h.service.execute(submitted.job_id);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.stage, 'ARTIFACT_DOWNLOADED');
  assert.equal(result.artifact_reference, '/api/v1/download/mpt-task-1/final-1.mp4');
  assert.equal(result.validation_result.passed, true);
});

test('invalid artifact persists ARTIFACT_VALIDATION_FAILED', async () => {
  const validation = { passed: false, failures: ['no audio'] };
  const error = new Error('no audio'); error.validation = validation;
  const h = harness({ validator: async () => { throw error; } });
  const job = await h.service.start('short_prep_test');
  await assert.rejects(h.service.execute(job.job_id), caught => caught.code === 'ARTIFACT_VALIDATION_FAILED');
  const stored = await h.database.getProductionJob(job.job_id);
  assert.equal(stored.status, 'FAILED');
  assert.deepEqual(stored.validation_result, validation);
});

test('valid MP4 validation checks streams, codecs, orientation, duration and full decode', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-validation-'));
  const file = path.join(directory, 'video.mp4');
  await fs.writeFile(file, Buffer.from('nonempty deterministic fixture'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let decoded = false;
  const result = await validateVideoArtifact(file, 70, {
    probe: async () => ({ container: 'mov,mp4', duration: 69.5, video: { codec: 'h264', width: 1080, height: 1920 }, audio: { codec: 'aac' } }),
    decode: async () => { decoded = true; }
  });
  assert.equal(result.passed, true);
  assert.equal(result.resolution, '1080x1920');
  assert.equal(decoded, true);
});

test('bounded polling timeout remains TIMEOUT', async () => {
  const h = harness({ pollResult: { status: 'TIMEOUT', stage: 'POLL_TIMEOUT', last_error: 'poll limit reached' } });
  const job = await h.service.start('short_prep_test');
  await assert.rejects(h.service.execute(job.job_id), error => error.code === 'MPT_TIMEOUT');
  assert.equal((await h.database.getProductionJob(job.job_id)).status, 'TIMEOUT');
});

test('existing production reuses one job and never submits a second MPT task', async () => {
  const h = harness();
  const first = await h.service.start('short_prep_test');
  const second = await h.service.start('short_prep_test');
  assert.equal(first.job_id, second.job_id);
  assert.equal(second.reused, true);
  assert.equal(h.submissions(), 1);
  assert.equal(h.database.jobs.size, 1);
});

test('repeated status lookup does not mutate production state', async () => {
  const h = harness();
  const job = await h.service.start('short_prep_test');
  const before = JSON.parse(JSON.stringify(await h.service.get(job.job_id)));
  const after = await h.service.get(job.job_id);
  assert.deepEqual(after, before);
});

test('complete provenance chain remains queryable', async () => {
  const h = harness();
  const submitted = await h.service.start('short_prep_test');
  const finished = await h.service.execute(submitted.job_id);
  const chain = await h.service.getProvenance(finished.job_id);
  assert.equal(chain.planning.job_id, 'short_plan_test');
  assert.equal(chain.preparation.preparation_id, 'short_prep_test');
  assert.equal(chain.production.job_id, stableProductionJobId('short_prep_test'));
  assert.equal(chain.production.mpt_task_id, 'mpt-task-1');
  assert.equal(chain.production.artifact_path, '/safe/final.mp4');
  assert.ok(chain.production.completed_at);
});

test('Phase 3C provenance fields persist through SQLite', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-execution-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'test.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await database.createShortsPlanningJob({ job_id: 'short_plan_sql', topic: 'Topic', status: 'SUCCEEDED', stage: 'PLANNED' });
  await database.createShortsProductionPreparation({ preparation_id: 'short_prep_sql', planning_job_id: 'short_plan_sql', status: 'PRODUCTION_READY' });
  await database.createProductionJob({ job_id: 'short_prod_sql', preparation_id: 'short_prep_sql', planning_job_id: 'short_plan_sql', status: 'QUEUED', stage: 'QUEUED' });
  await database.updateProductionJob('short_prod_sql', {
    mpt_task_id: 'mpt-sql', status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED',
    artifact_reference: '/api/v1/download/mpt-sql/final.mp4', artifact_path: '/safe/final.mp4',
    validation_result: { passed: true }, completed_at: '2026-09-28T00:00:00.000Z'
  });
  const stored = await database.getProductionJobByPreparation('short_prep_sql');
  assert.equal(stored.planning_job_id, 'short_plan_sql');
  assert.equal(stored.preparation_id, 'short_prep_sql');
  assert.equal(stored.mpt_task_id, 'mpt-sql');
  assert.equal(stored.artifact_path, '/safe/final.mp4');
  assert.deepEqual(stored.validation_result, { passed: true });
  assert.equal(stored.completed_at, '2026-09-28T00:00:00.000Z');
});

test('credentials are redacted from persisted and returned errors', async () => {
  const h = harness({ submitError: new Error('Authorization: Bearer top-secret api_key=hidden-value') });
  await assert.rejects(h.service.start('short_prep_test'), error => {
    assert.doesNotMatch(error.message, /top-secret|hidden-value/);
    return true;
  });
  const stored = [...h.database.jobs.values()][0];
  assert.doesNotMatch(stored.last_error, /top-secret|hidden-value/);
  assert.match(sanitizeError('api-key: secret'), /\[redacted\]/);
});

test('approved script and specification are never regenerated or modified', async () => {
  const h = harness();
  const before = JSON.stringify(h.database.prep.specification);
  await h.service.start('short_prep_test');
  assert.equal(JSON.stringify(h.database.prep.specification), before);
  assert.equal(h.submittedSpecification().video_script, 'Approved script');
});

test('artifact download failure is structured and persisted', async () => {
  const h = harness({ downloadError: new Error('download unavailable') });
  const job = await h.service.start('short_prep_test');
  await assert.rejects(h.service.execute(job.job_id), error => error.code === 'ARTIFACT_DOWNLOAD_FAILED');
  assert.equal((await h.database.getProductionJob(job.job_id)).stage, 'ARTIFACT_DOWNLOAD_FAILED');
});
