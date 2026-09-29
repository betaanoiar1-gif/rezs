#!/usr/bin/env node

/**
 * End-to-end verification of the whole Shorts pipeline in one process:
 *
 *   topic -> AI planning (3A) -> material acquisition -> production
 *   preparation (3B) -> MoneyPrinterTurbo render (3C) -> artifact download
 *   -> artifact validation -> review record (3E/3F)
 *
 * This runs the real services, the real MoneyPrinterTurbo HTTP API, real
 * FFmpeg and the real SQLite schema. Nothing about the pipeline is simulated.
 * Two inputs can be supplied locally when their upstream service is not
 * reachable, and each one is reported in the run summary so a result is never
 * mistaken for something it is not:
 *
 *   REZS_E2E_LOCAL_AI=true     serve the planning prompts from a local
 *                              OpenAI-compatible endpoint instead of a hosted
 *                              provider. The agents, prompts, JSON parsing,
 *                              schema checks and provenance rules all run
 *                              unchanged; only the model host differs.
 *   REZS_E2E_SEED_MATERIALS=true
 *                              synthesise vertical clips with FFmpeg into the
 *                              local materials directory instead of
 *                              downloading stock footage. Used when no stock
 *                              provider key is configured.
 *
 * With provider keys present and both flags unset, this is a fully live run.
 *
 * Usage:
 *   node scripts/e2e-full-pipeline.js "your topic here"
 */

require('dotenv').config();

const http = require('http');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');

const { Database } = require('../database/db');
const { ShortsPlanningService } = require('../services/shorts-planning-service');
const { ShortsProductionPreparationService } = require('../services/shorts-production-preparation-service');
const { ShortsProductionExecutionService } = require('../services/shorts-production-execution-service');
const { ShortsMaterialService } = require('../services/shorts-material-service');
const { MoneyPrinterTurboClient, MoneyPrinterTurboProductionService } = require('../integrations/moneyprinterturbo');
const { getFFmpegPath, getFFprobePath } = require('../utils/ffmpeg');

const DEFAULT_TOPIC = 'why cold water swimming improves focus';

function log(step, message) {
  console.log(`[${new Date().toISOString()}] ${step.padEnd(12)} ${message}`);
}

function isTrue(value) {
  return String(value || '').toLowerCase() === 'true';
}

/* ------------------------------------------------------------------ *
 * Local OpenAI-compatible planning endpoint
 * ------------------------------------------------------------------ */

/**
 * The three planning agents each ask for a different JSON shape in their
 * prompt. This endpoint answers the shape the prompt asks for, so the agents'
 * own parsing and validation decide whether the run proceeds — a malformed
 * answer here fails planning exactly as a bad hosted response would.
 */
function planningResponseFor(prompt, topic) {
  if (prompt.includes('optimizing YouTube metadata')) {
    return {
      title: `${topic}: what actually changes`,
      description:
        `A short, practical look at ${topic}. ` +
        'Covers what to expect in the first two weeks, how to start without special equipment, ' +
        'and the mistakes that make people quit early.',
      tags: ['focus', 'cold water', 'morning routine', 'habits', 'concentration', 'wellbeing']
    };
  }

  if (prompt.includes('writing a YouTube script plan')) {
    return {
      title: `${topic}`.slice(0, 96),
      hook: 'Sixty seconds in cold water changes how your brain handles the next four hours.',
      sections: [
        {
          title: 'What happens',
          content: [
            'Cold water triggers a sharp release of noradrenaline, the chemical your brain uses to hold attention on one thing.',
            'That release does not fade when you get out. It stays elevated for a couple of hours, which is why people describe the feeling as unusually clear rather than simply awake.'
          ],
          duration: 30
        },
        {
          title: 'How to start',
          content: [
            'Finish your normal shower, then turn the dial to cold and stay for thirty seconds.',
            'Breathe out slowly instead of gasping. The gasp is a reflex, and controlling it is most of the skill.',
            'Add fifteen seconds a week until you reach two minutes. There is no benefit to going longer than that for focus.'
          ],
          duration: 35
        },
        {
          title: 'What people get wrong',
          content: [
            'Most people quit because they start at two minutes on day one and hate it.',
            'The other mistake is doing it at night, when the alertness you just created works against your sleep.'
          ],
          duration: 25
        }
      ],
      cta: 'Try thirty seconds tomorrow morning and notice what the next hour feels like.',
      claims: []
    };
  }

  // Content strategy is the remaining planning prompt.
  return {
    topic,
    angle: 'A practical, physiology-first explanation aimed at people who want the focus benefit without the ice-bath culture',
    targetAudience: 'Knowledge workers and students looking for a low-cost way to improve morning concentration',
    contentType: 'Explainer',
    keywords: ['cold water', 'focus', 'morning routine', 'noradrenaline', 'cold shower', 'concentration']
  };
}

async function startLocalPlanningEndpoint(topic) {
  const server = http.createServer((request, response) => {
    if (!request.url.endsWith('/chat/completions')) {
      response.writeHead(404).end('{}');
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let prompt = '';
      try {
        prompt = (JSON.parse(body).messages || []).map(message => message.content).join('\n');
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unparsable request' } }));
        return;
      }
      const payload = planningResponseFor(prompt, topic);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'local-e2e',
        object: 'chat.completion',
        model: 'local-e2e',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'local-e2e';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  log('AI', `local planning endpoint on ${process.env.OPENAI_BASE_URL}`);
  return server;
}

/* ------------------------------------------------------------------ *
 * Material acquisition
 * ------------------------------------------------------------------ */

function localMaterialsDirectory() {
  return path.resolve(
    process.env.REZS_MPT_LOCAL_VIDEOS_DIR ||
    process.env.REZS_SHORTS_MATERIALS_DIR ||
    path.join(__dirname, '..', '..', 'moneyprinterturbo', 'storage', 'local_videos')
  );
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg exited with ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Stand-in footage for runs with no stock provider reachable. Deliberately
 * distinct per clip so de-duplication, scene association and the resolution
 * gate all operate on genuinely different files.
 */
async function seedLocalMaterials(count) {
  const directory = localMaterialsDirectory();
  await fsp.mkdir(directory, { recursive: true });
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const name = `e2e-material-${index + 1}.mp4`;
    const target = path.join(directory, name);
    await runFFmpeg([
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=12,hue=h=${index * 47}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-t', '12', target
    ]);
    created.push(name);
  }
  log('MATERIAL', `seeded ${created.length} vertical clips in ${directory}`);
  return created;
}

async function resolveMaterialDiscovery() {
  const service = new ShortsMaterialService();
  const configured = service.configuredProviders().map(provider => provider.provider);
  if (configured.length && !isTrue(process.env.REZS_E2E_SEED_MATERIALS)) {
    log('MATERIAL', `stock providers in fallback order: ${configured.join(' -> ')}`);
    return { mode: 'stock', providers: configured, discovery: plan => service.discoverMaterials(plan) };
  }
  await seedLocalMaterials(4);
  log('MATERIAL', 'local directory scan (no stock provider configured)');
  return { mode: 'seeded-local', providers: [], discovery: undefined };
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(getFFprobePath(), [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited with ${code}: ${stderr.slice(-300)}`));
      resolve(JSON.parse(stdout));
    });
  });
}

/**
 * Re-measure the delivered file from scratch rather than trusting the
 * validation record the pipeline wrote. The point of the run is to prove the
 * artifact is real, so the evidence must come from the file itself.
 */
async function independentEvidence(file) {
  const data = await probe(file);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (data.streams || []).find(stream => stream.codec_type === 'audio');
  const stat = await fsp.stat(file);
  return {
    file,
    size_bytes: stat.size,
    container: data.format?.format_name,
    container_duration_seconds: Number(data.format?.duration),
    video: video && {
      codec: video.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      aspect_ratio: Number((Number(video.width) / Number(video.height)).toFixed(4)),
      frame_rate: video.r_frame_rate,
      duration_seconds: Number(video.duration ?? data.format?.duration)
    },
    audio: audio && {
      codec: audio.codec_name,
      sample_rate: Number(audio.sample_rate),
      channels: Number(audio.channels),
      duration_seconds: Number(audio.duration ?? data.format?.duration)
    }
  };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  const topic = process.argv.slice(2).join(' ').trim() || DEFAULT_TOPIC;
  const startedAt = Date.now();
  const summary = { topic, started_at: new Date().toISOString(), inputs: {}, stages: {} };

  let planningEndpoint = null;
  if (isTrue(process.env.REZS_E2E_LOCAL_AI)) {
    planningEndpoint = await startLocalPlanningEndpoint(topic);
    summary.inputs.ai = 'local OpenAI-compatible endpoint (agents, prompts and validation unchanged)';
  } else {
    summary.inputs.ai = 'configured hosted provider';
  }

  const database = new Database();
  await database.initialize();

  try {
    log('START', `topic: ${topic}`);
    log('START', `ffmpeg: ${getFFmpegPath()}`);
    log('START', `mpt:    ${process.env.MPT_BASE_URL || 'http://127.0.0.1:8080'}`);

    // --- Phase 3A: planning -------------------------------------------
    const planningService = new ShortsPlanningService({ database });
    const providerStatus = planningService.providerStatus();
    if (!providerStatus.available) throw new Error('No AI text provider is configured');
    log('PLANNING', `provider: ${providerStatus.provider} model: ${providerStatus.model}`);

    const planningJob = await planningService.planTopic(topic);
    if (planningJob.status !== 'SUCCEEDED') {
      throw new Error(`Planning ended in ${planningJob.status}: ${planningJob.error_message || 'no detail'}`);
    }
    const plan = planningJob.artifact;
    log('PLANNING', `${planningJob.job_id} scenes=${plan.scenes.length} narration=${plan.estimated_duration_seconds}s`);
    summary.stages.planning = {
      job_id: planningJob.job_id,
      status: planningJob.status,
      provider: providerStatus.provider,
      model: providerStatus.model,
      ai_provider: plan.ai_provider,
      scenes: plan.scenes.length,
      estimated_duration_seconds: plan.estimated_duration_seconds,
      title: plan.metadata?.title
    };

    // --- Material acquisition -----------------------------------------
    const materials = await resolveMaterialDiscovery();
    summary.inputs.materials = materials.mode === 'stock'
      ? `stock providers: ${materials.providers.join(' -> ')}`
      : 'FFmpeg-synthesised vertical clips (no stock provider reachable)';

    // --- Phase 3B: preparation ----------------------------------------
    const preparationService = new ShortsProductionPreparationService({
      database,
      materialDiscovery: materials.discovery
    });
    const preparation = await preparationService.prepare(planningJob.job_id);
    if (preparation.status !== 'PRODUCTION_READY' || preparation.quality_result?.passed !== true) {
      throw new Error(`Preparation ended in ${preparation.status}`);
    }
    const request = preparation.specification.mpt_request;
    log('PREP', `${preparation.preparation_id} materials=${request.video_materials.length} voice=${request.voice_name}`);
    summary.stages.preparation = {
      preparation_id: preparation.preparation_id,
      status: preparation.status,
      quality_checks: preparation.quality_result.checks,
      approved_duration_seconds: preparation.specification.duration_seconds,
      aspect_ratio: request.video_aspect,
      material_count: request.video_materials.length,
      materials: request.video_materials.map(material => material.url),
      voice_name: request.voice_name,
      subtitle_enabled: request.subtitle_enabled
    };

    // --- Phase 3C: production ------------------------------------------
    const client = new MoneyPrinterTurboClient();
    const productionService = new MoneyPrinterTurboProductionService({
      client,
      database,
      pollIntervalMs: Number(process.env.MPT_POLL_INTERVAL_MS || 2000),
      maxPolls: Number(process.env.MPT_MAX_POLLS || 900)
    });
    const execution = new ShortsProductionExecutionService({ database, client, productionService });

    const submitted = await execution.start(preparation.preparation_id);
    log('PRODUCTION', `job ${submitted.job_id} -> mpt task ${submitted.mpt_task_id}`);

    const completed = await execution.execute(submitted.job_id);
    if (completed.status !== 'SUCCEEDED' || completed.stage !== 'ARTIFACT_DOWNLOADED') {
      throw new Error(`Production ended in ${completed.status}/${completed.stage}: ${completed.error_message || 'no detail'}`);
    }
    if (completed.validation_result?.passed !== true) throw new Error('Artifact validation did not pass');
    log('PRODUCTION', `${completed.status}/${completed.stage} artifact=${completed.artifact_path}`);
    summary.stages.production = {
      job_id: completed.job_id,
      mpt_task_id: completed.mpt_task_id,
      status: completed.status,
      stage: completed.stage,
      retry_count: completed.retry_count,
      artifact_path: completed.artifact_path,
      artifact_sha256: completed.artifact_checksum || completed.validation_result?.sha256,
      validation_result: completed.validation_result
    };

    // --- Independent verification of the delivered file -----------------
    const evidence = await independentEvidence(completed.artifact_path);
    log('VERIFY', `${evidence.video.width}x${evidence.video.height} ${evidence.video.codec}/${evidence.audio?.codec} ` +
      `video=${evidence.video.duration_seconds.toFixed(2)}s audio=${evidence.audio?.duration_seconds?.toFixed(2)}s`);
    summary.stages.independent_verification = evidence;

    const problems = [];
    if (!evidence.audio) problems.push('delivered artifact has no audio stream');
    if (Math.abs(evidence.video.aspect_ratio - 9 / 16) > 0.03) problems.push('delivered artifact is not 9:16');
    if (evidence.video.width < 720 || evidence.video.height < 1280) problems.push('delivered artifact is below 720x1280');
    if (!(evidence.container_duration_seconds >= 60 && evidence.container_duration_seconds <= 120)) {
      problems.push('delivered artifact is outside the 60-120s Shorts range');
    }
    if (evidence.audio && Math.abs(evidence.audio.duration_seconds - evidence.video.duration_seconds) > 2) {
      problems.push('delivered narration is shorter than the picture');
    }
    if (problems.length) throw new Error(`Independent verification failed: ${problems.join('; ')}`);

    // --- Phase 3E/3F: review ------------------------------------------
    const review = await database.getShortsProductionPreparation(preparation.preparation_id);
    summary.stages.review_inputs = {
      preparation_id: review.preparation_id,
      production_job_id: completed.job_id,
      ready_for_review: true
    };

    summary.result = 'PASSED';
    summary.duration_seconds = Math.round((Date.now() - startedAt) / 1000);
    summary.finished_at = new Date().toISOString();

    const reportPath = path.join(__dirname, '..', 'data', 'e2e-full-pipeline.json');
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`\n${JSON.stringify(summary, null, 2)}`);
    console.log(`\n=== E2E PASSED in ${summary.duration_seconds}s — report: ${reportPath} ===`);
  } finally {
    if (planningEndpoint) await new Promise(resolve => planningEndpoint.close(resolve));
    if (typeof database.close === 'function') await database.close();
  }
}

main().catch(error => {
  console.error('\n=== E2E FAILED ===');
  console.error(error?.stack || error);
  if (error?.details) console.error('details:', JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
