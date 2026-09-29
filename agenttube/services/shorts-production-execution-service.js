const crypto = require('crypto');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { MoneyPrinterTurboClient, MoneyPrinterTurboProductionService } = require('../integrations/moneyprinterturbo');
const { getFFprobePath, runFFmpeg } = require('../utils/ffmpeg');

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMEOUT']);

class ShortsProductionExecutionError extends Error {
  constructor(message, code = 'PRODUCTION_EXECUTION_FAILED', details = null) {
    super(message);
    this.name = 'ShortsProductionExecutionError';
    this.code = code;
    this.details = details;
  }
}

class ShortsProductionExecutionService {
  constructor({ database, client, productionService, artifactValidator = validateVideoArtifact } = {}) {
    this.database = database;
    this.client = client || productionService?.client || new MoneyPrinterTurboClient();
    this.productionService = productionService || new MoneyPrinterTurboProductionService({ client: this.client, database });
    this.artifactValidator = artifactValidator;
  }

  async start(preparationId) {
    if (typeof preparationId !== 'string' || !preparationId.trim()) {
      throw new ShortsProductionExecutionError('A preparation ID is required', 'PREPARATION_NOT_FOUND');
    }
    const preparation = await this.database.getShortsProductionPreparation(preparationId.trim());
    if (!preparation) throw new ShortsProductionExecutionError('Production preparation not found', 'PREPARATION_NOT_FOUND');
    if (preparation.status !== 'PRODUCTION_READY' || preparation.quality_result?.passed !== true || !preparation.specification?.mpt_request) {
      throw new ShortsProductionExecutionError('Production preparation has not passed all mandatory gates', 'PREPARATION_NOT_READY');
    }

    const existing = await this.database.getProductionJobByPreparation(preparation.preparation_id);
    if (existing) {
      if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(existing.status)) {
        if (existing.mpt_task_id) {
          try {
            const task = await this.client.get_task_status(existing.mpt_task_id);
            const lifecycle = task.lifecycle_status;
            if (lifecycle === 'SUCCEEDED' || lifecycle === 'RUNNING') {
              await this.database.updateProductionJob(existing.job_id, {
                status: lifecycle === 'SUCCEEDED' ? 'SUCCEEDED' : 'RUNNING',
                stage: lifecycle === 'SUCCEEDED' ? 'RENDERED' : 'RENDERING',
                last_error: null,
                completed_at: null
              });
              return { ...await this.database.getProductionJob(existing.job_id), reused: true, recovered: true };
            }
          } catch (_error) {
            // Fall through to a fresh retry when the old MPT task is no longer reachable.
          }
        }
        const retryCount = Number(existing.retry_count || 0) + 1;
        await this.database.updateProductionJob(existing.job_id, {
          status: 'QUEUED',
          stage: 'QUEUED',
          mpt_task_id: null,
          artifact_reference: null,
          artifact_path: null,
          validation_result: null,
          last_error: null,
          completed_at: null,
          retry_count: retryCount
        });
        try {
          await this.productionService.submit(existing.job_id, preparation.specification.mpt_request);
          return { ...await this.database.getProductionJob(existing.job_id), reused: true, retried: true };
        } catch (error) {
          const message = sanitizeError(error);
          await this.database.updateProductionJob(existing.job_id, {
            status: 'FAILED', stage: 'SUBMISSION_FAILED', last_error: message, completed_at: new Date().toISOString()
          });
          throw new ShortsProductionExecutionError(message, 'MPT_SUBMISSION_FAILED', { production_job_id: existing.job_id, retry_count: retryCount });
        }
      }
      if (existing.status === 'QUEUED' && !existing.mpt_task_id) {
        try {
          await this.productionService.submit(existing.job_id, preparation.specification.mpt_request);
          return { ...await this.database.getProductionJob(existing.job_id), reused: true };
        } catch (error) {
          const message = sanitizeError(error);
          await this.database.updateProductionJob(existing.job_id, { status: 'FAILED', stage: 'SUBMISSION_FAILED', last_error: message, completed_at: new Date().toISOString() });
          throw new ShortsProductionExecutionError(message, 'MPT_SUBMISSION_FAILED', { production_job_id: existing.job_id });
        }
      }
      return { ...existing, reused: true };
    }

    const jobId = stableProductionJobId(preparation.preparation_id);
    await this.database.createProductionJob({
      job_id: jobId,
      preparation_id: preparation.preparation_id,
      planning_job_id: preparation.planning_job_id,
      status: 'QUEUED',
      stage: 'QUEUED'
    });

    try {
      await this.productionService.submit(jobId, preparation.specification.mpt_request);
      return this.database.getProductionJob(jobId);
    } catch (error) {
      const message = sanitizeError(error);
      await this.database.updateProductionJob(jobId, { status: 'FAILED', stage: 'SUBMISSION_FAILED', last_error: message, completed_at: new Date().toISOString() });
      throw new ShortsProductionExecutionError(message, 'MPT_SUBMISSION_FAILED', { production_job_id: jobId });
    }
  }

  async execute(productionJobId) {
    let job = await this.database.getProductionJob(productionJobId);
    if (!job) throw new ShortsProductionExecutionError('Production job not found', 'PRODUCTION_NOT_FOUND');
    if (job.status === 'SUCCEEDED' && job.stage === 'ARTIFACT_DOWNLOADED') return job;
    if (job.status === 'SUCCEEDED') {
      // MPT may have completed after the polling timeout. Continue from RENDERED
      // so the already-finished task can be downloaded and validated.
    } else if (TERMINAL.has(job.status)) return job;

    if (job.status !== 'SUCCEEDED') try {
      job = await this.productionService.poll(productionJobId);
    } catch (error) {
      const message = sanitizeError(error);
      await this.database.updateProductionJob(productionJobId, { status: 'FAILED', stage: 'MPT_FAILED', last_error: message, completed_at: new Date().toISOString() });
      throw new ShortsProductionExecutionError(message, 'MPT_FAILED', { production_job_id: productionJobId });
    }

    if (job.status === 'TIMEOUT') {
      const message = sanitizeError(job.last_error || 'MoneyPrinterTurbo polling timed out');
      await this.database.updateProductionJob(productionJobId, { last_error: message, completed_at: job.completed_at || new Date().toISOString() });
      throw new ShortsProductionExecutionError(message, 'MPT_TIMEOUT', { production_job_id: productionJobId });
    }
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
      const message = sanitizeError(job.last_error || 'MoneyPrinterTurbo production failed');
      await this.database.updateProductionJob(productionJobId, { last_error: message, completed_at: job.completed_at || new Date().toISOString() });
      throw new ShortsProductionExecutionError(message, 'MPT_FAILED', { production_job_id: productionJobId });
    }
    if (job.status !== 'SUCCEEDED') return job;

    let task;
    let artifactReference;
    try {
      task = await this.client.get_task_status(job.mpt_task_id);
      artifactReference = resolveArtifactReference(task, job.mpt_task_id);
      await this.database.updateProductionJob(productionJobId, { artifact_reference: artifactReference, stage: 'DOWNLOADING_ARTIFACT' });
      job = await this.productionService.downloadArtifact(productionJobId, artifactReference, 'final.mp4');
    } catch (error) {
      const message = sanitizeError(error);
      await this.database.updateProductionJob(productionJobId, { status: 'FAILED', stage: 'ARTIFACT_DOWNLOAD_FAILED', last_error: message, completed_at: new Date().toISOString() });
      throw new ShortsProductionExecutionError(message, 'ARTIFACT_DOWNLOAD_FAILED', { production_job_id: productionJobId });
    }

    const preparation = await this.database.getShortsProductionPreparation(job.preparation_id);
    let validation;
    try {
      validation = await this.artifactValidator(job.artifact_path, preparation.specification.duration_seconds);
      if (!validation?.passed) throw new Error('Downloaded MP4 failed validation');
    } catch (error) {
      const message = sanitizeError(error);
      const result = error.validation || validation || { passed: false, failures: [message] };
      await this.database.updateProductionJob(productionJobId, {
        status: 'FAILED', stage: 'ARTIFACT_VALIDATION_FAILED', last_error: message,
        validation_result: result, completed_at: new Date().toISOString()
      });
      throw new ShortsProductionExecutionError(message, 'ARTIFACT_VALIDATION_FAILED', { production_job_id: productionJobId, validation: result });
    }

    return this.database.updateProductionJob(productionJobId, {
      status: 'SUCCEEDED', stage: 'ARTIFACT_DOWNLOADED', last_error: null,
      validation_result: validation, completed_at: new Date().toISOString()
    });
  }

  async get(productionJobId) {
    return this.database.getProductionJob(productionJobId);
  }

  async getProvenance(productionJobId) {
    const production = await this.database.getProductionJob(productionJobId);
    if (!production) return null;
    const preparation = await this.database.getShortsProductionPreparation(production.preparation_id);
    const planning = preparation ? await this.database.getShortsPlanningJob(preparation.planning_job_id) : null;
    return { planning, preparation, production };
  }
}

async function validateVideoArtifact(filePath, approvedDuration, options = {}) {
  const failures = [];
  let stat;
  try { stat = await fs.lstat(filePath); } catch { failures.push('Artifact does not exist'); }
  if (stat && !stat.isFile()) failures.push('Artifact is not a regular file');
  if (stat && stat.size < 1) failures.push('Artifact is empty');

  let probe;
  if (!failures.length) {
    try { probe = await (options.probe || probeVideoArtifact)(filePath); }
    catch (error) { failures.push(`MP4 probe failed: ${error.message}`); }
  }
  if (probe) {
    if (!probe.container || !/(mp4|mov)/i.test(probe.container)) failures.push('Artifact is not a valid MP4 container');
    if (!probe.video) failures.push('Artifact has no video stream');
    if (!probe.audio) failures.push('Artifact has no audio stream');
    if (probe.video) {
      if (!(probe.video.height > probe.video.width)) failures.push('Video is not vertically oriented');
      if (probe.video.width < 720 || probe.video.height < 1280) failures.push('Video resolution is below the Shorts minimum');
      const ratio = probe.video.width / probe.video.height;
      if (Math.abs(ratio - 9 / 16) > 0.03) failures.push('Video aspect ratio is not 9:16');
      if (!['h264', 'hevc', 'vp9', 'av1'].includes(String(probe.video.codec).toLowerCase())) failures.push('Video codec is not compatible');
    }
    if (probe.audio && !['aac', 'opus', 'mp3'].includes(String(probe.audio.codec).toLowerCase())) failures.push('Audio codec is not compatible');
    const duration = Number(probe.duration);
    if (!Number.isFinite(duration) || duration <= 0) failures.push('Artifact duration is invalid');
    else if (Math.abs(duration - Number(approvedDuration)) > 3) failures.push('Artifact duration differs from the approved duration by more than 3 seconds');
  }
  if (!failures.length) {
    try { await (options.decode || decodeVideoArtifact)(filePath); }
    catch (error) { failures.push(`Artifact is not fully decodable: ${error.message}`); }
  }

  let sha256 = null;
  if (!failures.length) {
    try { sha256 = await hashFileSha256(filePath); }
    catch (error) { failures.push(`Artifact hashing failed: ${error.message}`); }
  }

  const result = {
    passed: failures.length === 0,
    failures,
    file_size: stat?.size || 0,
    sha256,
    duration_seconds: probe?.duration || null,
    resolution: probe?.video ? `${probe.video.width}x${probe.video.height}` : null,
    video_codec: probe?.video?.codec || null,
    audio_codec: probe?.audio?.codec || null,
    container: probe?.container || null,
    duration_tolerance_seconds: 3
  };
  if (failures.length) {
    const error = new Error(failures.join('; '));
    error.validation = result;
    throw error;
  }
  return result;
}

async function probeVideoArtifact(filePath) {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams?.find(stream => stream.codec_type === 'video');
    const audio = data.streams?.find(stream => stream.codec_type === 'audio');
    return {
      container: data.format?.format_name,
      duration: Number(data.format?.duration || video?.duration),
      video: video ? { codec: video.codec_name, width: Number(video.width), height: Number(video.height) } : null,
      audio: audio ? { codec: audio.codec_name } : null
    };
  } catch (_error) {
    try { await runFFmpeg(['-i', filePath]); } catch (error) {
      const text = String(error.stderr || '');
      const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      const video = text.match(/Video:\s*([^,\s]+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
      const audio = text.match(/Audio:\s*([^,\s]+)/i);
      if (duration && video) {
        return {
          container: /mov,mp4/i.test(text) ? 'mov,mp4' : null,
          duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
          video: { codec: video[1], width: Number(video[2]), height: Number(video[3]) },
          audio: audio ? { codec: audio[1] } : null
        };
      }
    }
    throw new Error('FFmpeg could not inspect the artifact');
  }
}

async function decodeVideoArtifact(filePath) {
  await runFFmpeg(['-v', 'error', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
}

async function hashFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function resolveArtifactReference(task, taskId) {
  const reference = Array.isArray(task?.videos) ? task.videos[0] : task?.video;
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('MoneyPrinterTurbo did not return a final video artifact');
  if (/^https?:\/\//i.test(reference)) return reference;
  const normalized = reference.replace(/\\/g, '/');
  const marker = `/tasks/${taskId}/`;
  const index = normalized.indexOf(marker);
  if (index >= 0) return `/api/v1/download/${taskId}/${normalized.slice(index + marker.length)}`;
  if (normalized.startsWith(`/api/v1/download/${taskId}/`)) return normalized;
  throw new Error('MoneyPrinterTurbo returned an unsafe artifact reference');
}

function stableProductionJobId(preparationId) {
  return `short_prod_${crypto.createHash('sha256').update(preparationId).digest('hex').slice(0, 24)}`;
}

function sanitizeError(error) {
  return String(error?.message || error || 'Production execution failed')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(api[-_ ]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 1000);
}

module.exports = {
  ShortsProductionExecutionService,
  ShortsProductionExecutionError,
  validateVideoArtifact,
  probeVideoArtifact,
  decodeVideoArtifact,
  hashFileSha256,
  resolveArtifactReference,
  stableProductionJobId,
  sanitizeError
};
