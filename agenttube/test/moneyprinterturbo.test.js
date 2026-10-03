const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const {
  MoneyPrinterTurboClient,
  MoneyPrinterTurboProductionService,
  MptError
} = require('../integrations/moneyprinterturbo');
const { Database } = require('../database/db');

function response(status, body, binary = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => {
      const value = Buffer.from(binary ? body : JSON.stringify(body));
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
  };
}
function silentLogger() { return { warn() {}, info() {}, error() {} }; }
function clientWith(fetch, options = {}) {
  return new MoneyPrinterTurboClient({ fetch, maxRetries: 0, retryDelayMs: 0, logger: silentLogger(), ...options });
}

class MemoryJobs {
  constructor() { this.jobs = new Map(); }
  async createProductionJob(job) { this.jobs.set(job.job_id, { retry_count: 0, ...job }); return this.getProductionJob(job.job_id); }
  async getProductionJob(id) { return this.jobs.get(id) || null; }
  async updateProductionJob(id, changes) { const job = { ...this.jobs.get(id), ...changes }; this.jobs.set(id, job); return job; }
}

test('production jobs persist their durable lifecycle fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mpt-db-'));
  const database = new Database();
  database.dbPath = path.join(directory, 'jobs.db');
  await database.initialize();
  const created = await database.createProductionJob({ job_id: 'job-1', status: 'SUBMITTED', stage: 'SUBMITTING' });
  assert.equal(created.retry_count, 0);
  const updated = await database.updateProductionJob('job-1', {
    mpt_task_id: 'task-1', status: 'RUNNING', stage: 'RENDERING', retry_count: 1,
    last_error: 'temporary', artifact_path: 'job-1/final.mp4'
  });
  assert.equal(updated.mpt_task_id, 'task-1');
  assert.equal(updated.artifact_path, 'job-1/final.mp4');
  assert.ok(updated.created_at && updated.updated_at);
  await database.close();
  await fs.rm(directory, { recursive: true });
});

test('health reports success and structured permanent failure', async () => {
  assert.equal(await clientWith(async () => response(200, 'pong')).health(), true);
  await assert.rejects(clientWith(async () => response(401, {})).health(), error => error instanceof MptError && error.status === 401 && !error.transient);
});

test('video submission uses the verified MPT endpoint and returns task ID', async () => {
  let request;
  const client = clientWith(async (url, options) => { request = { url, options }; return response(200, { data: { task_id: 'task-1' } }); });
  const result = await client.create_video({ video_subject: 'Subject' });
  assert.equal(result.task_id, 'task-1');
  assert.equal(request.url, 'http://127.0.0.1:8090/api/v1/videos');
  assert.equal(JSON.parse(request.options.body).video_subject, 'Subject');
});

test('task status maps successful and failed MPT states', async () => {
  const succeeded = await clientWith(async () => response(200, { data: { task_id: 'a', state: 1, videos: ['/tasks/a/final.mp4'] } })).get_task_status('a');
  const failed = await clientWith(async () => response(200, { data: { task_id: 'b', state: -1, error: 'render failed' } })).get_task_status('b');
  assert.equal(succeeded.lifecycle_status, 'SUCCEEDED');
  assert.equal(failed.lifecycle_status, 'FAILED');
});

test('bounded polling persists success, failure and timeout', async () => {
  for (const scenario of [
    { states: ['RUNNING', 'SUCCEEDED'], expected: 'SUCCEEDED' },
    { states: ['FAILED'], expected: 'FAILED' },
    { states: ['RUNNING', 'RUNNING'], expected: 'TIMEOUT' }
  ]) {
    const database = new MemoryJobs();
    await database.createProductionJob({ job_id: scenario.expected, mpt_task_id: 'task', status: 'RUNNING', stage: 'RENDERING' });
    const states = [...scenario.states];
    const service = new MoneyPrinterTurboProductionService({
      database, pollIntervalMs: 0, maxPolls: 2,
      client: { get_task_status: async () => ({ lifecycle_status: states.shift() || 'RUNNING', error: scenario.expected === 'FAILED' ? 'bad render' : null }) }
    });
    assert.equal((await service.poll(scenario.expected)).status, scenario.expected);
  }
});

test('cancellation calls MPT and persists CANCELLED', async () => {
  const database = new MemoryJobs();
  await database.createProductionJob({ job_id: 'job', mpt_task_id: 'task', status: 'RUNNING', stage: 'RENDERING' });
  let cancelled;
  const service = new MoneyPrinterTurboProductionService({ database, client: { cancel_task: async id => { cancelled = id; } } });
  assert.equal((await service.cancel('job')).status, 'CANCELLED');
  assert.equal(cancelled, 'task');
});

test('transient responses retry but permanent responses do not', async () => {
  let transientCalls = 0;
  const retrying = clientWith(async () => {
    transientCalls += 1;
    return transientCalls === 1 ? response(503, {}) : response(200, 'pong');
  }, { maxRetries: 1 });
  assert.equal(await retrying.health(), true);
  assert.equal(transientCalls, 2);

  let permanentCalls = 0;
  const permanent = clientWith(async () => { permanentCalls += 1; return response(400, {}); }, { maxRetries: 3 });
  await assert.rejects(permanent.health(), error => error.code === 'HTTP_ERROR' && !error.transient);
  assert.equal(permanentCalls, 1);
});

test('artifact download is non-empty and stays inside configured directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpt-artifacts-'));
  const client = clientWith(async url => {
    assert.equal(url, 'http://127.0.0.1:8090/api/v1/download/tasks/task/final.mp4');
    return response(200, Buffer.from('video'), true);
  }, { artifactDir: root });
  const artifact = await client.download_artifact('/tasks/task/final.mp4', 'job/final.mp4');
  assert.equal(artifact.size, 5);
  assert.equal(await fs.readFile(artifact.path, 'utf8'), 'video');
  await fs.rm(root, { recursive: true });
});

test('artifact path traversal is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpt-artifacts-'));
  await assert.rejects(clientWith(async () => response(200, Buffer.from('x'), true), { artifactDir: root }).download_artifact('/tasks/a.mp4', '../escape.mp4'), error => error.code === 'UNSAFE_ARTIFACT_PATH');
  await fs.rm(root, { recursive: true });
});

test('symlinked and existing artifact destinations are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpt-artifacts-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mpt-outside-'));
  await fs.symlink(outside, path.join(root, 'link'));
  const client = clientWith(async () => response(200, Buffer.from('x'), true), { artifactDir: root });
  await assert.rejects(client.download_artifact('/tasks/a.mp4', 'link/file.mp4'), error => error.code === 'UNSAFE_ARTIFACT_PATH');
  await fs.writeFile(path.join(root, 'existing.mp4'), 'keep');
  await assert.rejects(client.download_artifact('/tasks/a.mp4', 'existing.mp4'), error => error.code === 'ARTIFACT_EXISTS');
  await fs.rm(root, { recursive: true });
  await fs.rm(outside, { recursive: true });
});
