#!/usr/bin/env node

/**
 * Live external integration validation.
 *
 * Exercises every external dependency through the real production classes and
 * reports, per component, whether it was genuinely LIVE and whether it PASSED.
 * The point is to remove uncertainty, so the report distinguishes:
 *
 *   PASS           exercised live and behaved correctly
 *   FAIL           exercised live and behaved incorrectly
 *   UNREACHABLE    the network refused the connection; reason recorded
 *   NO_CREDENTIAL  no key configured, so nothing was attempted
 *   NOT_TESTED     a prerequisite above it did not hold
 *   SUBSTITUTED    a stand-in was used instead of the real service
 *
 * A component is never quietly substituted. If it could not be reached, the
 * row says so and the run does not claim success.
 *
 * No secret is printed, logged or written to the report. Pixabay carries its
 * key in the query string, so URLs are redacted before they are recorded.
 *
 * Usage:
 *   node scripts/live-integration-validation.js
 */

require('dotenv').config();

const net = require('net');
const tls = require('tls');
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { PROVIDER_CLIENTS, StockMediaError } = require('../integrations/stock-media');
const { ShortsMaterialService } = require('../services/shorts-material-service');
const { ShortsPlanningService } = require('../services/shorts-planning-service');
const { AITextService, PROVIDERS } = require('../utils/ai-text-service');
const { MoneyPrinterTurboClient } = require('../integrations/moneyprinterturbo');
const { getFFmpegPath, getFFprobePath } = require('../utils/ffmpeg');
const { Database } = require('../database/db');

const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNREACHABLE: 'UNREACHABLE',
  NO_CREDENTIAL: 'NO_CREDENTIAL',
  NOT_TESTED: 'NOT_TESTED',
  SUBSTITUTED: 'SUBSTITUTED'
};

/* ------------------------------------------------------------------ *
 * Secret hygiene
 * ------------------------------------------------------------------ */

/**
 * Pixabay authenticates with a `key` query parameter, so a raw URL in a
 * report or a log line would publish the credential. Every string that could
 * carry one is passed through here before it leaves the process.
 */
function redact(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]*/gi, '$1REDACTED')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1REDACTED');
}

/** Describe a credential without revealing it. */
function credentialState(name) {
  const value = process.env[name];
  if (!value || !value.trim()) return { configured: false, detail: `${name} is not set` };
  return { configured: true, detail: `${name} is set (${value.trim().length} characters)` };
}

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

/**
 * Distinguish "the network will not let us out" from "the provider rejected
 * our credential". Conflating the two would turn an environment restriction
 * into a false accusation against the key, so reachability is established
 * before any authenticated call is attempted.
 */
async function probeHost(host, port = 443, timeoutMs = 12000) {
  const started = Date.now();
  const dns = require('dns').promises;

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (error) {
    return { reachable: false, stage: 'dns', reason: `DNS lookup failed (${error.code || error.message})`, ms: Date.now() - started };
  }

  const tcp = await new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'TCP connect timed out' }));
    socket.once('error', error => finish({ ok: false, reason: `TCP connect failed (${error.code || error.message})` }));
  });
  if (!tcp.ok) {
    return { reachable: false, stage: 'tcp', reason: tcp.reason, resolved: addresses.length, ms: Date.now() - started };
  }

  const handshake = await new Promise(resolve => {
    const socket = tls.connect({ host, port, servername: host });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'TLS handshake timed out' }));
    socket.once('error', error => finish({ ok: false, reason: `TLS handshake failed (${error.code || error.message})` }));
  });
  if (!handshake.ok) {
    return { reachable: false, stage: 'tls', reason: handshake.reason, resolved: addresses.length, ms: Date.now() - started };
  }

  return { reachable: true, stage: 'tls', reason: 'TCP and TLS succeeded', resolved: addresses.length, ms: Date.now() - started };
}

/* ------------------------------------------------------------------ *
 * Media helpers
 * ------------------------------------------------------------------ */

async function probeMedia(file) {
  const { stdout } = await execFileAsync(getFFprobePath(), [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file
  ], { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (data.streams || []).find(stream => stream.codec_type === 'audio');
  return { format: data.format, video, audio };
}

/** Full decode: proves the bytes are a real, playable file, not a valid header. */
async function decodes(file) {
  try {
    await execFileAsync(getFFmpegPath(), ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], {
      maxBuffer: 16 * 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Component checks
 * ------------------------------------------------------------------ */

const MEDIA_PROVIDERS = [
  { provider: 'pixabay', host: 'pixabay.com', envKey: 'PIXABAY_API_KEY' },
  { provider: 'pexels', host: 'api.pexels.com', envKey: 'PEXELS_API_KEY' },
  { provider: 'coverr', host: 'api.coverr.co', envKey: 'COVERR_API_KEY' }
];

/**
 * One media provider, end to end: authenticate, search, rank, select,
 * download, stage locally, then verify the staged file really is the video
 * the provider described.
 */
async function checkMediaProvider(spec, stagingDir, term) {
  const row = {
    component: spec.provider,
    live: false,
    status: STATUS.NOT_TESTED,
    checks: {},
    evidence: {},
    notes: []
  };

  const credential = credentialState(spec.envKey);
  row.checks.credential_configured = credential.configured;

  // Probe reachability regardless of the credential. Reporting only "no key"
  // when egress is also blocked would send someone off to add a key that
  // still cannot work; both facts belong in the report.
  const reach = await probeHost(spec.host);
  row.evidence.reachability = { host: spec.host, ...reach };

  if (!credential.configured) {
    row.status = STATUS.NO_CREDENTIAL;
    row.notes.push(credential.detail);
    if (!reach.reachable) {
      row.notes.push(`Also PROVIDER_UNREACHABLE: ${spec.host} — ${reach.reason} (failed at ${reach.stage})`);
    }
    return row;
  }

  if (!reach.reachable) {
    row.status = STATUS.UNREACHABLE;
    row.notes.push(`PROVIDER_UNREACHABLE: ${spec.host} — ${reach.reason} (failed at ${reach.stage})`);
    return row;
  }

  const ClientClass = PROVIDER_CLIENTS[spec.provider];
  const client = new ClientClass({ downloadDirectory: stagingDir });
  row.live = true;

  try {
    // --- authentication + search ---
    const started = Date.now();
    const candidates = await client.search(term, { perPage: 8 });
    row.checks.authentication = true;
    row.checks.search = Array.isArray(candidates);
    row.evidence.search = { term, candidates: candidates.length, ms: Date.now() - started };

    if (!candidates.length) {
      row.status = STATUS.FAIL;
      row.notes.push(`Search for "${term}" returned no usable candidates`);
      return row;
    }

    // --- ranking + selection + download + staging ---
    const asset = await client.downloadBest(term, { perPage: 8 });
    row.checks.ranking = true;
    row.checks.selection = Boolean(asset?.asset_id);
    row.checks.download = Boolean(asset?.local_path);

    const staged = path.resolve(asset.local_path);
    const stat = await fsp.stat(staged);
    row.checks.local_staging = stat.isFile() && stat.size > 0;
    row.checks.filename = path.basename(staged) === `${spec.provider}-${asset.asset_id}.mp4`;

    // --- integrity: the staged bytes must be the described video ---
    const media = await probeMedia(staged);
    const width = Number(media.video?.width);
    const height = Number(media.video?.height);
    const duration = Number(media.format?.duration);
    row.checks.dimensions = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    row.checks.duration = Number.isFinite(duration) && duration > 0;
    row.checks.integrity = await decodes(staged);

    // --- provenance, with the key stripped out of every URL ---
    row.checks.provenance = Boolean(asset.provider && asset.asset_id);
    row.evidence.asset = {
      provider: asset.provider,
      asset_id: String(asset.asset_id),
      source_url: redact(asset.source_url || asset.url || null),
      page_url: redact(asset.page_url || null),
      author: asset.author || null,
      staged_file: path.basename(staged),
      staged_bytes: stat.size,
      reported_duration: asset.duration ?? null,
      measured_duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      measured_resolution: row.checks.dimensions ? `${width}x${height}` : null,
      video_codec: media.video?.codec_name || null,
      audio_codec: media.audio?.codec_name || null
    };

    const failed = Object.entries(row.checks).filter(([, value]) => value === false).map(([name]) => name);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    const code = error instanceof StockMediaError ? error.code : (error.code || error.name);
    row.notes.push(`${code}: ${redact(error.message)}`);
    // An auth rejection is a credential problem, not an outage; say which.
    if (error instanceof StockMediaError && error.details?.status) {
      row.evidence.http_status = error.details.status;
      if ([401, 403].includes(error.details.status)) row.notes.push('Provider rejected the credential (HTTP 401/403)');
      if (error.details.status === 429) row.notes.push('Provider rate limited this key (HTTP 429)');
    }
    return row;
  }
}

/** The AI provider, exercised through the real planning service. */
async function checkAIProvider(database, topic) {
  const row = { component: 'Clean APIs (AI)', live: false, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };

  const credential = credentialState('CLEANAPIS_API_KEY');
  row.checks.credential_configured = credential.configured;

  const configuredBase = process.env.CLEANAPIS_BASE_URL || PROVIDERS.cleanapis.baseURL;
  const host = new URL(configuredBase).hostname;
  // Probed even without a key, so the report can say whether adding one
  // would be sufficient or whether egress is blocked as well.
  const reach = await probeHost(host);
  row.evidence.reachability = { host, ...reach };

  if (!credential.configured) {
    row.status = STATUS.NO_CREDENTIAL;
    row.notes.push(credential.detail);
    if (!reach.reachable) {
      row.notes.push(`Also PROVIDER_UNREACHABLE: ${host} — ${reach.reason} (failed at ${reach.stage})`);
    }
    return row;
  }

  if (!reach.reachable) {
    row.status = STATUS.UNREACHABLE;
    row.notes.push(`PROVIDER_UNREACHABLE: ${host} — ${reach.reason} (failed at ${reach.stage})`);
    return row;
  }

  row.live = true;
  try {
    const service = new AITextService();
    row.checks.provider_selected = service.providerName === 'Clean APIs';
    row.checks.model_selected = Boolean(service.model);
    row.evidence.provider = service.providerName;
    row.evidence.model = service.model;
    row.evidence.endpoint = redact(service.baseURL);

    if (!service.model) {
      row.status = STATUS.FAIL;
      row.notes.push('CLEANAPIS_MODEL is required: Clean APIs publishes no model list, so no default can be inferred');
      return row;
    }

    // A direct call first, so an auth or model error is attributed precisely
    // rather than surfacing as a generic planning failure.
    const started = Date.now();
    const raw = await service.generateText('Reply with the single word: ready', { maxTokens: 16, temperature: 0 });
    row.checks.authentication = true;
    row.checks.request = true;
    row.checks.response_non_empty = Boolean(String(raw || '').trim());
    row.evidence.direct_call_ms = Date.now() - started;

    if (!row.checks.response_non_empty) {
      row.status = STATUS.FAIL;
      row.notes.push('Provider returned an empty completion');
      return row;
    }

    // Now the real thing: full planning through the production service.
    const planningStarted = Date.now();
    const planning = new ShortsPlanningService({ database });
    const job = await planning.planTopic(topic);
    row.checks.planning_succeeded = job.status === 'SUCCEEDED';
    row.evidence.planning_ms = Date.now() - planningStarted;
    row.evidence.planning_job_id = job.job_id;

    if (job.status !== 'SUCCEEDED') {
      row.status = STATUS.FAIL;
      row.notes.push(`Planning ended in ${job.status}: ${job.error_code || ''} ${job.error_message || ''}`.trim());
      return row;
    }

    const plan = job.artifact;
    row.checks.parsing = Boolean(plan?.script && plan?.hook);
    row.checks.schema_validation = plan?.validation?.passed === true;
    row.checks.scenes_generated = Array.isArray(plan?.scenes) && plan.scenes.length > 0;
    row.checks.visual_search_terms = Array.isArray(plan?.scenes) &&
      plan.scenes.every(scene => Array.isArray(scene.visual_search_terms) && scene.visual_search_terms.length > 0);
    row.checks.metadata_generated = Boolean(plan?.metadata?.title && plan?.metadata?.description);
    row.checks.provenance = plan?.ai_provider?.provider === 'Clean APIs';

    row.evidence.plan = {
      job_id: job.job_id,
      provider: plan?.ai_provider?.provider,
      model: plan?.ai_provider?.model,
      scenes: plan?.scenes?.length,
      estimated_duration_seconds: plan?.estimated_duration_seconds,
      title: plan?.metadata?.title,
      validation_checks: plan?.validation?.checks
    };

    const failed = Object.entries(row.checks).filter(([, value]) => value === false).map(([name]) => name);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.code || error.name}: ${redact(error.message)}`);
    return row;
  }
}

async function checkMoneyPrinterTurbo() {
  const row = { component: 'MoneyPrinterTurbo', live: false, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };
  const base = process.env.MPT_BASE_URL || 'http://127.0.0.1:8080';
  const url = new URL(base);
  row.evidence.base_url = base;

  const reach = await probeHost(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)), 5000);
  // A local plain-HTTP service has no TLS, so a TLS failure after a good TCP
  // connect still means the service is up.
  const up = reach.reachable || reach.stage === 'tls';
  row.checks.tcp_reachable = up;
  if (!up) {
    row.status = STATUS.UNREACHABLE;
    row.notes.push(`MoneyPrinterTurbo not reachable at ${base} — ${reach.reason}`);
    return row;
  }

  row.live = true;
  try {
    const client = new MoneyPrinterTurboClient();
    const response = await fetch(`${base.replace(/\/$/, '')}/docs`, { signal: AbortSignal.timeout(8000) });
    row.checks.http_responding = response.ok;
    row.evidence.docs_status = response.status;
    row.evidence.client_base_url = client.baseUrl;
    row.checks.client_default_matches = client.baseUrl === base.replace(/\/$/, '');
    row.status = response.ok ? STATUS.PASS : STATUS.FAIL;
    if (!response.ok) row.notes.push(`MoneyPrinterTurbo returned HTTP ${response.status} for /docs`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.name}: ${redact(error.message)}`);
    return row;
  }
}

async function checkFFmpeg(workDir) {
  const row = { component: 'FFmpeg', live: true, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };
  try {
    const { stdout } = await execFileAsync(getFFmpegPath(), ['-version']);
    row.evidence.ffmpeg_version = stdout.split('\n')[0];
    row.evidence.ffmpeg_path = getFFmpegPath();
    row.evidence.ffprobe_path = getFFprobePath();
    row.checks.ffmpeg_present = true;

    // Real encode, not just a version string: h264 + aac is what the pipeline
    // produces and what validation demands.
    const sample = path.join(workDir, 'ffmpeg-selftest.mp4');
    await execFileAsync(getFFmpegPath(), [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', sample
    ]);
    const media = await probeMedia(sample);
    row.checks.h264_encode = media.video?.codec_name === 'h264';
    row.checks.aac_encode = media.audio?.codec_name === 'aac';
    row.checks.decode = await decodes(sample);
    row.evidence.selftest = {
      video_codec: media.video?.codec_name,
      audio_codec: media.audio?.codec_name,
      resolution: `${media.video?.width}x${media.video?.height}`,
      duration: Number(Number(media.format?.duration).toFixed(3))
    };
    const failed = Object.entries(row.checks).filter(([, v]) => v === false).map(([n]) => n);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.code || error.name}: ${redact(error.message)}`);
    return row;
  }
}

async function checkEspeak(workDir) {
  const row = { component: 'eSpeak NG', live: true, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };
  const python = path.resolve(__dirname, '..', '..', 'moneyprinterturbo', '.venv', 'bin', 'python');
  const mptRoot = path.resolve(__dirname, '..', '..', 'moneyprinterturbo');
  const output = path.join(workDir, 'espeak-selftest.wav');

  try {
    await fsp.access(python);
  } catch {
    row.status = STATUS.NOT_TESTED;
    row.notes.push('MoneyPrinterTurbo virtualenv not present; eSpeak runs inside it');
    return row;
  }

  try {
    // Exercise the real REZS TTS path in voice.py, not the library directly.
    const script = [
      'import sys',
      'sys.path.insert(0, ".")',
      'from app.services import voice',
      `sm = voice.local_espeak_tts("Validation of the offline speech path.", "en-us", ${JSON.stringify(output)}, 1.0, 1.0)`,
      'print("SUBMAKER_OK" if sm else "SUBMAKER_NONE")'
    ].join('\n');
    const { stdout } = await execFileAsync(python, ['-c', script], { cwd: mptRoot, maxBuffer: 8 * 1024 * 1024 });
    row.checks.synthesis_returned_submaker = stdout.includes('SUBMAKER_OK');

    const media = await probeMedia(output);
    const duration = Number(media.format?.duration);
    row.checks.audio_file_created = Number.isFinite(duration) && duration > 0;
    row.checks.audio_stream_present = Boolean(media.audio);
    row.evidence.selftest = {
      duration_seconds: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      codec: media.audio?.codec_name || null,
      sample_rate: media.audio?.sample_rate ? Number(media.audio.sample_rate) : null
    };
    const failed = Object.entries(row.checks).filter(([, v]) => v === false).map(([n]) => n);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.code || error.name}: ${redact(error.message)}`);
    return row;
  }
}

async function checkSQLite(workDir) {
  const row = { component: 'SQLite', live: true, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };
  const database = new Database();
  // A fresh file per run: reusing one would make the second run collide with
  // the first run's rows and report the constraint working as a failure.
  database.dbPath = path.join(workDir, `live-validation-${Date.now()}-${process.pid}.db`);
  try {
    await database.initialize();
    row.checks.initialize = true;

    await database.createProductionJob({
      job_id: 'short_prod_livecheck', preparation_id: 'short_prep_livecheck',
      status: 'QUEUED', stage: 'QUEUED'
    });
    const created = await database.getProductionJob('short_prod_livecheck');
    row.checks.write_read = created?.job_id === 'short_prod_livecheck';

    // The UNIQUE constraint is what stops a double submit creating two jobs.
    let constraintHeld = false;
    try {
      await database.createProductionJob({
        job_id: 'short_prod_livecheck_dup', preparation_id: 'short_prep_livecheck',
        status: 'QUEUED', stage: 'QUEUED'
      });
    } catch {
      constraintHeld = true;
    }
    row.checks.unique_constraint_enforced = constraintHeld;

    await database.updateProductionJob('short_prod_livecheck', { status: 'RUNNING', stage: 'POLLING' });
    const updated = await database.getProductionJob('short_prod_livecheck');
    row.checks.update = updated?.status === 'RUNNING';
    row.evidence.db_path = path.basename(database.dbPath);

    const failed = Object.entries(row.checks).filter(([, v]) => v === false).map(([n]) => n);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.code || error.name}: ${redact(error.message)}`);
    return row;
  } finally {
    if (typeof database.close === 'function') await database.close().catch(() => {});
    await fsp.rm(database.dbPath, { force: true }).catch(() => {});
  }
}

/**
 * Live provider fallback, using whichever providers actually answered.
 * Unit tests already cover the ordering logic with doubles; this confirms the
 * same behaviour against the real APIs.
 */
async function checkLiveFallback(liveProviders, stagingDir) {
  const row = { component: 'Provider fallback', live: false, status: STATUS.NOT_TESTED, checks: {}, evidence: {}, notes: [] };
  if (!liveProviders.length) {
    row.notes.push('No media provider was live, so live fallback ordering could not be exercised');
    row.notes.push('Ordering, recoverable-error classification and CONFIG_ERROR abort are covered offline by test/shorts-material-service.test.js and test/fault-injection.test.js');
    return row;
  }

  row.live = true;
  try {
    const service = new ShortsMaterialService({ downloadDirectory: stagingDir });
    const configured = service.configuredProviders().map(provider => provider.provider);
    row.evidence.configured_order = configured;
    row.checks.order_resolved = configured.length > 0;

    // A term no stock library can satisfy must exhaust every provider and then
    // report NO_VIDEO_RESULTS with the terms it tried, not hang or throw raw.
    const nonsense = 'zzqqxx nonexistent stock subject zzqqxx';
    try {
      await service.discoverMaterials({
        job_id: 'live_fallback_probe',
        scenes: [{ scene_id: 1, visual_search_terms: [nonsense] }]
      });
      row.checks.exhaustion_reports_clearly = false;
      row.notes.push('A deliberately unsatisfiable term unexpectedly produced material');
    } catch (error) {
      row.checks.exhaustion_reports_clearly = error.code === 'NO_VIDEO_RESULTS';
      row.evidence.exhaustion = {
        code: error.code,
        terms_tried: error.details?.terms?.length ?? null,
        attempts: error.details?.attempts?.length ?? null
      };
      if (error.code !== 'NO_VIDEO_RESULTS') row.notes.push(`Expected NO_VIDEO_RESULTS, got ${error.code}`);
    }

    const failed = Object.entries(row.checks).filter(([, v]) => v === false).map(([n]) => n);
    row.status = failed.length ? STATUS.FAIL : STATUS.PASS;
    if (failed.length) row.notes.push(`Failed checks: ${failed.join(', ')}`);
    return row;
  } catch (error) {
    row.status = STATUS.FAIL;
    row.notes.push(`${error.code || error.name}: ${redact(error.message)}`);
    return row;
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function renderTable(rows) {
  const header = '| Component | Live? | Result | Evidence |\n| --- | :---: | --- | --- |';
  const body = rows.map(row => {
    const live = row.live ? 'YES' : 'NO';
    const evidence = (row.notes.length ? row.notes[0] : summariseEvidence(row)).replace(/\|/g, '\\|');
    return `| ${row.component} | ${live} | ${row.status} | ${evidence} |`;
  });
  return [header, ...body].join('\n');
}

function summariseEvidence(row) {
  if (row.evidence.asset) {
    const asset = row.evidence.asset;
    return `asset ${asset.asset_id}, ${asset.measured_resolution}, ${asset.measured_duration}s, ${asset.staged_bytes} bytes, staged as ${asset.staged_file}`;
  }
  if (row.evidence.plan) {
    const plan = row.evidence.plan;
    return `${plan.provider}/${plan.model}, job ${plan.job_id}, ${plan.scenes} scenes, ${plan.estimated_duration_seconds}s`;
  }
  if (row.evidence.selftest) return JSON.stringify(row.evidence.selftest);
  if (row.evidence.docs_status) return `HTTP ${row.evidence.docs_status} at ${row.evidence.base_url}`;
  const passed = Object.entries(row.checks).filter(([, v]) => v === true).map(([n]) => n);
  return passed.length ? `checks passed: ${passed.join(', ')}` : '—';
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  const topic = process.argv.slice(2).join(' ').trim() || 'why cold water swimming improves focus';
  const workDir = path.join(__dirname, '..', 'data', 'live-validation');
  const stagingDir = path.join(workDir, 'staged-assets');
  await fsp.mkdir(stagingDir, { recursive: true });

  const searchTerm = process.env.REZS_LIVE_SEARCH_TERM || 'ocean water';
  const summary = {
    started_at: new Date().toISOString(),
    topic,
    search_term: searchTerm,
    rows: [],
    substitutions: [],
    notes: []
  };

  console.log('=== LIVE EXTERNAL INTEGRATION VALIDATION ===\n');
  console.log('No credential value is printed, logged or written to the report.\n');

  // Credentials first: a missing key must never be reported as an outage.
  console.log('Credential presence (names only):');
  for (const name of ['CLEANAPIS_API_KEY', 'CLEANAPIS_MODEL', 'PIXABAY_API_KEY', 'PEXELS_API_KEY', 'COVERR_API_KEY']) {
    const state = credentialState(name);
    console.log(`  ${name.padEnd(20)} ${state.configured ? 'set' : 'NOT SET'}`);
  }
  console.log();

  const database = new Database();
  database.dbPath = path.join(workDir, 'planning.db');
  await database.initialize();

  try {
    console.log('Checking AI provider…');
    const ai = await checkAIProvider(database, topic);
    summary.rows.push(ai);
    console.log(`  Clean APIs: ${ai.status}\n`);

    const mediaRows = [];
    for (const spec of MEDIA_PROVIDERS) {
      console.log(`Checking ${spec.provider}…`);
      const row = await checkMediaProvider(spec, stagingDir, searchTerm);
      mediaRows.push(row);
      summary.rows.push(row);
      console.log(`  ${spec.provider}: ${row.status}\n`);
    }

    console.log('Checking live provider fallback…');
    const liveProviders = mediaRows.filter(row => row.status === STATUS.PASS).map(row => row.component);
    const fallback = await checkLiveFallback(liveProviders, stagingDir);
    summary.rows.push(fallback);
    console.log(`  fallback: ${fallback.status}\n`);

    console.log('Checking MoneyPrinterTurbo…');
    const mpt = await checkMoneyPrinterTurbo();
    summary.rows.push(mpt);
    console.log(`  MoneyPrinterTurbo: ${mpt.status}\n`);

    console.log('Checking FFmpeg…');
    const ffmpeg = await checkFFmpeg(workDir);
    summary.rows.push(ffmpeg);
    console.log(`  FFmpeg: ${ffmpeg.status}\n`);

    console.log('Checking eSpeak NG…');
    const espeak = await checkEspeak(workDir);
    summary.rows.push(espeak);
    console.log(`  eSpeak NG: ${espeak.status}\n`);

    console.log('Checking SQLite…');
    const sqlite = await checkSQLite(workDir);
    summary.rows.push(sqlite);
    console.log(`  SQLite: ${sqlite.status}\n`);

    // The final MP4 is only meaningful when the live chain above held.
    const finalRow = {
      component: 'Final MP4 (live chain)', live: false, status: STATUS.NOT_TESTED,
      checks: {}, evidence: {}, notes: []
    };
    const blockers = summary.rows
      .filter(row => [STATUS.UNREACHABLE, STATUS.NO_CREDENTIAL, STATUS.FAIL].includes(row.status))
      .map(row => `${row.component}=${row.status}`);
    if (blockers.length) {
      finalRow.notes.push(`Not attempted: the live chain is incomplete (${blockers.join(', ')})`);
      finalRow.notes.push('Run scripts/e2e-full-pipeline.js with no substitution flags once every upstream is live');
    } else {
      finalRow.notes.push('All upstreams live; run scripts/e2e-full-pipeline.js with no substitution flags');
    }
    summary.rows.push(finalRow);

    summary.finished_at = new Date().toISOString();
    summary.totals = summary.rows.reduce((totals, row) => {
      totals[row.status] = (totals[row.status] || 0) + 1;
      return totals;
    }, {});

    const reportPath = path.join(__dirname, '..', 'data', 'live-validation.json');
    await fsp.writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);

    console.log('\n=== RESULT ===\n');
    console.log(renderTable(summary.rows));
    console.log(`\nTotals: ${JSON.stringify(summary.totals)}`);
    console.log(`Report: ${reportPath}`);

    const passed = summary.rows.every(row => row.status === STATUS.PASS);
    console.log(`\n${passed ? '=== ALL COMPONENTS LIVE AND PASSING ===' : '=== VALIDATION INCOMPLETE — see the table above ==='}`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    if (typeof database.close === 'function') await database.close().catch(() => {});
  }
}

// Exported for test/live-validation-redaction.test.js. Secret redaction is a
// security property, so it is tested rather than assumed.
module.exports = { redact, credentialState, probeHost, STATUS };

if (require.main === module) {
  main().catch(error => {
    console.error('\n=== LIVE VALIDATION HARNESS ERROR ===');
    console.error(redact(error?.stack || String(error)));
    process.exitCode = 1;
  });
}
