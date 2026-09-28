const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const {
  ShortsPlanningService,
  validateTopic,
  validateResearch,
  validateShortsPlan
} = require('../services/shorts-planning-service');
const { Database } = require('../database/db');

class MemoryDatabase {
  constructor() { this.jobs = new Map(); }
  async createShortsPlanningJob(job) { this.jobs.set(job.job_id, { ...job, artifact: null }); return this.getShortsPlanningJob(job.job_id); }
  async getShortsPlanningJob(id) { return this.jobs.get(id) || null; }
  async updateShortsPlanningJob(id, changes) { this.jobs.set(id, { ...this.jobs.get(id), ...changes }); return this.getShortsPlanningJob(id); }
}

const available = { isAvailable: () => true, providerName: 'injected-test-provider', model: 'test-model' };
const unavailable = { isAvailable: () => false };
const words = Array.from({ length: 175 }, (_, i) => `fact${i + 1}`).join(' ');

function agents(overrides = {}) {
  return {
    strategyAgent: overrides.strategyAgent || {
      aiTextService: available,
      generateContentStrategy: async topic => ({ topic, angle: 'Explain the physics simply', targetAudience: 'curious learners', contentType: 'Explainer', keywords: ['space', 'weightlessness'], metadata: { generationSource: 'ai' } })
    },
    scriptAgent: overrides.scriptAgent || {
      aiTextService: available,
      generateScript: async () => ({
        title: 'Weightlessness explained',
        hook: { text: 'Astronauts are not beyond gravity, so why do they float?' },
        mainContent: { sections: [{ title: 'Continuous free fall', content: words }] },
        metadata: { generationSource: 'ai' }
      })
    },
    seoAgent: overrides.seoAgent || {
      aiTextService: available,
      optimize: async () => ({ title: 'Why Astronauts Float', description: 'A concise physics explanation.', hashtags: ['#space'], metadata: { category: 27, generationSource: 'ai' } })
    }
  };
}

function validPlan(changes = {}) {
  return {
    topic: 'Why do astronauts float?', hook: 'Gravity is still there.', script: words,
    estimated_duration_seconds: 70, scenes: [{ scene_id: 1 }],
    metadata: { title: 'Title', description: 'Description', hashtags: ['#space'], category: 27 },
    research: { sources: [], claimed_verified: false }, ...changes
  };
}

test('rejects absent and whitespace-only topics', () => {
  assert.throws(() => validateTopic('  '), error => error.code === 'INVALID_TOPIC');
  assert.throws(() => validateTopic(), error => error.code === 'INVALID_TOPIC');
});

test('creates a validated plan from injected successful agent responses', async () => {
  const database = new MemoryDatabase();
  const service = new ShortsPlanningService({ database, ...agents() });
  const job = await service.planTopic('Why do astronauts appear weightless in space?');
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(job.stage, 'PLANNED');
  assert.equal(job.artifact.validation.passed, true);
  assert.ok(job.artifact.scenes[0].visual_description);
  assert.ok(job.artifact.scenes[0].visual_search_terms.length);
  assert.deepEqual(job.artifact.research.sources, []);
  assert.match(job.artifact.warnings[0], /not marked fact-checked/);
  assert.match(job.job_id, /^short_plan_[0-9a-f-]{36}$/);
  assert.equal(job.artifact.job_id, job.job_id);
});

test('missing provider persists BLOCKED job and actionable setup error', async () => {
  const database = new MemoryDatabase();
  const missing = { aiTextService: unavailable };
  const service = new ShortsPlanningService({ database, strategyAgent: missing, scriptAgent: missing, seoAgent: missing });
  await assert.rejects(service.planTopic('A valid topic'), error => error.code === 'AI_PROVIDER_UNAVAILABLE' && /credentials:setup/.test(error.message));
  const job = [...database.jobs.values()][0];
  assert.equal(job.status, 'BLOCKED');
  assert.equal(job.error_code, 'AI_PROVIDER_UNAVAILABLE');
});

test('agent generation failure is persisted with a structured code', async () => {
  const database = new MemoryDatabase();
  const broken = agents({ scriptAgent: { aiTextService: available, generateScript: async () => { throw new Error('provider timeout'); } } });
  await assert.rejects(new ShortsPlanningService({ database, ...broken }).planTopic('A valid topic'), error => error.code === 'PLANNING_FAILED');
  assert.equal([...database.jobs.values()][0].status, 'FAILED');
});

test('refuses a template script fallback as AI generation', async () => {
  const database = new MemoryDatabase();
  const fallback = agents({ scriptAgent: { aiTextService: available, generateScript: async () => ({ hook: 'hook', mainContent: { sections: [] }, metadata: { generationSource: 'template' } }) } });
  await assert.rejects(new ShortsPlanningService({ database, ...fallback }).planTopic('A valid topic'), error => error.code === 'AI_GENERATION_FAILED');
});

test('rejects invalid script, missing hook, and missing scenes', () => {
  assert.throws(() => validateShortsPlan(validPlan({ script: '' })), error => error.code === 'INVALID_SCRIPT');
  assert.throws(() => validateShortsPlan(validPlan({ hook: '' })), error => error.code === 'MISSING_HOOK');
  assert.throws(() => validateShortsPlan(validPlan({ scenes: [] })), error => error.code === 'MISSING_SCENES');
});

test('rejects narration duration outside 60-120 seconds', () => {
  assert.throws(() => validateShortsPlan(validPlan({ estimated_duration_seconds: 59.9 })), error => error.code === 'INVALID_DURATION');
  assert.throws(() => validateShortsPlan(validPlan({ estimated_duration_seconds: 120.1 })), error => error.code === 'INVALID_DURATION');
});

test('rejects absent required metadata', () => {
  assert.throws(() => validateShortsPlan(validPlan({ metadata: { title: 'Title', description: '', hashtags: [], category: null } })), error => error.code === 'INVALID_METADATA');
});

test('rejects malformed source URLs and unsupported verification claims', () => {
  assert.throws(() => validateResearch({ sources: [{ title: 'Bad', url: 'not-a-url' }] }), error => error.code === 'INVALID_SOURCE');
  assert.throws(() => validateResearch({ sources: [], claimed_verified: true }), error => error.code === 'UNSUPPORTED_RESEARCH_CLAIM');
});

test('persists and retrieves a stable planning job separately in SQLite', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-planning-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'test.db');
  await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await database.createShortsPlanningJob({ job_id: 'short_plan_stable', topic: 'Topic', status: 'PENDING', stage: 'RECEIVED' });
  await database.updateShortsPlanningJob('short_plan_stable', { status: 'SUCCEEDED', stage: 'PLANNED', artifact: validPlan() });
  const stored = await database.getShortsPlanningJob('short_plan_stable');
  assert.equal(stored.job_id, 'short_plan_stable');
  assert.equal(stored.status, 'SUCCEEDED');
  assert.equal(stored.artifact.topic, 'Why do astronauts float?');
  assert.equal(await database.getProductionJob('short_plan_stable'), undefined);
});
