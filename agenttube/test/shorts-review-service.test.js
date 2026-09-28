const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ShortsReviewService, ShortsReviewError } = require('../services/shorts-review-service');
const { OperatorService } = require('../utils/operator-service');
const { Database } = require('../database/db');

const now = '2026-09-28T12:00:00.000Z';
const approvedBytes = Buffer.alloc(256, 1);
const approvedSha256 = crypto.createHash('sha256').update(approvedBytes).digest('hex');
let directory;
let artifact;

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-review-'));
  artifact = path.join(directory, 'approved.mp4');
  await fs.writeFile(artifact, approvedBytes);
});
test.beforeEach(async () => fs.writeFile(artifact, approvedBytes));
test.after(async () => fs.rm(directory, { recursive: true, force: true }));

function fixture(overrides = {}) {
  const narration = 'Exact approved narration. '.repeat(12);
  const plan = { topic: 'Approved topic', content_angle: 'Approved angle', hook: 'Approved hook', script: narration, metadata: { title: 'A precise title', description: 'A precise approved description '.repeat(3), hashtags: ['one', 'two', 'three'], category: 'Education' }, estimated_duration_seconds: 20,
    scenes: [{ index: 0, start_seconds: 0, end_seconds: 20, duration_seconds: 20, script_segment: narration, visual_description: 'Approved visual' }],
    research: { available: false, status: 'not_performed', sources: [] }, validation: { passed: true } };
  const planning = { job_id: 'plan-1', status: 'SUCCEEDED', stage: 'PLANNING_COMPLETED', artifact: plan, ...overrides.planning };
  const preparation = { preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'PRODUCTION_READY', quality_result: { passed: true }, specification: { preparation_id: 'prep-1', planning_job_id: 'plan-1', production_state: 'PRODUCTION_READY', hook: plan.hook, scenes: plan.scenes, metadata: plan.metadata, duration_seconds: 20, mpt_request: { video_script: narration } }, approved_at: now, ...overrides.preparation };
  const production = { job_id: 'prod-1', preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED', artifact_path: artifact, artifact_size: 256, validation_result: { passed: true, file_size: 256, sha256: approvedSha256, container: 'mp4', resolution: '1080x1920', video_codec: 'h264', audio_codec: 'aac', duration_seconds: 20 }, mpt_task_id: 'mpt-1', completed_at: now, ...overrides.production };
  return { planning, preparation, production };
}

class MemoryDatabase {
  constructor(chain = fixture()) { this.chain = chain; this.products = new Map(); this.reviews = new Map(); this.provenance = new Map(); this.snapshots = new Map(); this.scenes = new Map(); this.externalCalls = 0; }
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
  async saveShortsFinalApproval(id, { provenance, review }) {
    await this.saveContentProvenance(id, provenance); await this.saveContentReview(id, review); await this.updateProductionStatus(id, 'approved');
    return this.getProductionBundle(id);
  }
  async getProductionBundle(id) {
    const p = this.products.get(id); if (!p) return null;
    const r = this.reviews.get(id) || {};
    return { ...copy(p), ...copy(r), assets: this.snapshots.get(id)?.assets || p.assets, scenes: this.scenes.get(id) || p.scenes, provenance: this.provenance.get(id) || p.provenance };
  }
  async getChannelProfile() { return this.profile || null; }
  async getRow() { return { count: 0 }; }
  async saveScheduleEntry() { this.externalCalls++; throw new Error('Scheduling must not be invoked'); }
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

const passingOperator = { async runQualityChecks(p) { assert.equal(p.assets.audio, null); assert.equal(p.assets.embeddedAudioValidation.passed, true); return { passed: true, blockingFailures: [], checks: [{ id: 'narration', passed: true }] }; } };
async function deterministicValidator(filePath) {
  const bytes = await fs.readFile(filePath);
  return { passed: true, failures: [], file_size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), container: 'mp4', resolution: '1080x1920', video_codec: 'h264', audio_codec: 'aac', duration_seconds: 20 };
}
function service(db = new MemoryDatabase(), operator = passingOperator, artifactValidator = deterministicValidator) {
  return { db, value: new ShortsReviewService({ database: db, operator, artifactValidator }) };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error instanceof ShortsReviewError && error.code === code);
}

function confirmations() {
  return { factualContentReviewed: true, rightsConfirmed: true, metadataReviewed: true, privacyReviewed: true, syntheticMediaReviewed: true };
}

function approval(overrides = {}) {
  return { reviewer: 'human', confirmations: confirmations(), syntheticMediaDetermination: 'contains_synthetic_media', ...overrides };
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

test('blocks inconsistent script, metadata, scenes, hook, duration, and linked IDs', async t => {
  const cases = [
    ['script', chain => { chain.preparation.specification.mpt_request.video_script = 'changed'; }],
    ['metadata', chain => { chain.preparation.specification.metadata = { ...chain.preparation.specification.metadata, title: 'changed' }; }],
    ['scenes', chain => { chain.preparation.specification.scenes = []; }],
    ['hook', chain => { chain.preparation.specification.hook = 'changed'; }],
    ['duration', chain => { chain.preparation.specification.duration_seconds = 21; }],
    ['planning ID', chain => { chain.production.planning_job_id = 'other-plan'; }],
    ['preparation ID', chain => { chain.production.preparation_id = 'other-prep'; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => { const chain = fixture(); mutate(chain); await expectCode(service(new MemoryDatabase(chain)).value.handoff('prod-1'), 'PROVENANCE_INCOMPLETE'); });
  }
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
  const { db, value } = service(); await value.handoff('prod-1');
  await expectCode(value.decide('prod-1', 'approve', { confirmations: {} }), 'APPROVAL_CONFIRMATION_REQUIRED');
  const reviewedConfirmations = confirmations();
  await expectCode(value.decide('prod-1', 'approve', { reviewer: 'human', confirmations: reviewedConfirmations }), 'SYNTHETIC_MEDIA_DETERMINATION_REQUIRED');
  const approved = await value.decide('prod-1', 'approve', { reviewer: 'human', confirmations: reviewedConfirmations, syntheticMediaDetermination: 'contains_synthetic_media', notes: 'Reviewed.' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.provenance.factCheckStatus, 'human_reviewed_no_recorded_sources');
  assert.equal(approved.confirmations.syntheticMediaReviewed, true);
  assert.equal(db.reviews.get('prod-1').editorData.syntheticMediaDetermination, 'contains_synthetic_media');
  assert.equal(db.reviews.get('prod-1').editorData.finalApprovalGate.artifact.sha256, approvedSha256);
  assert.equal(db.provenance.get('prod-1').containsSyntheticMedia, true);
  assert.equal(db.externalCalls, 0);
  assert.deepEqual(await value.decide('prod-1', 'approve', approval()), approved);
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

test('final approval proves artifact identity and rejects changed or malformed evidence', async t => {
  const cases = [
    ['same-size replacement', Buffer.alloc(256, 2), {}, 'ARTIFACT_INTEGRITY_FAILED'],
    ['different-size replacement', Buffer.alloc(257, 1), {}, 'ARTIFACT_INTEGRITY_FAILED'],
    ['malformed evidence', approvedBytes, { sha256: null }, 'ARTIFACT_VALIDATION_EVIDENCE_INVALID']
  ];
  for (const [name, bytes, validation, code] of cases) {
    await t.test(name, async () => {
      await fs.writeFile(artifact, approvedBytes);
      const chain = fixture(); Object.assign(chain.production.validation_result, validation);
      const { value } = service(new MemoryDatabase(chain)); await value.handoff('prod-1');
      await fs.writeFile(artifact, bytes);
      await expectCode(value.decide('prod-1', 'approve', approval()), code);
    });
  }
});

test('final approval rejects missing, empty, and non-regular artifacts', async t => {
  for (const [name, prepare, code] of [
    ['missing', () => fs.rm(artifact, { force: true }), 'ARTIFACT_NOT_FOUND'],
    ['empty', () => fs.writeFile(artifact, Buffer.alloc(0)), 'ARTIFACT_INVALID'],
    ['non-regular', async () => { await fs.rm(artifact, { force: true }); await fs.mkdir(artifact); }, 'ARTIFACT_INVALID']
  ]) {
    await t.test(name, async () => {
      await fs.rm(artifact, { recursive: true, force: true }); await fs.writeFile(artifact, approvedBytes);
      const { value } = service(); await value.handoff('prod-1'); await prepare();
      await expectCode(value.decide('prod-1', 'approve', approval()), code);
      await fs.rm(artifact, { recursive: true, force: true });
    });
  }
});

test('final approval rejects current strict MP4 validation failure', async () => {
  const invalid = async () => { const error = new Error('decode failed'); error.validation = { passed: false, failures: ['Artifact is not fully decodable'] }; throw error; };
  const { value } = service(new MemoryDatabase(), passingOperator, invalid);
  await value.handoff('prod-1');
  await expectCode(value.decide('prod-1', 'approve', approval()), 'FINAL_ARTIFACT_VALIDATION_FAILED');
});

test('needs_attention cannot be approved while a final blocking quality finding remains', async () => {
  const operator = { async runQualityChecks(p) {
    return p.finalReviewEvidence
      ? { passed: false, blockingFailures: ['video'], checks: [{ id: 'video', passed: false, blocking: true }] }
      : { passed: false, blockingFailures: ['provenance'], checks: [{ id: 'provenance', passed: false, blocking: true }] };
  } };
  const { value } = service(new MemoryDatabase(), operator);
  assert.equal((await value.handoff('prod-1')).status, 'needs_attention');
  await expectCode(value.decide('prod-1', 'approve', approval()), 'FINAL_QUALITY_GATE_FAILED');
});

test('actual operator final gate blocks metadata, script, brand, and scene failures', async t => {
  const cases = [
    ['title', chain => { chain.planning.artifact.metadata.title = 'x'.repeat(101); chain.preparation.specification.metadata.title = 'x'.repeat(101); }],
    ['description', chain => { chain.planning.artifact.metadata.description = 'short'; chain.preparation.specification.metadata.description = 'short'; }],
    ['script', chain => { chain.planning.artifact.script = 'too short'; chain.planning.artifact.scenes[0].script_segment = 'too short'; chain.preparation.specification.mpt_request.video_script = 'too short'; chain.preparation.specification.scenes[0].script_segment = 'too short'; }],
    ['brand policy', (_chain, db) => { db.profile = { bannedTopics: ['exact approved narration'] }; }],
    ['scene integrity', (_chain, db) => { if (db.scenes.has('prod-1')) db.scenes.get('prod-1')[0].status = 'failed'; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const chain = fixture(); const db = new MemoryDatabase(chain); mutate(chain, db);
      const value = new ShortsReviewService({ database: db, artifactValidator: deterministicValidator });
      await value.handoff('prod-1');
      if (name === 'scene integrity') mutate(chain, db);
      await expectCode(value.decide('prod-1', 'approve', approval()), 'FINAL_QUALITY_GATE_FAILED');
    });
  }
});

test('human factual review resolves only pending no-source provenance without marking it verified', async () => {
  const db = new MemoryDatabase();
  const value = new ShortsReviewService({ database: db, artifactValidator: deterministicValidator });
  await value.handoff('prod-1');
  const result = await value.decide('prod-1', 'approve', approval({ syntheticMediaDetermination: 'does_not_contain_synthetic_media' }));
  assert.equal(result.status, 'approved');
  assert.equal(db.provenance.get('prod-1').status, 'operator_reviewed');
  assert.equal(db.provenance.get('prod-1').summary.factCheckStatus, 'human_reviewed_no_recorded_sources');
  assert.equal(db.provenance.get('prod-1').containsSyntheticMedia, false);
});

test('redacts source credentials from review responses', async () => {
  const chain = fixture(); chain.planning.artifact.research = { available: true, status: 'performed', sources: [{ url: 'https://user:pass@example.com/page?api_key=secret&x=ok' }] };
  const { value } = service(new MemoryDatabase(chain));
  const text = JSON.stringify(await value.handoff('prod-1'));
  assert.doesNotMatch(text, /secret|user:pass/); assert.match(text, /REDACTED/);
});

test('approval preserves recorded research sources exactly', async () => {
  const chain = fixture();
  const sources = [{ title: 'Recorded source', url: 'https://example.com/evidence', retrieved_at: now }];
  chain.planning.artifact.research = { available: true, status: 'performed', sources };
  const db = new MemoryDatabase(chain); const value = service(db).value;
  await value.handoff('prod-1'); await value.decide('prod-1', 'approve', approval());
  assert.deepEqual(db.provenance.get('prod-1').sources, sources);
  assert.equal(db.provenance.get('prod-1').status, 'verified');
});

test('SQLite persists final approval evidence and status in one transaction', async t => {
  const dbDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-final-approval-'));
  const database = new Database(); database.dbPath = path.join(dbDirectory, 'test.db'); await database.initialize();
  t.after(async () => { await database.close(); await fs.rm(dbDirectory, { recursive: true, force: true }); });
  await database.executeQuery("INSERT INTO productions (id, status, assets, timeline) VALUES (?, 'needs_review', '{}', '{}')", ['atomic-prod']);
  const sources = [{ title: 'Evidence', url: 'https://example.com/evidence' }];
  const result = await database.saveShortsFinalApproval('atomic-prod', {
    provenance: { sources, claims: [], status: 'verified', containsSyntheticMedia: true, summary: { humanReviewed: true }, reviewedAt: now },
    review: { status: 'approved', editorData: { finalApprovalGate: { passed: true } }, qualityChecks: [{ id: 'video', passed: true }], reviewedAt: now },
    sceneIds: []
  });
  assert.equal(result.status, 'approved'); assert.equal(result.review_status, 'approved');
  assert.deepEqual(result.provenance.sources, sources); assert.equal(result.provenance.containsSyntheticMedia, true);
  assert.equal(result.editorData.finalApprovalGate.passed, true);
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
