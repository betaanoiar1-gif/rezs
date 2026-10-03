const fs = require('fs').promises;
const { OperatorService } = require('../utils/operator-service');
const { validateVideoArtifact, hashFileSha256 } = require('./shorts-production-execution-service');
const { recordAIArtifact, getAICompanyFoundation } = require('./ai-company-adapter');

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
  constructor({ database, operator, artifactValidator = validateVideoArtifact, artifactHasher = hashFileSha256 } = {}) {
    this.database = database;
    this.operator = operator || new OperatorService(database);
    this.artifactValidator = artifactValidator;
    this.artifactHasher = artifactHasher;
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
    await recordAIArtifact({
      database: this.database,
      artifactId: `quality_report_${productionJobId}`,
      artifactType: 'quality_report',
      producer: { agent_id: 'quality-control', layer: 'qa' },
      payload: {
        production_job_id: productionJobId,
        review_status: status,
        passed: quality.passed === true,
        checks: quality.checks || [],
        blocking_failures: quality.blockingFailures || [],
        review_notes: quality.passed ? null : `Blocking checks require human review: ${quality.blockingFailures.join(', ')}`
      }
    });
    return this.reviewResponse(reviewed, chain);
  }

  async get(productionJobId) {
    const chain = await this.requireCompletedChain(productionJobId);
    const bundle = await this.database.getProductionBundle(productionJobId);
    if (!bundle?.review_status) throw new ShortsReviewError('Review handoff has not been created', 'REVIEW_NOT_FOUND');
    return this.reviewResponse(bundle, chain);
  }

  async schedule(productionJobId, input = {}, publishing) {
    if (input.confirmed !== true) throw new ShortsReviewError('Explicit scheduling confirmation is required', 'SCHEDULING_CONFIRMATION_REQUIRED');
    if (typeof input.publishTime !== 'string' || !input.publishTime.trim()) throw new ShortsReviewError('An explicit future publish time is required', 'INVALID_PUBLISH_TIME');
    const publishTime = new Date(input.publishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) throw new ShortsReviewError('Choose a valid future publish time', 'INVALID_PUBLISH_TIME');
    if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new ShortsReviewError('An explicit supported privacy status is required', 'INVALID_PRIVACY_STATE');
    if (!publishing?.scheduleContent) throw new ShortsReviewError('Publishing is not configured', 'PUBLISHING_UNAVAILABLE');

    const chain = await this.requireCompletedChain(productionJobId);
    const bundle = await this.database.getProductionBundle(productionJobId);
    if (!bundle || bundle.review_status !== 'approved') throw new ShortsReviewError('Phase 3F approval is required before scheduling', 'FINAL_APPROVAL_REQUIRED');
    const evidence = bundle.editorData?.finalApprovalGate;
    const confirmations = bundle.editorData?.confirmations || {};
    const requiredConfirmations = ['factualContentReviewed', 'rightsConfirmed', 'metadataReviewed', 'privacyReviewed', 'syntheticMediaReviewed'];
    const determination = bundle.editorData?.syntheticMediaDetermination;
    if (evidence?.passed !== true || requiredConfirmations.some(field => confirmations[field] !== true) ||
        !['contains_synthetic_media', 'does_not_contain_synthetic_media'].includes(determination)) {
      throw new ShortsReviewError('Structurally valid Phase 3F approval evidence is required', 'FINAL_APPROVAL_EVIDENCE_INVALID');
    }

    if (!['verified', 'not_required'].includes(bundle.provenance?.status)) {
      throw new ShortsReviewError('Publishing requires verified or not-required provenance', 'PROVENANCE_NOT_PUBLISHABLE');
    }
    if (bundle.provenance.status === 'verified' && (!Array.isArray(bundle.provenance.sources) || !bundle.provenance.sources.length ||
        !sameValue(bundle.provenance.sources, chain.planning.artifact.research?.sources || []))) {
      throw new ShortsReviewError('Verified provenance no longer matches the approved source evidence', 'PROVENANCE_INCONSISTENT');
    }

    const finalVideo = bundle.assets?.finalVideo;
    const embeddedAudio = bundle.assets?.embeddedAudioValidation;
    const approvedArtifact = evidence.artifact || {};
    const phase3 = chain.production.validation_result || {};
    const approvedPath = approvedArtifact.path;
    if (!finalVideo?.path || finalVideo.path !== chain.production.artifact_path || approvedPath !== finalVideo.path ||
        embeddedAudio?.sourceArtifactPath !== finalVideo.path || embeddedAudio.passed !== true ||
        !embeddedAudio.audioCodec || !(Number(embeddedAudio.durationSeconds) > 0) || finalVideo.validation?.passed !== true) {
      throw new ShortsReviewError('Approved video and embedded-audio evidence are inconsistent', 'APPROVED_ARTIFACT_INVALID');
    }
    if (approvedArtifact.sha256 !== phase3.sha256 || Number(approvedArtifact.fileSize) !== Number(phase3.file_size) ||
        approvedArtifact.technicalValidation?.sha256 !== phase3.sha256) {
      throw new ShortsReviewError('Phase 3C and Phase 3F artifact evidence do not match', 'APPROVED_ARTIFACT_INVALID');
    }
    let stat;
    try { stat = await fs.lstat(finalVideo.path); } catch { throw new ShortsReviewError('Approved artifact was not found', 'ARTIFACT_NOT_FOUND'); }
    if (!stat.isFile() || stat.size < 1 || !finalVideo.path.toLowerCase().endsWith('.mp4')) {
      throw new ShortsReviewError('Approved artifact must be a non-empty regular MP4', 'APPROVED_ARTIFACT_INVALID');
    }
    const sha256 = await this.artifactHasher(finalVideo.path);
    if (sha256 !== phase3.sha256 || stat.size !== Number(phase3.file_size)) {
      throw new ShortsReviewError('Approved artifact identity changed before scheduling', 'ARTIFACT_INTEGRITY_FAILED');
    }

    const normalizedTime = publishTime.toISOString();
    const frozenArtifact = { path: finalVideo.path, sha256, fileSize: stat.size };
    const existing = bundle.schedule;
    if (existing) {
      const existingTime = existing.publish_time || existing.publishTime;
      const existingPrivacy = existing.metadata?.privacyStatus;
      const existingArtifact = existing.metadata?.approvedArtifact;
      if (existingTime === normalizedTime && existingPrivacy === input.privacyStatus && sameValue(existingArtifact, frozenArtifact)) {
        if (bundle.status === 'approved') await this.database.updateProductionStatus(productionJobId, 'scheduled');
        return existing;
      }
      throw new ShortsReviewError('A different schedule already exists; use the reschedule workflow', 'SCHEDULE_CONFLICT');
    }
    if (bundle.status !== 'approved') throw new ShortsReviewError('Approved production is not ready for initial scheduling', 'PRODUCTION_NOT_READY_FOR_SCHEDULING');

    const containsSyntheticMedia = determination === 'contains_synthetic_media';
    if (bundle.provenance.containsSyntheticMedia !== containsSyntheticMedia || bundle.editorData.containsSyntheticMedia !== containsSyntheticMedia) {
      throw new ShortsReviewError('Synthetic-media determination is inconsistent', 'SYNTHETIC_MEDIA_INCONSISTENT');
    }
    const numericCategory = /^\d{1,3}$/.test(String(bundle.seo?.category || '')) ? String(bundle.seo.category) : null;
    const schedule = await publishing.scheduleContent({
      id: productionJobId,
      script: bundle.script,
      seo: { ...bundle.seo, ...(numericCategory ? { categoryId: numericCategory } : {}) },
      assets: bundle.assets,
      scheduledPublishTime: normalizedTime,
      priority: bundle.priority,
      privacyStatus: input.privacyStatus,
      containsSyntheticMedia,
      contentType: 'short',
      canonicalWorkflow: 'phase3f_short',
      approvedArtifact: frozenArtifact,
      finalApprovalEvidence: { passed: true, approvedAt: evidence.approvedAt, artifact: approvedArtifact }
    });
    if (!schedule) throw new ShortsReviewError('Approved Short could not be scheduled', 'SCHEDULING_FAILED');
    await this.database.updateProductionStatus(productionJobId, 'scheduled');
    return schedule;
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
    let candidateProvenance;

    if (action === 'approve') {
      const confirmations = input.confirmations || {};
      const required = ['factualContentReviewed', 'rightsConfirmed', 'metadataReviewed', 'privacyReviewed', 'syntheticMediaReviewed'];
      const missing = required.filter(field => confirmations[field] !== true);
      if (missing.length) {
        throw new ShortsReviewError(`Explicit approval confirmations are required: ${missing.join(', ')}`, 'APPROVAL_CONFIRMATION_REQUIRED', { missing });
      }
      const privacyStatus = input.privacyStatus || bundle.editorData?.privacyStatus || 'private';
      if (!['private', 'unlisted', 'public'].includes(privacyStatus)) throw new ShortsReviewError('Privacy state is invalid', 'INVALID_PRIVACY_STATE');
      const syntheticMediaDetermination = input.syntheticMediaDetermination;
      if (!['contains_synthetic_media', 'does_not_contain_synthetic_media'].includes(syntheticMediaDetermination)) {
        throw new ShortsReviewError('An explicit synthetic-media determination is required', 'SYNTHETIC_MEDIA_DETERMINATION_REQUIRED');
      }
      const sources = bundle.provenance?.sources || [];
      const factCheckStatus = sources.length ? 'verified_with_reviewed_sources' : 'human_reviewed_no_recorded_sources';
      const containsSyntheticMedia = syntheticMediaDetermination === 'contains_synthetic_media';
      candidateProvenance = {
        ...bundle.provenance,
        containsSyntheticMedia,
        status: sources.length ? 'verified' : 'operator_reviewed',
        summary: {
          ...(bundle.provenance?.summary || {}), factCheckStatus, humanReviewed: true,
          syntheticMediaDetermination
        },
        reviewedAt: now
      };
      const finalGate = await this.runFinalApprovalGate(chain, bundle, candidateProvenance, confirmations, now);
      editorData = {
        ...(bundle.editorData || {}), reviewer, confirmations, decisionAction: action, factChecked: true,
        rightsConfirmed: true, metadataReviewed: true, privacyStatus,
        factCheckStatus, rightsStatus: 'confirmed', inputsLocked: true,
        syntheticMediaDetermination, containsSyntheticMedia, finalApprovalGate: finalGate,
        approvedAt: now
      };
      notes = String(input.notes || 'Approved by operator').trim();
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

    const review = {
      status: target, editorData,
      qualityChecks: editorData?.finalApprovalGate?.qualityChecks || bundle.qualityChecks,
      reviewNotes: notes, reviewedAt: now
    };
    if (action === 'approve') {
      const result = await this.database.saveShortsFinalApproval(productionJobId, {
        provenance: candidateProvenance,
        review,
        sceneIds: (bundle.scenes || []).map(scene => scene.id)
      });
      await recordAIArtifact({
        database: this.database,
        artifactId: `quality_report_${productionJobId}`,
        artifactType: 'quality_report',
        producer: { agent_id: 'quality-control', layer: 'qa' },
        payload: {
          production_job_id: productionJobId,
          review_status: 'approved',
          passed: true,
          checks: review.qualityChecks || [],
          final_approval_gate: editorData.finalApprovalGate
        }
      });
      const foundation = await getAICompanyFoundation(this.database);
      await foundation.setReleaseGate({
        gateId: `release_${productionJobId}`,
        productionId: productionJobId,
        status: 'approved',
        checks: review.qualityChecks || [],
        blockingReasons: []
      });
      return this.reviewResponse(result, chain);
    }
    const result = await this.database.saveContentReview(productionJobId, review);
    await this.database.updateProductionStatus(productionJobId, target);
    const foundation = await getAICompanyFoundation(this.database);
    await foundation.setReleaseGate({
      gateId: `release_${productionJobId}`,
      productionId: productionJobId,
      status: 'blocked',
      checks: review.qualityChecks || [],
      blockingReasons: [notes]
    });
    return this.reviewResponse(result, chain);
  }

  async runFinalApprovalGate(chain, bundle, candidateProvenance, confirmations, approvedAt) {
    const persisted = chain.production.validation_result || {};
    const required = ['file_size', 'sha256', 'duration_seconds', 'resolution', 'video_codec', 'audio_codec', 'container'];
    const missing = required.filter(field => persisted[field] === undefined || persisted[field] === null || persisted[field] === '');
    if (persisted.passed !== true || missing.length || !/^[a-f0-9]{64}$/i.test(String(persisted.sha256))) {
      throw new ShortsReviewError('Phase 3C artifact validation evidence is incomplete', 'ARTIFACT_VALIDATION_EVIDENCE_INVALID', { missing });
    }
    if (Number(persisted.file_size) !== chain.artifactStat.size) {
      throw new ShortsReviewError('Artifact size changed after Phase 3C validation', 'ARTIFACT_INTEGRITY_FAILED');
    }

    const observedSha256 = await this.artifactHasher(chain.production.artifact_path);
    if (observedSha256 !== persisted.sha256) {
      throw new ShortsReviewError('Artifact bytes changed after Phase 3C validation', 'ARTIFACT_INTEGRITY_FAILED');
    }

    let technicalValidation;
    try {
      technicalValidation = await this.artifactValidator(
        chain.production.artifact_path,
        chain.preparation.specification.duration_seconds
      );
    } catch (_error) {
      throw new ShortsReviewError('Current artifact failed strict MP4 validation', 'FINAL_ARTIFACT_VALIDATION_FAILED');
    }
    const currentMissing = required.filter(field => technicalValidation?.[field] === undefined || technicalValidation?.[field] === null || technicalValidation?.[field] === '');
    const evidenceMismatch = ['resolution', 'video_codec', 'audio_codec', 'container'].some(field => technicalValidation?.[field] !== persisted[field]) ||
      Math.abs(Number(technicalValidation?.duration_seconds) - Number(persisted.duration_seconds)) > 0.01;
    if (technicalValidation?.passed !== true || currentMissing.length || technicalValidation.sha256 !== observedSha256 ||
        Number(technicalValidation.file_size) !== chain.artifactStat.size || evidenceMismatch) {
      throw new ShortsReviewError('Current artifact validation is inconsistent with Phase 3C evidence', 'FINAL_ARTIFACT_VALIDATION_FAILED', { missing: currentMissing });
    }

    const candidate = {
      ...bundle,
      contentType: 'short',
      provenance: candidateProvenance,
      finalReviewEvidence: { factualContentReviewed: confirmations.factualContentReviewed === true },
      assets: {
        ...(bundle.assets || {}),
        finalVideo: { ...(bundle.assets?.finalVideo || {}), validation: technicalValidation },
        embeddedAudioValidation: {
          passed: technicalValidation.passed === true && Boolean(technicalValidation.audio_codec),
          audioCodec: technicalValidation.audio_codec,
          durationSeconds: technicalValidation.duration_seconds,
          sourceArtifactPath: chain.production.artifact_path
        }
      }
    };
    const profile = await this.database.getChannelProfile?.() || {};
    const quality = await this.operator.runQualityChecks(candidate, profile);
    if (!quality.passed) {
      throw new ShortsReviewError('Final approval quality gate has blocking failures', 'FINAL_QUALITY_GATE_FAILED', {
        blockingFailures: quality.blockingFailures
      });
    }
    return {
      passed: true,
      approvedAt,
      artifact: {
        path: chain.production.artifact_path,
        sha256: observedSha256,
        fileSize: chain.artifactStat.size,
        technicalValidation
      },
      qualityPassed: true,
      qualityChecks: quality.checks
    };
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
