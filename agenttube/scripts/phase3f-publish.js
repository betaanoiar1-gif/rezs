#!/usr/bin/env node

require('dotenv').config();

const { Database } = require('../database/db');
const { ShortsReviewService } = require('../services/shorts-review-service');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { CredentialManager } = require('../utils/credential-manager');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanConfirmation(name) {
  if (String(process.env[name] || '').trim().toUpperCase() !== 'YES') {
    throw new Error(`${name}=YES is required for this explicit human approval`);
  }
  return true;
}

async function main() {
  const productionJobId = required('PRODUCTION_JOB_ID');
  const publishTime = required('PUBLISH_TIME');
  const privacyStatus = String(process.env.PRIVACY_STATUS || 'private').trim();
  const reviewer = required('REVIEWER');
  const syntheticMediaDetermination = required('SYNTHETIC_MEDIA_DETERMINATION');

  if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
    throw new Error('PRIVACY_STATUS must be private, unlisted, or public');
  }
  if (!['contains_synthetic_media', 'does_not_contain_synthetic_media'].includes(syntheticMediaDetermination)) {
    throw new Error('SYNTHETIC_MEDIA_DETERMINATION is invalid');
  }

  for (const name of [
    'CONFIRM_FACTUAL_CONTENT_REVIEWED',
    'CONFIRM_RIGHTS_CONFIRMED',
    'CONFIRM_METADATA_REVIEWED',
    'CONFIRM_PRIVACY_REVIEWED',
    'CONFIRM_SYNTHETIC_MEDIA_REVIEWED'
  ]) booleanConfirmation(name);

  const db = new Database();
  await db.initialize();

  try {
    const credentials = new CredentialManager();
    await credentials.initialize();
    const publishing = new PublishingSchedulingAgent(db, credentials);
    await publishing.initialize();

    const review = new ShortsReviewService({ database: db, operator: null });

    console.log('=== REZS EXPLICIT HUMAN APPROVAL -> SCHEDULE -> PUBLISH ===');
    console.log('Production:', productionJobId);
    console.log('Reviewer:', reviewer);
    console.log('Publish time:', publishTime);
    console.log('Privacy:', privacyStatus);

    const handoff = await review.handoff(productionJobId);
    console.log('Review handoff:', handoff.status || handoff.reviewStatus);

    const approved = await review.decide(productionJobId, 'approve', {
      reviewer,
      notes: 'Explicit operator approval supplied through the production runtime.',
      confirmations: {
        factualContentReviewed: true,
        rightsConfirmed: true,
        metadataReviewed: true,
        privacyReviewed: true,
        syntheticMediaReviewed: true
      },
      privacyStatus,
      syntheticMediaDetermination,
      factChecked: true,
      rightsConfirmed: true
    });
    console.log('Phase 3F approval:', approved.reviewStatus || approved.status);

    const schedule = await review.schedule(
      productionJobId,
      { confirmed: true, publishTime, privacyStatus },
      publishing
    );
    console.log('Scheduled:', schedule.id || schedule.productionId);
    console.log('Scheduled for:', schedule.publishTime);

    if (String(process.env.PUBLISH_NOW || '').trim().toUpperCase() !== 'YES') {
      console.log('PUBLISH_NOW is not YES; stopping after verified scheduling.');
      return;
    }

    const published = await publishing.publishContent(productionJobId, { publishNow: false });
    console.log(JSON.stringify({
      status: published.status,
      youtubeId: published.youtubeId,
      youtubeUrl: published.youtubeUrl,
      publishedAt: published.publishedAt
    }, null, 2));

    if (published.status !== 'published' || !published.youtubeId) {
      throw new Error('YouTube publish did not reach the published state');
    }

    console.log('=== REAL YOUTUBE PUBLISH PASSED ===');
  } finally {
    if (typeof db.close === 'function') await db.close();
  }
}

main().catch(error => {
  console.error('=== RELEASE PIPELINE FAILED ===');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
