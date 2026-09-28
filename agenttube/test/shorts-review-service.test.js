const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { ShortsReviewService, ShortsReviewError } = require('../services/shorts-review-service');
const { OperatorService } = require('../utils/operator-service');

const now = '2026-09-28T12:00:00.000Z';
let directory;
let artifact;

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-review-'));
  artifact = path.join(directory, 'approved.mp4');
  await fs.writeFile(artifact, Buffer.alloc(256, 1));
});
test.after(async () => fs.rm(directory, { recursive: true, force: true }));

function fixture(overrides = {}) {
  const narration = 'Exact approved narration. '.repeat(12);
  const plan = { topic: 'Approved topic', content_angle: 'Approved angle', hook: 'Approved hook', script: narration, metadata: { title: 'A precise title', description: 'A precise approved description '.repeat(3), hashtags: ['one', 'two', 'three'], category: 'Education' }, estimated_duration_seconds: 20,
    scenes: [{ index: 0, start_seconds: 0, end_seconds: 20, duration_seconds: 20, script_segment: narration, visual_description: 'Approved visual' }],
    research: { available: false, status: 'not_performed', sources: [] }, validation: { passed: true } };
  const planning = { job_id: 'plan-1', status: 'SUCCEEDED', stage: 'PLANNING_COMPLETED', artifact: plan, ...overrides.planning };
  const preparation = { preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'PRODUCTION_READY', quality_result: { passed: true }, specification: { preparation_id: 'prep-1', planning_job_id: 'plan-1', production_state: 'PRODUCTION_READY', hook: plan.hook, scenes: plan.scenes, metadata: plan.metadata, duration_seconds: 20, mpt_request: { video_script: narration } }, approved_at: now, ...overrides.preparation };
  const production = { job_id: 'prod-1', preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED', artifact_path: artifact, artifact_size: 256, validation_result: { passed: true, container: 'mp4', audio_codec: 'aac', duration_seconds: 20 }, mpt_task_id: 'mpt-1', completed_at: now, ...overrides.production };
  return { planning, preparation, production };
}

class MemoryDatabase {
  constructor(chain = fixture()) { this.chain = chain; this.products = new Map(); this.reviews = new Map(); this.provenance = new Map(); this.snapshots = new Map(); this.scenes = new Map(); }
  async getProductionJob(id) { return id === this.chain.production?.job_id ? this.chain.production : null; }
  async getShortsProductionPreparation(id) { return id === this.chain.preparation?.preparation_id ? this.chain.preparation : null; }
  async getShortsPlanningJob(id) { return id === this.chain.planning?.job_id ? this.chain.planning : null; }
  async saveProductionData(p) { this.products.set(p.id, copy(p)); return p; }
  async saveProductionSnapshot(p) { this.snapshots.set(p.id, copy(p)); }
  async replaceProductionScenes(id, scenes) { this.scenes.set(id, copy(scenes)); }
  async saveContentProvenance(id, p) { this.provenance.set(id, copy(p)); }
  async saveContentReview(id, r) { this.reviews.set(id, { review_status: r.status, editorData: copy(r.editorData), qualityChecks: copy(r.qualityChecks), review_notes: r.reviewNotes, reviewed_at: r.reviewedAt, created_at: this.reviews.get(id)?.created_at || now }); return this.getProductionBundle(id); }
  async updateProductionStatus(id, status) { this.products.get(id).status = status; }
  async updateProductionScene() {}
  async getProductionBundle(id) {
    const p = this.products.get(id); if (!p) return null;
    const r = this.reviews.get(id) || {};
    return { ...copy(p), ...copy(r), assets: this.snapshots.get(id)?.assets || p.assets, scenes: this.scenes.get(id) || p.scenes, provenance: this.provenance.get(id) || p.provenance };
  }
  async getChannelProfile() { return null; }
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

const passingOperator = { async runQualityChecks(p) { assert.equal(p.assets.audio, null); assert.equal(p.assets.embeddedAudioValidation.passed, true); return { passed: true, blockingFailures: [], checks: [{ id: 'narration', passed: true }] }; } };
function service(db = new MemoryDatabase(), operator = passingOperator) { return { db, value: new ShortsReviewService({ database: db, operator }) }; }

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error instanceof ShortsReviewError && error.code === code);
}

test('requires an existing completed Phase 3C chain', async () => {
  const missing = service(new MemoryDatabase(fixture({ production: { job_id: 'other' } })));
  await expectCode(missing.value.handoff('prod-1'), 'PRODUCTION_NOT_FOUND');
  for (const change of [{ status: 'RUNNING' }, { stage: 'ARTIFACT_VALIDATED' }]) {
    const current = service(new MemoryDatabase(fixture({ production: change })));
    await expectCode(current.value.handoff('prod-1'), 'PRODUCTION_NOT_READY');
  }
});

test('requires a regular non-empty validated artifact', async () => {
  const missing = service(new MemoryDatabase(fixture({ production: { artifact_path: path.join(directory, 'missing.mp4') } })));
  await expectCode(missing.value.handoff('prod-1'), 'ARTIFACT_NOT_FOUND');
  const invalid = service(new MemoryDatabase(fixture({ production: { validation_result: { passed: false } } })));
  await expectCode(invalid.value.handoff('prod-1'), 'ARTIFACT_INVALID');
  const notFile = service(new MemoryDatabase(fixture({ production: { artifact_path: directory } })));
  await expectCode(notFile.value.handoff('prod-1'), 'ARTIFACT_INVALID');
});

test('requires complete immutable approved provenance', async () => {
  const missing = service(new MemoryDatabase(fixture({ preparation: { specification: null } })));
  await expectCode(missing.value.handoff('prod-1'), 'PROVENANCE_INCOMPLETE');
});

test('materializes exact approved inputs and is idempotent', async () => {
  const { db, value } = service();
  const first = await value.handoff('prod-1');
  const second = await value.handoff('prod-1');
  assert.deepEqual(second, first);
  assert.equal(first.productionId, 'prod-1');
  assert.equal(first.status, 'needs_review');
  assert.equal(first.narration, db.chain.planning.artifact.script);
  assert.deepEqual(first.scenes, db.chain.planning.artifact.scenes);
  assert.equal(first.provenance.researchStatus, 'not_performed');
  assert.equal(first.provenance.factCheckStatus, 'pending_review');
  assert.equal(first.artifact.path, artifact);
  assert.equal(db.products.size, 1);
});

test('quality failures enter needs_attention', async () => {
  const failing = { async runQualityChecks() { return { passed: false, blockingFailures: ['narration'], checks: [{ id: 'narration', passed: false }] }; } };
  const { value } = service(new MemoryDatabase(), failing);
  assert.equal((await value.handoff('prod-1')).status, 'needs_attention');
});

test('approval requires every explicit confirmation and remains idempotently local', async () => {
  const { value } = service(); await value.handoff('prod-1');
  await expectCode(value.decide('prod-1', 'approve', { confirmations: {} }), 'APPROVAL_CONFIRMATION_REQUIRED');
  const confirmations = { factualContentReviewed: true, rightsConfirmed: true, metadataReviewed: true, privacyReviewed: true, syntheticMediaReviewed: true };
  const approved = await value.decide('prod-1', 'approve', { reviewer: 'human', confirmations, notes: 'Reviewed.' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.provenance.factCheckStatus, 'human_reviewed_no_recorded_sources');
  assert.deepEqual(await value.decide('prod-1', 'approve', { reviewer: 'human', confirmations }), approved);
  await expectCode(value.decide('prod-1', 'reject', { reason: 'later' }), 'REVIEW_LOCKED');
});

test('reject and request changes require reasons and preserve immutable content', async () => {
  for (const [action, status] of [['reject', 'rejected'], ['request-changes', 'needs_attention']]) {
    const { value } = service(); const before = await value.handoff('prod-1');
    await expectCode(value.decide('prod-1', action, {}), action === 'reject' ? 'REJECTION_REASON_REQUIRED' : 'CHANGE_REASON_REQUIRED');
    const after = await value.decide('prod-1', action, { reason: 'Operator explanation', reviewer: 'human' });
    assert.equal(after.status, status); assert.equal(after.narration, before.narration); assert.equal(after.artifact.path, before.artifact.path);
    assert.deepEqual(await value.decide('prod-1', action, { reason: 'Operator explanation', reviewer: 'human' }), after);
  }
});

test('redacts source credentials from review responses', async () => {
  const chain = fixture(); chain.planning.artifact.research = { available: true, status: 'performed', sources: [{ url: 'https://user:pass@example.com/page?api_key=secret&x=ok' }] };
  const { value } = service(new MemoryDatabase(chain));
  const text = JSON.stringify(await value.handoff('prod-1'));
  assert.doesNotMatch(text, /secret|user:pass/); assert.match(text, /REDACTED/);
});

test('generic quality checks accept only strict final-MP4 embedded audio evidence', async () => {
  const database = { async getChannelProfile() { return null; } };
  const operator = new OperatorService(database);
  const production = { id: 'p', contentType: 'short', title: 'Valid educational short title', description: 'Detailed approved description '.repeat(3), tags: ['one', 'two', 'three'], script: 'Safe script', scenes: [], assets: { finalVideo: { path: artifact, validation: { passed: true } }, audio: {}, embeddedAudioValidation: { passed: true, audioCodec: 'aac', durationSeconds: 20, sourceArtifactPath: artifact } }, provenance: { status: 'not_required' } };
  const result = await operator.runQualityChecks(production);
  assert.equal(result.checks.find(c => c.id === 'narration').passed, true);
  production.assets.embeddedAudioValidation.sourceArtifactPath = path.join(directory, 'other.mp4');
  const failed = await operator.runQualityChecks(production);
  assert.equal(failed.checks.find(c => c.id === 'narration').passed, false);
});
