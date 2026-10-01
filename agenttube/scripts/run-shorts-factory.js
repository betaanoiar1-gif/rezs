
require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');

const AGENTTUBE_PORT = process.env.REZS_PORT || process.env.PORT || 3456;
const BASE_URL = process.env.REZS_BASE_URL || `http://127.0.0.1:${AGENTTUBE_PORT}`;
const API_KEY = process.env.API_KEY || '';
const TOPIC = process.argv.slice(2).join(' ').trim();

const REQUEST_TIMEOUT_MS = Number(process.env.REZS_REQUEST_TIMEOUT_MS || 120000);
const POLL_INTERVAL_MS = Number(process.env.REZS_POLL_INTERVAL_MS || 5000);
const FACTORY_TIMEOUT_MS = Number(process.env.REZS_FACTORY_TIMEOUT_MS || 15 * 60 * 1000);

if (!TOPIC) {
  console.error('Usage: node scripts/run-shorts-factory.js "<topic>"');
  process.exit(2);
}

function headers() {
  const h = { 'content-type': 'application/json' };
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...headers(),
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let body;

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(
        body?.error?.message ||
        body?.error ||
        `HTTP ${response.status} ${response.statusText}`
      );
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    try {
      await request('/api/dashboard', {}, 3000);
      return;
    } catch {
      await sleep(1000);
    }
  }

  throw new Error(`AgentTube server did not become ready at ${BASE_URL}`);
}

async function ensureServer() {
  try {
    await request('/api/dashboard', {}, 3000);
    console.log(`✓ AgentTube already running: ${BASE_URL}`);
    return null;
  } catch {
    console.log('▶ Starting AgentTube server...');

    const child = spawn(process.execPath, ['index.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', data => {
      process.stdout.write(`[server] ${data}`);
    });

    child.stderr.on('data', data => {
      process.stderr.write(`[server] ${data}`);
    });

    child.on('exit', code => {
      if (code !== null) {
        console.log(`[server] exited with code ${code}`);
      }
    });

    await waitForServer();
    console.log(`✓ AgentTube ready: ${BASE_URL}`);
    return child;
  }
}

function printJob(job, prefix = '') {
  const p = job?.production || job;
  if (!p) return;

  console.log(
    `${prefix}status=${p.status || '-'} ` +
    `stage=${p.stage || '-'} ` +
    `job=${p.job_id || '-'} ` +
    `mpt=${p.mpt_task_id || '-'}`
  );

  if (p.artifact_path) {
    console.log(`  artifact: ${p.artifact_path}`);
  }

  if (p.validation_result) {
    console.log(
      `  validation: ${p.validation_result.passed ? 'PASSED' : 'FAILED'}`
    );
  }

  if (p.last_error) {
    console.log(`  error: ${p.last_error}`);
  }
}

async function main() {
  const startedAt = Date.now();
  let serverProcess = null;

  console.log('');
  console.log('==============================================');
  console.log('        AUTONOMOUS YOUTUBE SHORTS FACTORY');
  console.log('==============================================');
  console.log(`Topic: ${TOPIC}`);
  console.log('');

  try {
    serverProcess = await ensureServer();

    if (Date.now() - startedAt > FACTORY_TIMEOUT_MS) {
      throw new Error('Factory startup timeout');
    }

    console.log('');
    console.log('=== 1/4 AI PLANNING ===');

    const planningResponse = await request('/api/planning/shorts', {
      method: 'POST',
      body: JSON.stringify({ topic: TOPIC })
    }, Math.max(REQUEST_TIMEOUT_MS, 120000));

    const planningJob = planningResponse.job;
    const planningJobId = planningJob?.job_id;

    if (!planningJobId) {
      throw new Error('Planning succeeded but no planning job ID was returned');
    }

    console.log(`✓ Planning job: ${planningJobId}`);
    console.log(`  status=${planningJob.status} stage=${planningJob.stage}`);

    if (planningJob.status !== 'SUCCEEDED') {
      throw new Error(`Planning did not succeed: ${planningJob.status}`);
    }

    console.log('');
    console.log('=== 2/4 PRODUCTION PREPARATION ===');

    const prepResponse = await request(
      `/api/planning/shorts/${encodeURIComponent(planningJobId)}/prepare-production`,
      {
        method: 'POST',
        body: JSON.stringify({})
      },
      Math.max(REQUEST_TIMEOUT_MS, 180000)
    );

    const preparation = prepResponse.preparation;
    const preparationId = preparation?.preparation_id;

    if (!preparationId) {
      throw new Error('Preparation succeeded but no preparation ID was returned');
    }

    console.log(`✓ Preparation: ${preparationId}`);
    console.log(`  status=${preparation.status}`);
    console.log(
      `  duration=${preparation.specification?.duration_seconds || '-'}s`
    );

    if (preparation.status !== 'PRODUCTION_READY') {
      throw new Error(
        `Production preparation is not ready: ${preparation.status}`
      );
    }

    console.log('');
    console.log('=== 3/4 START PRODUCTION ===');

    let productionJob = null;

    try {
      const startResponse = await request(
        `/api/production/shorts/${encodeURIComponent(preparationId)}/start`,
        {
          method: 'POST',
          body: JSON.stringify({})
        },
        REQUEST_TIMEOUT_MS
      );

      productionJob = startResponse.job;
      printJob(productionJob, '✓ start returned: ');

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(
          '⚠ Start request exceeded its HTTP timeout; ' +
          'the server may still be executing the MPT task.'
        );
      } else {
        console.log(
          `⚠ Start request ended: ${error.message}`
        );
      }
    }

    console.log('');
    console.log('=== 4/4 MONITOR PRODUCTION ===');

    const monitorDeadline = Date.now() + FACTORY_TIMEOUT_MS;

    let productionJobId = productionJob?.job_id || null;

    if (!productionJobId) {
      console.log('Waiting for production job to appear...');

      while (Date.now() < monitorDeadline && !productionJobId) {
        await sleep(POLL_INTERVAL_MS);

        try {
          const prep = await request(
            `/api/production-preparations/shorts/${encodeURIComponent(preparationId)}`,
            {},
            10000
          );

          productionJobId =
            prep?.preparation?.production_job_id ||
            prep?.preparation?.job_id ||
            null;
        } catch {}
      }
    }

    if (!productionJobId) {
      throw new Error(
        'Could not determine production job ID after production start'
      );
    }

    console.log(`Production job: ${productionJobId}`);

    let lastSignature = '';

    while (Date.now() < monitorDeadline) {
      let result;

      try {
        result = await request(
          `/api/production/shorts/${encodeURIComponent(productionJobId)}`,
          {},
          15000
        );
      } catch (error) {
        console.log(`⚠ Poll error: ${error.message}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const job = result.job;
      const signature = [
        job?.status,
        job?.stage,
        job?.mpt_task_id,
        job?.artifact_path,
        job?.last_error
      ].join('|');

      if (signature !== lastSignature) {
        printJob(job, '• ');
        lastSignature = signature;
      }

      if (job?.status === 'SUCCEEDED') {
        console.log('');
        console.log('==============================================');
        console.log('              FACTORY SUCCEEDED');
        console.log('==============================================');
        console.log(`Production job: ${productionJobId}`);
        console.log(`Status: ${job.status}`);
        console.log(`Stage: ${job.stage}`);
        console.log(`Artifact: ${job.artifact_path || 'not reported'}`);
        console.log('');

        process.exitCode = 0;
        return;
      }

      if (
        ['FAILED', 'CANCELLED', 'TIMEOUT'].includes(job?.status)
      ) {
        throw new Error(
          `Production failed: status=${job.status}, ` +
          `stage=${job.stage}, ` +
          `error=${job.last_error || 'unknown'}`
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Factory timeout after ${Math.round(FACTORY_TIMEOUT_MS / 60000)} minutes`
    );

  } catch (error) {
    console.error('');
    console.error('==============================================');
    console.error('             SHORTS FACTORY FAILED');
    console.error('==============================================');
    console.error(error.message);
    console.error('');

    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      try {
        serverProcess.kill('SIGTERM');
      } catch {}
    }
  }
}

main();
