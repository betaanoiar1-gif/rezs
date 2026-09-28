const fs = require('fs').promises;
const { OperatorService } = require('../utils/operator-service');

const DECISIONS = new Set(['approve', 'reject', 'request-changes']);

class ShortsReviewError extends Error {
  constructor(message, code = 'SHORTS_REVIEW_FAILED', details = null) {
    super(message);
    this.name = 'ShortsReviewError';
    this.code = code;
    this.details = details;
  }
}

class ShortsReviewService {
  constructor({ database, operator } = {}) {
    this.database = database;
    this.operator = operator || new OperatorService(database);
  }

  async handoff(productionJobId) {
    const chain = await this.requireCompletedChain(productionJobId);
    const existing = await this.database.getProductionBundle(productionJobId);
    if (existing?.review_status) return this.reviewResponse(existing, chain);

    const canonical = this.buildCanonicalProduction(chain);
    if (!existing) await this.database.saveProductionData(canonical);
    await this.database.saveProductionSnapshot(canonical);
    await this.database.replaceProductionScenes(canonical.id, canonical.scenes);
    await this.database.saveContentProvenance(canonical.id, canonical.provenance);

    const bundle = await this.database.getProductionBundle(productionJobId);
    const profile = await this.database.getChannelProfile?.() || {};
    const quality = await this.operator.runQualityChecks({ ...bundle, contentType: 'short' }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    const reviewed = await this.database.saveContentReview(productionJobId, {
      status,
      editorData: {
        reviewer: null,
        confirmations: {},
        researchStatus: canonical.reviewEvidence.researchStatus,
        factCheckStatus: 'pending_review',
        rightsStatus: 'pending_review',
        privacyStatus: 'private',
        containsSyntheticMedia: canonical.provenance.containsSyntheticMedia,
        inputsLocked: false
      },
      qualityChecks: quality.checks,
      reviewNotes: quality.passed ? null : `Blocking checks require human review: ${quality.blockingFailures.join(', ')}`,
      reviewedAt: null
    });
    return this.reviewResponse(reviewed, chain);
  }

  async get(productionJobId) {
    const chain = await this.requireCompletedChain(productionJobId);
    const bundle = await this.database.getProductionBundle(productionJobId);
    if (!bundle?.review_status) throw new ShortsReviewError('Review handoff has not been created', 'REVIEW_NOT_FOUND');
    return this.reviewResponse(bundle, chain);
  }

  async decide(productionJobId, action, input = {}) {
    if (!DECISIONS.has(action)) throw new ShortsReviewError('Review action must be approve, reject, or request-changes', 'INVALID_REVIEW_ACTION');
    const chain = await this.requireCompletedChain(productionJobId);
    const bundle = await this.database.getProductionBundle(productionJobId);
    if (!bundle?.review_status) throw new ShortsReviewError('Review handoff has not been created', 'REVIEW_NOT_FOUND');

    const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'needs_attention';
    if (bundle.editorData?.decisionAction === action) return this.reviewResponse(bundle, chain);
    if (['approved', 'rejected'].includes(bundle.review_status)) throw new ShortsReviewError('Completed review inputs are locked', 'REVIEW_LOCKED');

    const reviewer = normalizeReviewer(input.reviewer);
    const now = new Date().toISOString();
    let notes;
    let editorData;

    if (action === 'approve') {
      const confirmations = input.confirmations || {};
      const required = ['factualContentReviewed', 'rightsConfirmed', 'metadataReviewed', 'privacyReviewed', 'syntheticMediaReviewed'];
      const missing = required.filter(field => confirmations[field] !== true);
      if (missing.length) {
        throw new ShortsReviewError(`Explicit approval confirmations are required: ${missing.join(', ')}`, 'APPROVAL_CONFIRMATION_REQUIRED', { missing });
      }
      const privacyStatus = input.privacyStatus || bundle.editorData?.privacyStatus || 'private';
      if (!['private', 'unlisted', 'public'].includes(privacyStatus)) throw new ShortsReviewError('Privacy state is invalid', 'INVALID_PRIVACY_STATE');
      const sources = bundle.provenance?.sources || [];
      const factCheckStatus = sources.length ? 'verified_with_reviewed_sources' : 'human_reviewed_no_recorded_sources';
      editorData = {
        ...(bundle.editorData || {}), reviewer, confirmations, decisionAction: action, factChecked: true,
        rightsConfirmed: true, metadataReviewed: true, privacyStatus,
        factCheckStatus, rightsStatus: 'confirmed', inputsLocked: true,
        approvedAt: now
      };
      notes = String(input.notes || 'Approved by operator').trim();
      await this.database.saveContentProvenance(productionJobId, {
        ...bundle.provenance,
        status: sources.length ? 'verified' : 'operator_reviewed',
        summary: { ...(bundle.provenance?.summary || {}), factCheckStatus, humanReviewed: true },
        reviewedAt: now
      });
      for (const scene of bundle.scenes || []) await this.database.updateProductionScene(productionJobId, scene.id, { locked: true });
    } else {
      const reason = String(input.reason || input.notes || '').trim();
      if (!reason) throw new ShortsReviewError(`${action === 'reject' ? 'Rejection' : 'Change request'} reason is required`, action === 'reject' ? 'REJECTION_REASON_REQUIRED' : 'CHANGE_REASON_REQUIRED');
      notes = reason;
      editorData = {
        ...(bundle.editorData || {}), reviewer, inputsLocked: false,
        decisionAction: action, decisionReason: reason,
        [action === 'reject' ? 'rejectedAt' : 'changesRequestedAt']: now
      };
    }

    const result = await this.database.saveContentReview(productionJobId, {
      status: target, editorData, qualityChecks: bundle.qualityChecks,
      reviewNotes: notes, reviewedAt: now
    });
    await this.database.updateProductionStatus(productionJobId, target);
    return this.reviewResponse(result, chain);
  }

  async requireCompletedChain(productionJobId) {
    const production = await this.database.getProductionJob(productionJobId);
    if (!production) throw new ShortsReviewError('Production job not found', 'PRODUCTION_NOT_FOUND');
    if (production.status !== 'SUCCEEDED' || production.stage !== 'ARTIFACT_DOWNLOADED') {
      throw new ShortsReviewError('Production has not completed artifact download', 'PRODUCTION_NOT_READY');
    }
    if (production.validation_result?.passed !== true) {
      throw new ShortsReviewError('Persisted artifact validation did not pass', 'ARTIFACT_INVALID');
    }
    let stat;
    try { stat = await fs.lstat(production.artifact_path); }
    catch { throw new ShortsReviewError('Production artifact was not found', 'ARTIFACT_NOT_FOUND'); }
    if (!stat.isFile() || stat.size < 1) throw new ShortsReviewError('Production artifact is not a non-empty regular file', 'ARTIFACT_INVALID');

    const preparation = await this.database.getShortsProductionPreparation(production.preparation_id);
    const planning = await this.database.getShortsPlanningJob(production.planning_job_id);
    if (!preparation || preparation.status !== 'PRODUCTION_READY' || preparation.quality_result?.passed !== true ||
        !preparation.specification?.mpt_request || !planning || planning.status !== 'SUCCEEDED' || !planning.artifact ||
        planning.artifact.validation?.passed !== true || preparation.planning_job_id !== planning.job_id ||
        production.preparation_id !== preparation.preparation_id || production.planning_job_id !== planning.job_id ||
        preparation.specification.production_state !== 'PRODUCTION_READY' ||
        preparation.specification.preparation_id !== preparation.preparation_id ||
        preparation.specification.planning_job_id !== planning.job_id) {
      throw new ShortsReviewError('Planning, preparation, or production provenance is incomplete', 'PROVENANCE_INCOMPLETE');
    }
    if (preparation.specification.mpt_request.video_script !== planning.artifact.script ||
        !sameValue(preparation.specification.metadata, planning.artifact.metadata) ||
        !sameValue(preparation.specification.scenes, planning.artifact.scenes) ||
        preparation.specification.hook !== planning.artifact.hook ||
        Number(preparation.specification.duration_seconds) !== Number(planning.artifact.estimated_duration_seconds)) {
      throw new ShortsReviewError('Approved production specification does not match the planning artifact', 'PROVENANCE_INCOMPLETE');
    }
    return { planning, preparation, production, artifactStat: stat };
  }

  buildCanonicalProduction({ planning, preparation, production }) {
    const plan = planning.artifact;
    const sources = Array.isArray(plan.research?.sources) ? plan.research.sources : [];
    const researchStatus = plan.research?.available ? 'performed' : 'not_performed';
    const claims = [{ id: 'narration', text: 'Factual narration requires operator review', status: 'pending_review' }];
    const validation = production.validation_result;
    const scenes = plan.scenes.map((scene, index) => ({
      id: `short_scene_${index + 1}`,
      label: `Scene ${index + 1}`,
      scriptText: scene.script_segment,
      prompt: scene.visual_description,
      duration: scene.duration_seconds,
      assetType: 'video', assetOrigin: 'mpt_render', assetPath: production.artifact_path,
      audioPath: null, narrationProvider: 'embedded_mpt_audio', narrationModel: validation.audio_codec,
      narrationStatus: 'current', status: 'ready', locked: false, rightsConfirmed: false,
      provenanceSourceIds: sources.map(source => source.url), containsSyntheticMedia: false
    }));
    const provenance = {
      sources, claims, containsSyntheticMedia: false, status: 'pending_review',
      summary: {
        researchStatus, factCheckStatus: 'pending_review', sourceCount: sources.length,
        verifiedSources: 0, claimCount: claims.length, resolvedClaims: 0,
        unresolvedClaims: claims.length, highRiskClaims: 0,
        planningJobId: planning.job_id, preparationId: preparation.preparation_id,
        productionJobId: production.job_id, mptTaskId: production.mpt_task_id
      }
    };
    return {
      id: production.job_id,
      status: 'needs_review',
      strategy: { topic: plan.topic, angle: plan.content_angle, contentType: 'Short' },
      script: { title: plan.metadata.title, hook: plan.hook, fullScript: plan.script },
      thumbnail: {},
      seo: {
        title: plan.metadata.title, description: plan.metadata.description,
        tags: plan.metadata.hashtags, hashtags: plan.metadata.hashtags, category: plan.metadata.category
      },
      assets: {
        finalVideo: {
          path: production.artifact_path, simulated: false, aspectRatio: '9:16',
          duration: plan.estimated_duration_seconds, validation
        },
        embeddedAudioValidation: {
          passed: validation.passed === true && Boolean(validation.audio_codec),
          audioCodec: validation.audio_codec, durationSeconds: validation.duration_seconds,
          sourceArtifactPath: production.artifact_path
        },
        audio: null, thumbnail: null, captions: null
      },
      timeline: { scenes: plan.scenes, durationSeconds: plan.estimated_duration_seconds },
      scenes,
      provenance,
      reviewEvidence: { researchStatus, factCheckStatus: 'pending_review' },
      scheduledPublishTime: null,
      priority: 50,
      estimatedDuration: String(plan.estimated_duration_seconds)
    };
  }

  reviewResponse(bundle, chain) {
    const plan = chain.planning.artifact;
    return {
      productionId: chain.production.job_id,
      reviewId: chain.production.job_id,
      status: bundle.review_status,
      reviewStatus: bundle.review_status,
      topic: plan.topic,
      angle: plan.content_angle,
      hook: plan.hook,
      narration: plan.script,
      scenes: plan.scenes,
      title: plan.metadata.title,
      description: plan.metadata.description,
      tags: plan.metadata.hashtags,
      category: plan.metadata.category,
      artifact: {
        path: chain.production.artifact_path,
        size: chain.artifactStat.size,
        validation: chain.production.validation_result
      },
      qualityChecks: bundle.qualityChecks || [],
      provenance: {
        planningJobId: chain.planning.job_id,
        preparationId: chain.preparation.preparation_id,
        productionJobId: chain.production.job_id,
        mptTaskId: chain.production.mpt_task_id,
        researchStatus: bundle.editorData?.researchStatus || (plan.research?.available ? 'performed' : 'not_performed'),
        factCheckStatus: bundle.editorData?.factCheckStatus || 'pending_review',
        sources: (plan.research?.sources || []).map(publicSource)
      },
      rightsStatus: bundle.editorData?.rightsStatus || 'pending_review',
      reviewNotes: bundle.review_notes || null,
      reviewer: bundle.editorData?.reviewer || null,
      confirmations: bundle.editorData?.confirmations || {},
      reviewedAt: bundle.reviewed_at || null,
      createdAt: bundle.created_at,
      updatedAt: bundle.reviewed_at || bundle.created_at
    };
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicSource(source) {
  const copy = { ...source };
  if (!copy.url) return copy;
  try {
    const url = new URL(copy.url);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|signature|credential|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    copy.url = url.toString();
  } catch (_) {
    copy.url = '[invalid source URL]';
  }
  return copy;
}

function normalizeReviewer(value) {
  const reviewer = String(value || 'operator').trim();
  return reviewer.slice(0, 200) || 'operator';
}

module.exports = { ShortsReviewService, ShortsReviewError, DECISIONS };
