const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ShortsReviewService, ShortsReviewError } = require('../services/shorts-review-service');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { YouTubeAutomationAgent } = require('../index');

let directory;
let artifact;
const bytes = Buffer.alloc(512, 7);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const future = () => new Date(Date.now() + 3600000).toISOString();

test.before(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-publish-')); artifact = path.join(directory, 'final.mp4'); });
test.beforeEach(async () => { await fs.rm(artifact, { recursive: true, force: true }); await fs.writeFile(artifact, bytes); });
test.after(async () => fs.rm(directory, { recursive: true, force: true }));

function chain() {
  const sources = [{ title: 'Evidence', url: 'https://example.com/evidence' }];
  const plan = { topic: 'Topic', content_angle: 'Angle', hook: 'Hook', script: 'Approved narration '.repeat(20), metadata: { title: 'Approved title', description: 'Approved description '.repeat(5), hashtags: ['one', 'two', 'three'], category: '22' }, estimated_duration_seconds: 20, scenes: [{ scene_id: 1, start_seconds: 0, duration_seconds: 20, script_segment: 'Approved narration '.repeat(20), visual_description: 'Visual' }], research: { available: true, sources }, validation: { passed: true } };
  const validation = { passed: true, file_size: bytes.length, sha256, duration_seconds: 20, resolution: '1080x1920', video_codec: 'h264', audio_codec: 'aac', container: 'mp4' };
  return {
    planning: { job_id: 'plan-1', status: 'SUCCEEDED', artifact: plan },
    preparation: { preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'PRODUCTION_READY', quality_result: { passed: true }, specification: { preparation_id: 'prep-1', planning_job_id: 'plan-1', production_state: 'PRODUCTION_READY', hook: plan.hook, metadata: plan.metadata, scenes: plan.scenes, duration_seconds: 20, mpt_request: { video_script: plan.script } } },
    production: { job_id: 'prod-1', preparation_id: 'prep-1', planning_job_id: 'plan-1', status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED', artifact_path: artifact, validation_result: validation }
  };
}

function approvedBundle(value = chain()) {
  const validation = value.production.validation_result;
  const determination = 'contains_synthetic_media';
  return {
    id: 'prod-1', status: 'approved', review_status: 'approved', priority: 50,
    script: { title: value.planning.artifact.metadata.title, fullScript: value.planning.artifact.script },
    seo: { title: value.planning.artifact.metadata.title, description: value.planning.artifact.metadata.description, tags: value.planning.artifact.metadata.hashtags, category: '22' },
    assets: { finalVideo: { path: artifact, simulated: false, validation }, audio: null, thumbnail: null, captions: null, embeddedAudioValidation: { passed: true, audioCodec: 'aac', durationSeconds: 20, sourceArtifactPath: artifact } },
    editorData: { confirmations: { factualContentReviewed: true, rightsConfirmed: true, metadataReviewed: true, privacyReviewed: true, syntheticMediaReviewed: true }, syntheticMediaDetermination: determination, containsSyntheticMedia: true, finalApprovalGate: { passed: true, approvedAt: '2026-09-28T00:00:00.000Z', artifact: { path: artifact, sha256, fileSize: bytes.length, technicalValidation: validation } } },
    provenance: { status: 'verified', sources: value.planning.artifact.research.sources, containsSyntheticMedia: true },
    schedule: null
  };
}

class MemoryDb {
  constructor() { this.chain = chain(); this.bundle = approvedBundle(this.chain); this.statuses = []; }
  async getProductionJob(id) { return id === 'prod-1' ? this.chain.production : null; }
  async getShortsProductionPreparation(id) { return id === 'prep-1' ? this.chain.preparation : null; }
  async getShortsPlanningJob(id) { return id === 'plan-1' ? this.chain.planning : null; }
  async getProductionBundle(id) { return id === 'prod-1' ? this.bundle : null; }
  async getLatestScheduleEntry(id) { return id === 'prod-1' ? this.bundle.schedule : null; }
  async updateProductionStatus(_id, status) { if (this.bundle) this.bundle.status = status; this.statuses.push(status); }
  async updateScheduleEntry(entry) { this.bundle.schedule = entry; }
}

function publisher(db) {
  return { calls: 0, async scheduleContent(input) { this.calls++; const entry = { id: 'schedule-1', productionId: input.id, publishTime: input.scheduledPublishTime, status: 'scheduled', metadata: { seo: input.seo, video: input.assets.finalVideo, audio: input.assets.audio, embeddedAudioValidation: input.assets.embeddedAudioValidation, approvedArtifact: input.approvedArtifact, privacyStatus: input.privacyStatus, containsSyntheticMedia: input.containsSyntheticMedia, contentType: input.contentType, canonicalWorkflow: input.canonicalWorkflow, finalApprovalEvidence: input.finalApprovalEvidence } }; db.bundle.schedule = entry; return entry; } };
}

function persistedCanonicalEntry(db) {
  const approval = db.bundle.editorData.finalApprovalGate;
  return {
    id: 'schedule-1', productionId: 'prod-1', status: 'scheduled', publishTime: new Date().toISOString(),
    metadata: {
      contentType: 'short', canonicalWorkflow: 'phase3f_short', shortClipId: null,
      seo: db.bundle.seo, video: db.bundle.assets.finalVideo, audio: null,
      embeddedAudioValidation: db.bundle.assets.embeddedAudioValidation,
      approvedArtifact: { path: artifact, sha256, fileSize: bytes.length },
      finalApprovalEvidence: { passed: true, approvedAt: approval.approvedAt, artifact: approval.artifact },
      containsSyntheticMedia: true, privacyStatus: 'private'
    }
  };
}

async function expectCode(promise, code) { await assert.rejects(promise, error => error instanceof ShortsReviewError && error.code === code); }
function request(overrides = {}) { return { confirmed: true, publishTime: future(), privacyStatus: 'private', ...overrides }; }

test('scheduling validates confirmation, time, privacy, approval, and Phase 3F evidence', async () => {
  const db = new MemoryDb(); const service = new ShortsReviewService({ database: db }); const publishing = publisher(db);
  await expectCode(service.schedule('prod-1', request({ confirmed: false }), publishing), 'SCHEDULING_CONFIRMATION_REQUIRED');
  await expectCode(service.schedule('prod-1', { confirmed: true, privacyStatus: 'private' }, publishing), 'INVALID_PUBLISH_TIME');
  await expectCode(service.schedule('prod-1', request({ publishTime: 'bad' }), publishing), 'INVALID_PUBLISH_TIME');
  await expectCode(service.schedule('prod-1', request({ publishTime: new Date(Date.now() - 1000).toISOString() }), publishing), 'INVALID_PUBLISH_TIME');
  await expectCode(service.schedule('prod-1', request({ privacyStatus: 'friends' }), publishing), 'INVALID_PRIVACY_STATE');
  db.bundle.review_status = 'needs_attention'; await expectCode(service.schedule('prod-1', request(), publishing), 'FINAL_APPROVAL_REQUIRED'); db.bundle.review_status = 'approved';
  db.bundle.editorData.finalApprovalGate = null; await expectCode(service.schedule('prod-1', request(), publishing), 'FINAL_APPROVAL_EVIDENCE_INVALID');
});

test('scheduling enforces eligible and consistent provenance', async () => {
  const db = new MemoryDb(); const service = new ShortsReviewService({ database: db }); const publishing = publisher(db);
  db.bundle.provenance.status = 'operator_reviewed'; await expectCode(service.schedule('prod-1', request(), publishing), 'PROVENANCE_NOT_PUBLISHABLE');
  db.bundle.provenance.status = 'verified'; db.bundle.provenance.sources = [{ title: 'Changed', url: 'https://example.com/changed' }]; await expectCode(service.schedule('prod-1', request(), publishing), 'PROVENANCE_INCONSISTENT');
  db.bundle.provenance = { status: 'not_required', sources: [], containsSyntheticMedia: true };
  const scheduled = await service.schedule('prod-1', request(), publishing); assert.equal(scheduled.status, 'scheduled');
});

test('eligible handoff freezes approved metadata, identity, audio and synthetic-media state', async () => {
  const db = new MemoryDb(); const service = new ShortsReviewService({ database: db }); const publishing = publisher(db);
  const input = request({ title: 'Override forbidden', videoPath: '/other.mp4', containsSyntheticMedia: false });
  const scheduled = await service.schedule('prod-1', input, publishing);
  assert.equal(scheduled.metadata.seo.title, 'Approved title'); assert.equal(scheduled.metadata.video.path, artifact);
  assert.deepEqual(scheduled.metadata.approvedArtifact, { path: artifact, sha256, fileSize: bytes.length });
  assert.equal(scheduled.metadata.containsSyntheticMedia, true); assert.equal(scheduled.metadata.contentType, 'short');
  assert.equal(db.bundle.status, 'scheduled'); assert.equal(publishing.calls, 1);
});

test('artifact path, digest, size and file type mismatches are rejected', async t => {
  const mutations = [
    ['path', db => { db.bundle.assets.finalVideo.path = path.join(directory, 'other.mp4'); }, 'APPROVED_ARTIFACT_INVALID'],
    ['approval path', db => { db.bundle.editorData.finalApprovalGate.artifact.path = path.join(directory, 'other.mp4'); }, 'APPROVED_ARTIFACT_INVALID'],
    ['digest', db => { db.bundle.editorData.finalApprovalGate.artifact.sha256 = 'a'.repeat(64); }, 'APPROVED_ARTIFACT_INVALID'],
    ['size', db => { db.bundle.editorData.finalApprovalGate.artifact.fileSize = 1; }, 'APPROVED_ARTIFACT_INVALID'],
    ['missing', async () => fs.rm(artifact), 'ARTIFACT_NOT_FOUND'],
    ['empty', async () => fs.writeFile(artifact, Buffer.alloc(0)), 'ARTIFACT_INVALID'],
    ['directory', async () => { await fs.rm(artifact); await fs.mkdir(artifact); }, 'ARTIFACT_INVALID']
  ];
  for (const [name, mutate, code] of mutations) await t.test(name, async () => {
    await fs.rm(artifact, { recursive: true, force: true }); await fs.writeFile(artifact, bytes);
    const db = new MemoryDb(); await mutate(db); await expectCode(new ShortsReviewService({ database: db }).schedule('prod-1', request(), publisher(db)), code);
  });
});

test('identical scheduling is idempotent and conflicting scheduling is rejected', async () => {
  const db = new MemoryDb(); const service = new ShortsReviewService({ database: db }); const publishing = publisher(db); const input = request();
  const first = await service.schedule('prod-1', input, publishing); const second = await service.schedule('prod-1', input, publishing);
  assert.equal(second.id, first.id); assert.equal(publishing.calls, 1);
  await expectCode(service.schedule('prod-1', { ...input, privacyStatus: 'unlisted' }, publishing), 'SCHEDULE_CONFLICT');
  assert.equal(db.bundle.schedule.metadata.privacyStatus, 'private');
});

test('publishing accepts strict Shorts embedded audio while preserving legacy audio and silence', async () => {
  const agent = new PublishingSchedulingAgent({}, {});
  const validation = chain().production.validation_result;
  const context = { contentType: 'short', video: { path: artifact, validation }, embeddedAudioValidation: { passed: true, audioCodec: 'aac', durationSeconds: 20, sourceArtifactPath: artifact }, approvedArtifact: { path: artifact, sha256, fileSize: bytes.length } };
  assert.equal(await agent.isNarrationReady(null, context), true);
  assert.equal(await agent.isNarrationReady(null, { ...context, embeddedAudioValidation: { ...context.embeddedAudioValidation, sourceArtifactPath: '/other.mp4' } }), false);
  assert.equal(await agent.isNarrationReady(null, { ...context, contentType: 'long_form' }), false);
  const audio = path.join(directory, 'audio.mp3'); await fs.writeFile(audio, 'audio');
  assert.equal(await agent.isNarrationReady({ path: audio }), true);
  assert.equal(await agent.isNarrationReady({ intentionalSilence: true, silenceReason: 'Explicit silent production', silenceConfirmedAt: new Date().toISOString() }), true);
});

test('publishing blocks changed artifacts before upload and synchronizes safe status', async () => {
  const db = new MemoryDb(); const updates = []; db.updateScheduleEntry = async entry => updates.push({ ...entry });
  const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0;
  const entry = persistedCanonicalEntry(db);
  agent.publishQueue = [entry]; agent.uploadToYouTube = async () => { uploads++; return { id: 'youtube' }; };
  await fs.writeFile(artifact, Buffer.alloc(bytes.length, 8));
  await assert.rejects(agent.publishContent('prod-1'), error => error.code === 'ARTIFACT_INTEGRITY_FAILED');
  assert.equal(uploads, 0); assert.equal(updates.at(-1).status, 'failed'); assert.equal(db.bundle.status, 'needs_attention');
});

test('persisted canonical Short fails closed when its production bundle is missing after restart', async () => {
  const db = new MemoryDb(); const entry = persistedCanonicalEntry(db); db.bundle = null; db.getLatestScheduleEntry = async () => entry;
  const updates = []; db.updateScheduleEntry = async value => updates.push({ ...value });
  const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0; agent.uploadToYouTube = async () => { uploads++; };
  await assert.rejects(agent.publishContent('prod-1'), error => error.code === 'PRODUCTION_BUNDLE_REQUIRED');
  assert.equal(uploads, 0); assert.equal(entry.uploadAttempted, undefined); assert.notEqual(entry.status, 'published');
  assert.equal(updates.at(-1).status, 'failed'); assert.deepEqual(db.statuses, ['needs_attention']);
});

test('persisted canonical Short fails closed when production bundle lookup rejects', async () => {
  const db = new MemoryDb(); const entry = persistedCanonicalEntry(db); db.bundle.schedule = entry;
  db.getProductionBundle = async () => { throw new Error('database unavailable'); };
  const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0; agent.uploadToYouTube = async () => { uploads++; };
  await assert.rejects(agent.publishContent('prod-1'), error => error.code === 'PRODUCTION_BUNDLE_UNAVAILABLE');
  assert.equal(uploads, 0); assert.equal(entry.uploadAttempted, undefined); assert.equal(entry.status, 'failed');
  assert.deepEqual(db.statuses, ['needs_attention']);
});

test('queue rechecks Phase 3F approval evidence and provenance before upload', async t => {
  const cases = [
    ['review is not approved', db => { db.bundle.review_status = 'rejected'; }, 'APPROVAL_BLOCKED'],
    ['approval evidence is missing', db => { db.bundle.editorData.finalApprovalGate = null; }, 'APPROVAL_BLOCKED'],
    ['persisted approval evidence is invalid', (_db, entry) => { entry.metadata.finalApprovalEvidence.artifact.sha256 = 'a'.repeat(64); }, 'APPROVAL_BLOCKED'],
    ['provenance is ineligible', db => { db.bundle.provenance = { status: 'operator_reviewed' }; }, 'PROVENANCE_BLOCKED']
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const db = new MemoryDb(); const entry = persistedCanonicalEntry(db); db.bundle.schedule = entry; mutate(db, entry);
    const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0; agent.uploadToYouTube = async () => { uploads++; };
    await assert.rejects(agent.publishContent('prod-1'), error => error.code === code);
    assert.equal(uploads, 0); assert.equal(entry.uploadAttempted, undefined); assert.equal(entry.status, 'failed');
  });
});

test('valid persisted canonical Short still follows the successful mocked publishing path', async () => {
  const db = new MemoryDb(); const entry = persistedCanonicalEntry(db); db.bundle.schedule = entry;
  const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0;
  agent.uploadToYouTube = async value => { uploads++; assert.equal(value.uploadAttempted, undefined); return { id: 'youtube-id' }; };
  const result = await agent.publishContent('prod-1');
  assert.equal(uploads, 1); assert.equal(result.status, 'published'); assert.equal(result.youtubeId, 'youtube-id');
});

test('legacy non-Short publishing remains independent of canonical Phase 3F bundles', async () => {
  const audio = path.join(directory, 'legacy.mp3'); await fs.writeFile(audio, 'audio');
  const db = new MemoryDb(); db.bundle = null; db.updateScheduleEntry = async () => {};
  const entry = { id: 'legacy', productionId: 'legacy-prod', status: 'scheduled', publishTime: new Date().toISOString(), metadata: { contentType: 'long_form', video: { path: artifact }, audio: { path: audio } } };
  db.getLatestScheduleEntry = async () => entry; const agent = new PublishingSchedulingAgent(db, {}); let uploads = 0;
  agent.uploadToYouTube = async () => { uploads++; return { id: 'legacy-youtube-id' }; };
  const result = await agent.publishContent('legacy-prod');
  assert.equal(uploads, 1); assert.equal(result.status, 'published');
});

test('synthetic-media state reaches mocked YouTube metadata and lifecycle statuses remain accurate', async () => {
  const statuses = []; const db = { updateScheduleEntry: async () => {}, updateProductionStatus: async (_id, status) => statuses.push(status) };
  const agent = new PublishingSchedulingAgent(db, {}); let requestBody;
  agent.youtube = { videos: { insert: async request => { requestBody = request.requestBody; return { data: { id: 'yt' } }; } }, thumbnails: { set: async () => {} }, captions: { insert: async () => {} } };
  agent.getVideoStream = async () => ({ mocked: true });
  const entry = { id: 's', productionId: 'prod-1', publishTime: new Date().toISOString(), metadata: { seo: { title: 'Title', description: 'Description', tags: ['a', 'b', 'c'] }, video: { path: artifact }, contentType: 'short', containsSyntheticMedia: true } };
  await agent.uploadToYouTube(entry, { publishNow: true }); assert.equal(requestBody.status.containsSyntheticMedia, true); assert.deepEqual(statuses, ['uploaded']);
});

test('scheduling endpoint rejects unauthenticated requests', async t => {
  const previous = process.env.API_KEY; process.env.API_KEY = 'phase4-secret';
  const app = new YouTubeAutomationAgent(); app.app.use(express.json()); app.db = {}; app.operator = {}; app.agents.publishing = {};
  app.setupOperatorAPI(); const server = app.app.listen(0, '127.0.0.1'); t.after(() => { server.close(); if (previous === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous; });
  await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/production/shorts/prod-1/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
  assert.equal(response.status, 401);
});
