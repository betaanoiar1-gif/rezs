const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const {
  ShortsProductionPreparationService,
  validateProductionPlan,
  stablePreparationId
} = require('../services/shorts-production-preparation-service');
const { Database } = require('../database/db');

const narrationWords = Array.from({ length: 175 }, (_, index) => `word${index + 1}`);
const narration = narrationWords.join(' ');

function validArtifact(changes = {}) {
  return {
    schema_version: 1,
    job_id: 'short_plan_valid',
    topic: 'Why do astronauts appear weightless in space?',
    content_angle: 'Explain orbital free fall visually',
    hook: 'Astronauts are still under gravity, so why do they float?',
    script: narration,
    estimated_duration_seconds: 70,
    scenes: [
      { scene_id: 1, start_seconds: 0, duration_seconds: 20, script_segment: narrationWords.slice(0, 50).join(' '), visual_description: 'Astronaut floating inside a spacecraft', visual_search_terms: ['astronaut', 'spacecraft'] },
      { scene_id: 2, start_seconds: 20, duration_seconds: 50, script_segment: narrationWords.slice(50).join(' '), visual_description: 'Earth and spacecraft following curved paths', visual_search_terms: ['orbit', 'free fall'] }
    ],
    metadata: { title: 'Why Astronauts Float', description: 'Orbital free fall explained.', hashtags: ['#space', '#science'], category: 27 },
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
    if (!this.preparations.has(item.preparation_id)) this.preparations.set(item.preparation_id, { ...item, quality_result: null, specification: null });
    return this.getShortsProductionPreparation(item.preparation_id);
  }
  async updateShortsProductionPreparation(id, changes) {
    this.preparations.set(id, { ...this.preparations.get(id), ...changes });
    return this.getShortsProductionPreparation(id);
  }
  async getShortsProductionPreparation(id) { return this.preparations.get(id) || null; }
}

async function rejected(artifact) {
  const database = new MemoryDatabase(artifact);
  const service = new ShortsProductionPreparationService({ database });
  let error;
  try { await service.prepare(artifact.job_id); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'QUALITY_GATE_FAILED');
  const preparation = [...database.preparations.values()][0];
  assert.equal(preparation.status, 'REJECTED');
  assert.equal(preparation.specification, null);
  return { error, preparation };
}

test('valid planning job becomes production-ready with an MPT specification', async () => {
  const database = new MemoryDatabase();
  const result = await new ShortsProductionPreparationService({ database }).prepare('short_plan_valid');
  assert.equal(result.status, 'PRODUCTION_READY');
  assert.equal(result.quality_result.passed, true);
  assert.equal(result.specification.production_state, 'PRODUCTION_READY');
  assert.equal(result.specification.mpt_request.video_aspect, '9:16');
  assert.equal(result.specification.mpt_request.voice_name, 'en-US-JennyNeural');
  assert.equal(result.specification.mpt_request.voice_rate, 0.75);
  assert.equal(result.specification.mpt_request.voice_volume, 1);
  assert.equal(result.specification.provenance.fact_checking, 'not_performed');
});

test('missing hook is rejected', async () => {
  const { preparation } = await rejected(validArtifact({ hook: '' }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'MISSING_HOOK'));
});

test('missing script is rejected', async () => {
  const { preparation } = await rejected(validArtifact({ script: '' }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'MISSING_SCRIPT'));
});

test('missing scenes is rejected', async () => {
  const { preparation } = await rejected(validArtifact({ scenes: [] }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'MISSING_SCENES'));
});

test('duration outside the Shorts range is rejected', async () => {
  const artifact = validArtifact({ estimated_duration_seconds: 121 });
  artifact.scenes[1].duration_seconds = 101;
  const { preparation } = await rejected(artifact);
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'INVALID_DURATION'));
});

test('malformed source URL is rejected', async () => {
  const research = { available: true, claimed_verified: false, findings: [], sources: [{ title: 'Source', url: 'not-a-url' }] };
  const { preparation } = await rejected(validArtifact({ research }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'INVALID_SOURCE_URL'));
});

test('claimed research without provenance is rejected', async () => {
  const research = { available: true, claimed_verified: true, findings: [{ text: 'A claim' }], sources: [] };
  const { preparation } = await rejected(validArtifact({ research }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'RESEARCH_PROVENANCE_MISSING'));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'UNSUPPORTED_FACT_CHECK_CLAIM'));
});

test('scene timing mismatch is rejected', async () => {
  const artifact = validArtifact();
  artifact.scenes[1].start_seconds = 25;
  const { preparation } = await rejected(artifact);
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'SCENE_TIMING_MISMATCH'));
});

test('missing required metadata is rejected', async () => {
  const { preparation } = await rejected(validArtifact({ metadata: { title: '', description: '', hashtags: [], category: null } }));
  assert.ok(preparation.quality_result.failures.some(item => item.code === 'MISSING_METADATA'));
});

test('failed quality gate never invokes MoneyPrinterTurbo', async () => {
  let submissions = 0;
  const mpt = { submit: async () => { submissions += 1; } };
  const database = new MemoryDatabase(validArtifact({ hook: '' }));
  const service = new ShortsProductionPreparationService({ database, mpt });
  await assert.rejects(service.prepare('short_plan_valid'), error => error.code === 'QUALITY_GATE_FAILED');
  assert.equal(submissions, 0);
  assert.equal(await database.getShortsProductionPreparation(stablePreparationId('short_plan_valid')).then(item => item.status), 'REJECTED');
});

test('successful preparation persists and retrieves through SQLite', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-preparation-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'test.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const artifact = validArtifact();
  await database.createShortsPlanningJob({ job_id: artifact.job_id, topic: artifact.topic, status: 'SUCCEEDED', stage: 'PLANNED' });
  await database.updateShortsPlanningJob(artifact.job_id, { artifact });
  const result = await new ShortsProductionPreparationService({ database }).prepare(artifact.job_id);
  const stored = await database.getShortsProductionPreparation(result.preparation_id);
  assert.equal(stored.status, 'PRODUCTION_READY');
  assert.deepEqual(stored.quality_result, result.quality_result);
  assert.deepEqual(stored.specification, result.specification);
  assert.equal(await database.getProductionJob(result.preparation_id), undefined);
});

test('repeated preparation is deterministic and idempotent', async () => {
  const database = new MemoryDatabase();
  const service = new ShortsProductionPreparationService({ database });
  const first = await service.prepare('short_plan_valid');
  const second = await service.prepare('short_plan_valid');
  assert.equal(first.preparation_id, second.preparation_id);
  assert.deepEqual(first.quality_result, second.quality_result);
  assert.deepEqual(first.specification, second.specification);
  assert.equal(database.preparations.size, 1);
});

test('validator records researched versus AI-generated provenance without overstating fact-checking', () => {
  const plan = validArtifact({ research: { available: true, claimed_verified: false, findings: [], sources: [] } });
  const result = validateProductionPlan(plan);
  assert.equal(result.passed, true);
  assert.equal(result.provenance.generation, 'ai_generated');
  assert.equal(result.provenance.research, 'research_provider_invoked');
  assert.equal(result.provenance.fact_checking, 'not_performed');
});
