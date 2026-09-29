const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Logger } = require('../utils/logger');
const { getMediaDuration } = require('../utils/ffmpeg');

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMEOUT']);
const VALID_STATUSES = new Set(['QUEUED', 'SUBMITTED', 'RUNNING', ...TERMINAL]);

class MptError extends Error {
  constructor(message, { code = 'MPT_ERROR', status = null, transient = false, cause = null } = {}) {
    super(message, { cause });
    this.name = 'MptError';
    this.code = code;
    this.status = status;
    this.transient = transient;
  }
}

class MoneyPrinterTurboClient {
  constructor(options = {}) {
    // MoneyPrinterTurbo's own default listen_port is 8080 (config.example.toml,
    // app/config/config.py). Keep the adapter default aligned with the service
    // it talks to; non-default deployments (Colab tunnels, containers) set
    // MPT_BASE_URL instead of relying on a divergent built-in default.
    this.baseUrl = String(options.baseUrl || process.env.MPT_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.connectTimeoutMs = positive(options.connectTimeoutMs ?? process.env.MPT_CONNECT_TIMEOUT_MS, 5000);
    this.readTimeoutMs = positive(options.readTimeoutMs ?? process.env.MPT_READ_TIMEOUT_MS, 30000);
    this.maxRetries = nonnegative(options.maxRetries ?? process.env.MPT_MAX_RETRIES, 2);
    this.retryDelayMs = nonnegative(options.retryDelayMs ?? process.env.MPT_RETRY_DELAY_MS, 250);
    this.artifactDir = path.resolve(options.artifactDir || process.env.MPT_ARTIFACT_DIR || path.join(__dirname, '..', 'data', 'mpt-artifacts'));
    this.apiKey = options.apiKey || process.env.MPT_API_KEY || '';
    this.fetch = options.fetch || globalThis.fetch;
    this.logger = options.logger || new Logger('MoneyPrinterTurbo');
    if (typeof this.fetch !== 'function') throw new MptError('A fetch implementation is required', { code: 'CONFIG_ERROR' });
  }

  async health() {
    const response = await this._request('/ping');
    return response === 'pong' || response === '"pong"' || response?.data === 'pong';
  }

  async create_video(specification) {
    if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
      throw new MptError('Video specification must be an object', { code: 'INVALID_REQUEST' });
    }
    const response = await this._request('/api/v1/videos', { method: 'POST', body: specification });
    const taskId = response?.data?.task_id;
    if (!taskId) throw new MptError('MPT response did not contain a task_id', { code: 'INVALID_RESPONSE' });
    return { task_id: taskId, native: response };
  }

  async get_task_status(taskId) {
    requireTaskId(taskId);
    const response = await this._request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    const task = response?.data;
    if (!task || typeof task.state !== 'number') throw new MptError('MPT returned an invalid task response', { code: 'INVALID_RESPONSE' });
    return { ...task, lifecycle_status: mapMptState(task) };
  }

  async create_audio(specification) {
    if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
      throw new MptError('Audio specification must be an object', { code: 'INVALID_REQUEST' });
    }
    const response = await this._request('/api/v1/audio', { method: 'POST', body: specification });
    const taskId = response?.data?.task_id;
    if (!taskId) throw new MptError('MPT audio response did not contain a task_id', { code: 'INVALID_RESPONSE' });
    return { task_id: taskId, native: response };
  }

  async cancel_task(taskId) {
    requireTaskId(taskId);
    await this._request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    return { task_id: taskId, status: 'CANCELLED' };
  }

  async calibrate_voice_rate({
    video_script,
    voice_name,
    target_duration,
    initial_rate = 0.82,
    tolerance_seconds = 0.5,
    max_iterations = 3,
    min_rate = 0.5,
    max_rate = 2.0,
    video_language = 'en',
  } = {}) {
    if (typeof video_script !== 'string' || !video_script.trim()) {
      throw new MptError('Calibration video_script is required', { code: 'INVALID_REQUEST' });
    }

    const target = Number(target_duration);
    if (!Number.isFinite(target) || target <= 0) {
      throw new MptError('Calibration target_duration must be positive', { code: 'INVALID_REQUEST' });
    }

    let rate = Number(initial_rate);
    if (!Number.isFinite(rate) || rate <= 0) rate = 0.82;

    const tolerance = Number.isFinite(Number(tolerance_seconds))
      ? Math.max(0.05, Number(tolerance_seconds))
      : 0.5;

    const iterations = Math.max(1, Math.min(5, Math.floor(Number(max_iterations) || 3)));
    const lower = Math.max(0.1, Number(min_rate) || 0.5);
    const upper = Math.max(lower, Number(max_rate) || 2.0);

    rate = Math.min(upper, Math.max(lower, rate));

    let best = null;

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const result = await this.create_audio({
        video_script,
        video_language,
        voice_name,
        voice_volume: 1.0,
        voice_rate: Number(rate.toFixed(4)),
        bgm_type: 'none',
        bgm_file: '',
        bgm_volume: 0.0,
        video_source: 'local',
      });

      const taskId = result.task_id;
      let audioReference = null;

      for (let poll = 0; poll < 60; poll += 1) {
        const task = await this.get_task_status(taskId);
        audioReference = task?.audio_file || null;

        if (audioReference) break;

        if (task?.lifecycle_status === 'FAILED' || task?.lifecycle_status === 'CANCELLED') {
          throw new MptError(
            task.error || `MPT audio calibration task ${taskId} failed`,
            { code: 'MPT_AUDIO_FAILED' }
          );
        }

        await sleep(1000);
      }

      if (!audioReference) {
        throw new MptError(
          `MPT audio calibration task ${taskId} did not produce audio_file`,
          { code: 'MPT_AUDIO_TIMEOUT', transient: true }
        );
      }

      const taskDir = path.resolve(
        process.env.MPT_STORAGE_DIR || path.resolve(__dirname, '..', '..', 'moneyprinterturbo', 'storage', 'tasks'),
        taskId
      );

      const audioPath = path.join(taskDir, 'audio.mp3');

      // Measure with the same FFmpeg/FFprobe resolution the rest of the
      // project uses (FFMPEG_PATH / FFPROBE_PATH, bundled binary, then PATH).
      // Calling a bare "ffprobe" ignored those settings and failed on any host
      // where FFmpeg is installed somewhere other than the system PATH.
      let actualDuration = 0;
      let lastMeasurementError = null;
      for (let check = 0; check < 20; check += 1) {
        try {
          const stat = await fsp.stat(audioPath);
          if (stat.isFile() && stat.size > 0) {
            const duration = await getMediaDuration(audioPath);
            if (Number.isFinite(duration) && duration > 0) {
              actualDuration = duration;
              break;
            }
          }
        } catch (error) {
          // ENOENT simply means MPT has not finished writing the file yet.
          if (error.code !== 'ENOENT') lastMeasurementError = error;
        }
        await sleep(250);
      }

      if (!(actualDuration > 0)) {
        throw new MptError(
          `Unable to measure calibrated MPT audio task ${taskId} at ${audioPath}. ` +
          'Voice calibration reads MoneyPrinterTurbo\'s task storage directly, so it ' +
          'requires MPT_STORAGE_DIR to point at a locally readable storage/tasks ' +
          'directory. Set MPT_VOICE_RATE to skip calibration when MPT is remote.' +
          (lastMeasurementError ? ` Last error: ${lastMeasurementError.message}` : ''),
          { code: 'MPT_AUDIO_DURATION_UNAVAILABLE' }
        );
      }

      const errorSeconds = actualDuration - target;
      const absoluteError = Math.abs(errorSeconds);

      const sample = {
        iteration,
        rate: Number(rate.toFixed(4)),
        duration: Number(actualDuration.toFixed(3)),
        target_duration: Number(target.toFixed(3)),
        error_seconds: Number(errorSeconds.toFixed(3)),
      };

      if (!best || Math.abs(sample.error_seconds) < Math.abs(best.error_seconds)) {
        best = sample;
      }

      this.logger.info(
        `MPT voice calibration ${iteration}/${iterations}: ` +
        `rate=${sample.rate}, duration=${sample.duration}s, ` +
        `target=${sample.target_duration}s, error=${sample.error_seconds}s`
      );

      if (absoluteError <= tolerance) break;

      const corrected = rate * (actualDuration / target);
      rate = Math.min(upper, Math.max(lower, corrected));
    }

    if (!best) {
      throw new MptError('Voice calibration produced no measurement', {
        code: 'MPT_CALIBRATION_FAILED',
      });
    }

    return {
      voice_rate: best.rate,
      actual_duration: best.duration,
      target_duration: best.target_duration,
      error_seconds: best.error_seconds,
      iterations: best.iteration,
      within_tolerance: Math.abs(best.error_seconds) <= tolerance,
    };
  }

  async download_artifact(artifactReference, destination) {
    if (typeof artifactReference !== 'string' || !artifactReference.trim()) {
      throw new MptError('Artifact reference is required', { code: 'INVALID_ARTIFACT' });
    }
    const target = await this._secureDestination(destination);
    const url = this._artifactUrl(artifactReference);
    const response = await this._request(url, { raw: true });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.part`;
    try {
      const written = await this._withReadTimeout(
        this._streamToFile(response, temporary),
        'MPT artifact read timed out'
      );
      if (!written) throw new MptError('Downloaded artifact is empty', { code: 'EMPTY_ARTIFACT' });
      await fsp.rename(temporary, target);
      const stat = await fsp.stat(target);
      if (!stat.isFile() || stat.size < 1) throw new MptError('Downloaded artifact is invalid', { code: 'EMPTY_ARTIFACT' });
      return { path: target, size: stat.size };
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {
        this.logger.warn('Could not remove the temporary MPT artifact file');
      });
    }
  }

  /**
   * Stream the response body to a temporary file.
   *
   * A rendered Short is tens of megabytes and the previous implementation
   * buffered the whole body with arrayBuffer() before writing, which held two
   * copies in memory at once. Streaming keeps peak memory flat regardless of
   * artifact size; the caller still renames atomically, so a partial download
   * is never visible at the final path.
   */
  async _streamToFile(response, temporary) {
    const handle = await fsp.open(temporary, 'wx');
    let written = 0;
    try {
      if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of response.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buffer.length) {
            await handle.write(buffer);
            written += buffer.length;
          }
        }
      } else {
        // Test doubles and runtimes without an async-iterable body.
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length) {
          await handle.write(buffer);
          written = buffer.length;
        }
      }
    } finally {
      await handle.close();
    }
    return written;
  }

  async _secureDestination(destination) {
    if (typeof destination !== 'string' || !destination.trim() || path.isAbsolute(destination)) {
      throw new MptError('Artifact destination must be a relative path', { code: 'UNSAFE_ARTIFACT_PATH' });
    }
    const root = this.artifactDir;
    const target = path.resolve(root, destination);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new MptError('Artifact destination escapes the configured directory', { code: 'UNSAFE_ARTIFACT_PATH' });
    }
    await fsp.mkdir(root, { recursive: true });
    const rootReal = await fsp.realpath(root);
    let cursor = path.dirname(target);
    while (cursor.startsWith(root) && cursor !== path.dirname(root)) {
      try {
        const stat = await fsp.lstat(cursor);
        if (stat.isSymbolicLink()) throw new MptError('Symlinked artifact destination is forbidden', { code: 'UNSAFE_ARTIFACT_PATH' });
        const real = await fsp.realpath(cursor);
        if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) throw new MptError('Unsafe artifact destination', { code: 'UNSAFE_ARTIFACT_PATH' });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (cursor === root) break;
      cursor = path.dirname(cursor);
    }
    try {
      if ((await fsp.lstat(target)).isSymbolicLink()) throw new MptError('Symlinked artifact destination is forbidden', { code: 'UNSAFE_ARTIFACT_PATH' });
      throw new MptError('Artifact destination already exists', { code: 'ARTIFACT_EXISTS' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return target;
  }

  _artifactUrl(reference) {
    if (/^https?:\/\//i.test(reference)) {
      const remote = new URL(reference);
      const base = new URL(this.baseUrl);
      if (remote.origin !== base.origin) throw new MptError('Cross-origin artifact URL is forbidden', { code: 'UNSAFE_ARTIFACT_URL' });
      return remote.toString();
    }
    const normalized = reference.startsWith('/') ? reference : `/${reference}`;
    return normalized.startsWith('/tasks/') ? `/api/v1/download${normalized}` : normalized;
  }

  async _request(resource, options = {}) {
    const url = /^https?:\/\//i.test(resource) ? resource : `${this.baseUrl}${resource}`;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this._fetchOnce(url, options);
        if (!response.ok) {
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          const code = response.status === 404 && /\/api\/v1\/tasks\//.test(url)
            ? 'MPT_TASK_NOT_FOUND'
            : 'HTTP_ERROR';
          throw new MptError(`MPT request failed with HTTP ${response.status}`, { code, status: response.status, transient });
        }
        if (options.raw) return response;
        const text = await this._readText(response);
        try { return JSON.parse(text); } catch { return text; }
      } catch (error) {
        lastError = normalizeError(error);
        if (!lastError.transient || attempt === this.maxRetries) throw lastError;
        this.logger.warn(`Transient MPT request failure; retry ${attempt + 1}/${this.maxRetries}`);
        if (this.retryDelayMs) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  async _fetchOnce(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    const headers = { Accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetch(url, {
        method: options.method || 'GET', headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new MptError(timedOut ? 'MPT connection timed out' : 'MPT network request failed', {
        code: timedOut ? 'CONNECT_TIMEOUT' : 'NETWORK_ERROR', transient: true, cause: error
      });
    } finally { clearTimeout(timer); }
  }

  async _readText(response) {
    return this._withReadTimeout(response.text(), 'MPT response read timed out');
  }

  async _withReadTimeout(promise, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MptError(message, { code: 'READ_TIMEOUT', transient: true })), this.readTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

class MoneyPrinterTurboProductionService {
  constructor({ client, database, pollIntervalMs = 2000, maxPolls = 300, logger } = {}) {
    this.client = client;
    this.database = database;
    this.pollIntervalMs = nonnegative(pollIntervalMs, 2000);
    this.maxPolls = positive(maxPolls, 300);
    this.logger = logger || new Logger('MPTProduction');
  }

  async submit(jobId, specification) {
    const existing = await this.database.getProductionJob(jobId);
    if (existing) {
      if (existing.mpt_task_id) return existing;
      await this.database.updateProductionJob(jobId, { status: 'SUBMITTED', stage: 'SUBMITTING' });
    } else {
      await this.database.createProductionJob({ job_id: jobId, status: 'SUBMITTED', stage: 'SUBMITTING' });
    }
    try {
      const result = await this.client.create_video(specification);
      return this.database.updateProductionJob(jobId, { mpt_task_id: result.task_id, status: 'RUNNING', stage: 'RENDERING', last_error: null });
    } catch (error) {
      await this.database.updateProductionJob(jobId, { status: 'FAILED', stage: 'SUBMISSION_FAILED', last_error: normalizeError(error).message });
      throw error;
    }
  }

  async poll(jobId) {
    let job = await this.database.getProductionJob(jobId);
    if (!job?.mpt_task_id) throw new MptError('Production job has no MPT task ID', { code: 'INVALID_JOB' });
    for (let count = 0; count < this.maxPolls; count += 1) {
      const task = await this.client.get_task_status(job.mpt_task_id);
      const status = task.lifecycle_status;
      if (status === 'SUCCEEDED') {
        return this.database.updateProductionJob(jobId, { status, stage: 'RENDERED', last_error: null });
      }
      if (status === 'FAILED' || status === 'CANCELLED') {
        return this.database.updateProductionJob(jobId, { status, stage: status, last_error: task.error || task.failed_stage || null });
      }
      await this.database.updateProductionJob(jobId, { status: 'RUNNING', stage: 'RENDERING' });
      if (count + 1 < this.maxPolls && this.pollIntervalMs) await sleep(this.pollIntervalMs);
    }
    return this.database.updateProductionJob(jobId, { status: 'TIMEOUT', stage: 'POLL_TIMEOUT', last_error: 'MPT polling limit reached' });
  }

  async downloadArtifact(jobId, artifactReference, filename = 'final.mp4') {
    const job = await this.database.getProductionJob(jobId);
    if (!job || job.status !== 'SUCCEEDED') throw new MptError('Only successful production jobs can download artifacts', { code: 'INVALID_JOB' });
    const attemptId = String(job.mpt_task_id || `retry-${job.retry_count || 0}`);
    const relativePath = path.join(jobId, attemptId, filename);
    const artifact = await this.client.download_artifact(artifactReference, relativePath);
    return this.database.updateProductionJob(jobId, { stage: 'ARTIFACT_DOWNLOADED', artifact_path: artifact.path, last_error: null });
  }

  async cancel(jobId) {
    const job = await this.database.getProductionJob(jobId);
    if (!job?.mpt_task_id) throw new MptError('Production job has no MPT task ID', { code: 'INVALID_JOB' });
    await this.client.cancel_task(job.mpt_task_id);
    return this.database.updateProductionJob(jobId, { status: 'CANCELLED', stage: 'CANCELLED', last_error: null });
  }
}

function mapMptState(task) {
  if (task.state === 1) return 'SUCCEEDED';
  if (task.state === -1) return 'FAILED';
  if (task.state === 4 || task.state === 0) return 'RUNNING';
  return task.cancelled ? 'CANCELLED' : 'RUNNING';
}
function requireTaskId(value) { if (typeof value !== 'string' || !value.trim()) throw new MptError('task_id is required', { code: 'INVALID_TASK_ID' }); }
function positive(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function nonnegative(value, fallback) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalizeError(error) {
  if (error instanceof MptError) return error;
  return new MptError(error?.message || 'Unknown MPT error', { code: 'NETWORK_ERROR', transient: true, cause: error });
}

module.exports = { MoneyPrinterTurboClient, MoneyPrinterTurboProductionService, MptError, VALID_STATUSES, TERMINAL, mapMptState };
