const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ProductionPreparationError extends Error {
  constructor(message, code = 'PRODUCTION_PREPARATION_FAILED', details = null) {
    super(message);
    this.name = 'ProductionPreparationError';
    this.code = code;
    this.details = details;
  }
}

class ShortsProductionPreparationService {
  constructor({ database, materialDiscovery } = {}) {
    this.database = database;
    this.materialDiscovery = materialDiscovery || discoverLocalVideoMaterials;
  }

  async prepare(planningJobId) {
    if (typeof planningJobId !== 'string' || !planningJobId.trim()) {
      throw new ProductionPreparationError('A planning job ID is required', 'INVALID_PLANNING_JOB_ID');
    }
    const planningJob = await this.database.getShortsPlanningJob(planningJobId.trim());
    if (!planningJob) throw new ProductionPreparationError('Planning job not found', 'PLANNING_JOB_NOT_FOUND');
    if (planningJob.status !== 'SUCCEEDED' || !planningJob.artifact) {
      throw new ProductionPreparationError('Only successful planning jobs can enter production preparation', 'PLANNING_JOB_NOT_READY');
    }

    const preparationId = stablePreparationId(planningJob.job_id);
    await this.database.createShortsProductionPreparation({
      preparation_id: preparationId,
      planning_job_id: planningJob.job_id,
      status: 'VALIDATING'
    });

    const quality = validateProductionPlan(planningJob.artifact);
    if (!quality.passed) {
      const rejected = await this.database.updateShortsProductionPreparation(preparationId, {
        status: 'REJECTED', quality_result: quality, specification: null
      });
      throw new ProductionPreparationError('Shorts production quality gate failed', 'QUALITY_GATE_FAILED', {
        preparation_id: preparationId,
        planning_job_id: planningJob.job_id,
        failures: quality.failures,
        preparation: rejected
      });
    }

    const specification = buildProductionSpecification(planningJob.artifact, preparationId, this.materialDiscovery);
    await this.database.updateShortsProductionPreparation(preparationId, {
      status: 'PRODUCTION_READY', quality_result: quality, specification
    });
    return this.database.getShortsProductionPreparation(preparationId);
  }
}

function stablePreparationId(planningJobId) {
  const digest = crypto.createHash('sha256').update(planningJobId).digest('hex').slice(0, 24);
  return `short_prep_${digest}`;
}

function validateProductionPlan(plan) {
  const failures = [];
  const fail = (code, field, message) => failures.push({ code, field, message });

  if (!string(plan?.topic)) fail('MISSING_TOPIC', 'topic', 'Topic is required');
  if (!string(plan?.content_angle)) fail('MISSING_ANGLE', 'content_angle', 'Content angle is required');
  if (!string(plan?.hook)) fail('MISSING_HOOK', 'hook', 'Opening hook is required');
  if (!string(plan?.script)) fail('MISSING_SCRIPT', 'script', 'Narration script is required');

  const duration = Number(plan?.estimated_duration_seconds);
  if (!Number.isFinite(duration) || duration < 60 || duration > 120) {
    fail('INVALID_DURATION', 'estimated_duration_seconds', 'Narration duration must be between 60 and 120 seconds');
  }
  if (string(plan?.script) && Number.isFinite(duration)) {
    const narrationDuration = Math.round((plan.script.trim().split(/\s+/).length / 150) * 60 * 10) / 10;
    if (Math.abs(narrationDuration - duration) > 0.11) {
      fail('NARRATION_DURATION_MISMATCH', 'script', 'Narration word count must match the estimated duration');
    }
  }

  const scenes = plan?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    fail('MISSING_SCENES', 'scenes', 'At least one ordered scene is required');
  } else {
    let expectedStart = 0;
    scenes.forEach((scene, index) => {
      const prefix = `scenes[${index}]`;
      if (Number(scene?.scene_id) !== index + 1) fail('INVALID_SCENE_ORDER', `${prefix}.scene_id`, 'Scene IDs must be consecutive and start at 1');
      const start = Number(scene?.start_seconds);
      const sceneDuration = Number(scene?.duration_seconds);
      if (!Number.isFinite(start) || start < 0) fail('INVALID_SCENE_START', `${prefix}.start_seconds`, 'Scene start must be a non-negative number');
      if (!Number.isFinite(sceneDuration) || sceneDuration <= 0) fail('INVALID_SCENE_DURATION', `${prefix}.duration_seconds`, 'Scene duration must be positive');
      if (Number.isFinite(start) && Math.abs(start - expectedStart) > 0.11) fail('SCENE_TIMING_MISMATCH', `${prefix}.start_seconds`, 'Scenes must form a contiguous timeline');
      if (!string(scene?.script_segment)) fail('MISSING_SCENE_SCRIPT', `${prefix}.script_segment`, 'Scene narration is required');
      if (!string(scene?.visual_description)) fail('MISSING_VISUAL_DESCRIPTION', `${prefix}.visual_description`, 'Visual description is required');
      if (!Array.isArray(scene?.visual_search_terms) || !scene.visual_search_terms.some(string)) {
        fail('MISSING_VISUAL_SEARCH_TERMS', `${prefix}.visual_search_terms`, 'At least one visual search term is required');
      }
      if (Number.isFinite(start) && Number.isFinite(sceneDuration) && sceneDuration > 0) expectedStart = start + sceneDuration;
    });
    if (Number.isFinite(duration) && Math.abs(expectedStart - duration) > 0.11) {
      fail('SCENE_TIMING_MISMATCH', 'scenes', 'Scene timeline must equal the estimated narration duration');
    }
    if (string(plan?.script)) {
      const sceneNarration = scenes.map(scene => scene?.script_segment || '').join(' ').replace(/\s+/g, ' ').trim();
      const narration = plan.script.replace(/\s+/g, ' ').trim();
      if (sceneNarration !== narration) fail('SCENE_SCRIPT_MISMATCH', 'scenes', 'Ordered scene narration must exactly cover the production script');
    }
  }

  const metadata = plan?.metadata;
  if (!string(metadata?.title) || !string(metadata?.description) ||
      !Array.isArray(metadata?.hashtags) || !metadata.hashtags.some(string) || metadata?.category === undefined || metadata?.category === null || metadata?.category === '') {
    fail('MISSING_METADATA', 'metadata', 'Title, description, hashtags, and category are required');
  }

  const research = plan?.research || {};
  const sources = Array.isArray(research.sources) ? research.sources : [];
  const findings = Array.isArray(research.findings) ? research.findings : [];
  const validSourceUrls = new Set();
  sources.forEach((source, index) => {
    if (!string(source?.title) || !validHttpUrl(source?.url)) {
      fail('INVALID_SOURCE_URL', `research.sources[${index}]`, 'Research sources require a title and valid HTTP(S) URL');
    } else validSourceUrls.add(source.url);
  });
  if ((research.claimed_verified || findings.length > 0) && sources.length === 0) {
    fail('RESEARCH_PROVENANCE_MISSING', 'research.sources', 'Claimed research requires actual source records');
  }
  findings.forEach((finding, index) => {
    const sourceUrl = typeof finding === 'object' ? finding.source_url || finding.sourceUrl : null;
    if (sourceUrl && !validSourceUrls.has(sourceUrl)) {
      fail('RESEARCH_PROVENANCE_MISSING', `research.findings[${index}]`, 'Finding source URL must match a source record');
    }
  });
  if (research.claimed_verified && (!research.available || sources.length === 0)) {
    fail('UNSUPPORTED_FACT_CHECK_CLAIM', 'research.claimed_verified', 'Fact-checking requires an available research provider and source records');
  }

  if (!plan?.ai_provider?.available || !string(plan?.ai_provider?.provider) || !string(plan?.ai_provider?.model)) {
    fail('MISSING_AI_PROVENANCE', 'ai_provider', 'AI provider and model provenance are required');
  }
  if (plan?.validation?.passed !== true) fail('PLANNING_VALIDATION_FAILED', 'validation', 'Phase 3A validation must have passed');

  return {
    passed: failures.length === 0,
    checks: ['content', 'duration', 'scene_timeline', 'visual_guidance', 'metadata', 'research_provenance', 'ai_provenance', 'phase_3a_validation'],
    failures,
    provenance: {
      generation: plan?.ai_provider?.available ? 'ai_generated' : 'unknown',
      research: research.available ? 'research_provider_invoked' : 'not_performed',
      fact_checking: research.claimed_verified && sources.length > 0 ? 'verified_with_sources' : 'not_performed'
    }
  };
}

function buildProductionSpecification(plan, preparationId, materialDiscovery = discoverLocalVideoMaterials) {
  const searchTerms = [...new Set(plan.scenes.flatMap(scene => scene.visual_search_terms).filter(string))];
  return {
    schema_version: 1,
    preparation_id: preparationId,
    planning_job_id: plan.job_id,
    production_state: 'PRODUCTION_READY',
    provenance: {
      generation: 'ai_generated',
      provider: plan.ai_provider.provider,
      model: plan.ai_provider.model,
      research: plan.research?.available ? 'research_provider_invoked' : 'not_performed',
      fact_checking: plan.research?.claimed_verified ? 'verified_with_sources' : 'not_performed',
      sources: plan.research?.sources || []
    },
    duration_seconds: Number(plan.estimated_duration_seconds),
    hook: plan.hook,
    scenes: plan.scenes,
    metadata: plan.metadata,
    mpt_request: {
      video_subject: plan.topic,
      video_script: plan.script,
      video_terms: searchTerms,
      video_aspect: '9:16',
      voice_name: String(process.env.MPT_VOICE_NAME || 'en-US-JennyNeural').trim(),
      voice_rate: Number.isFinite(Number(process.env.MPT_VOICE_RATE)) ? Number(process.env.MPT_VOICE_RATE) : 0.82,
      voice_volume: Number.isFinite(Number(process.env.MPT_VOICE_VOLUME)) ? Number(process.env.MPT_VOICE_VOLUME) : 1.0,
      video_source: 'local',
      video_materials: materialDiscovery()
    }
  };
}

function discoverLocalVideoMaterials() {
  const configuredDirectory = String(process.env.REZS_SHORTS_MATERIALS_DIR || '').trim();
  const configuredManagedDirectory = String(process.env.REZS_MPT_LOCAL_VIDEOS_DIR || '').trim();
  const managedDirectory = path.resolve(configuredManagedDirectory || path.resolve(__dirname, '../../moneyprinterturbo/storage/local_videos'));
  const sourceDirectory = path.resolve(configuredDirectory || managedDirectory);
  const allowed = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.jpg', '.jpeg', '.png']);

  try {
    const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
    const sourceFiles = entries
      .filter(entry => entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));

    fs.mkdirSync(managedDirectory, { recursive: true });

    return sourceFiles.map(entry => {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const sourceStat = fs.statSync(sourcePath);
      const sameDirectory = path.resolve(sourceDirectory) === path.resolve(managedDirectory);
      let managedName = entry.name;

      if (!sameDirectory) {
        const fingerprint = crypto
          .createHash('sha256')
          .update(`${sourcePath}:${sourceStat.size}:${sourceStat.mtimeMs}`)
          .digest('hex')
          .slice(0, 12);
        managedName = `rezs-material-${fingerprint}-${entry.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const managedPath = path.join(managedDirectory, managedName);
        if (!fs.existsSync(managedPath) || fs.statSync(managedPath).size !== sourceStat.size) {
          fs.copyFileSync(sourcePath, managedPath);
        }
      }

      return { provider: 'local', url: managedName, duration: 0 };
    });
  } catch (_error) {
    return [];
  }
}

function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function validHttpUrl(value) {
  if (!string(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

module.exports = {
  ShortsProductionPreparationService,
  ProductionPreparationError,
  stablePreparationId,
  validateProductionPlan,
  buildProductionSpecification
};
