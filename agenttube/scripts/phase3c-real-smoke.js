#!/usr/bin/env node

require('dotenv').config();

const { Database } = require('../database/db');
const {
  ShortsProductionPreparationService
} = require('../services/shorts-production-preparation-service');
const {
  ShortsProductionExecutionService
} = require('../services/shorts-production-execution-service');
const {
  MoneyPrinterTurboClient,
  MoneyPrinterTurboProductionService
} = require('../integrations/moneyprinterturbo');
const { ShortsMaterialService } = require('../services/shorts-material-service');

/**
 * Use the same acquisition path as POST /prepare-production whenever a stock
 * provider is configured, so the smoke runner exercises what production does.
 * With no provider configured it falls back to the preparation service's local
 * directory scan, which keeps a fully offline run possible.
 */
function resolveMaterialDiscovery() {
  if (String(process.env.REZS_SHORTS_LOCAL_MATERIALS_ONLY || '').toLowerCase() === 'true') {
    console.log('Materials: local directory scan (REZS_SHORTS_LOCAL_MATERIALS_ONLY=true)');
    return undefined;
  }
  const service = new ShortsMaterialService();
  const configured = service.configuredProviders().map(provider => provider.provider);
  if (!configured.length) {
    console.log('Materials: local directory scan (no stock media provider configured)');
    return undefined;
  }
  console.log(`Materials: stock providers in fallback order: ${configured.join(' -> ')}`);
  return plan => service.discoverMaterials(plan);
}

async function main() {
  const planningJobId = String(process.env.PLANNING_JOB_ID || '').trim();
  if (!planningJobId) {
    throw new Error('PLANNING_JOB_ID is required');
  }

  const database = new Database();
  await database.initialize();

  try {
    console.log('=== REZS REAL PHASE 3B -> 3C ===');
    console.log('Planning job:', planningJobId);
    console.log('MPT base URL:', process.env.MPT_BASE_URL || 'http://127.0.0.1:8080');

    const preparationService = new ShortsProductionPreparationService({
      database,
      materialDiscovery: resolveMaterialDiscovery()
    });
    const preparation = await preparationService.prepare(planningJobId);

    if (preparation.status !== 'PRODUCTION_READY' || preparation.quality_result?.passed !== true) {
      throw new Error('Phase 3B did not produce PRODUCTION_READY');
    }

    console.log('Phase 3B: PRODUCTION_READY');
    console.log('Preparation:', preparation.preparation_id);

    const client = new MoneyPrinterTurboClient();
    const productionService = new MoneyPrinterTurboProductionService({
      client,
      database,
      pollIntervalMs: Number(process.env.MPT_POLL_INTERVAL_MS || 2000),
      maxPolls: Number(process.env.MPT_MAX_POLLS || 900)
    });
    const execution = new ShortsProductionExecutionService({
      database,
      client,
      productionService
    });

    const submitted = await execution.start(preparation.preparation_id);
    console.log('Phase 3C submitted:', submitted.job_id);
    console.log('MPT task:', submitted.mpt_task_id);

    const completed = await execution.execute(submitted.job_id);

    console.log(JSON.stringify({
      production_job_id: completed.job_id,
      status: completed.status,
      stage: completed.stage,
      mpt_task_id: completed.mpt_task_id,
      artifact_path: completed.artifact_path,
      artifact_reference: completed.artifact_reference,
      validation_result: completed.validation_result
    }, null, 2));

    if (completed.status !== 'SUCCEEDED' || completed.stage !== 'ARTIFACT_DOWNLOADED') {
      throw new Error(
        `Phase 3C did not complete successfully: ${completed.status}/${completed.stage}`
      );
    }

    if (completed.validation_result?.passed !== true) {
      throw new Error('Phase 3C artifact validation did not pass');
    }

    console.log('=== REAL PHASE 3C PASSED ===');
  } finally {
    if (typeof database.close === 'function') {
      await database.close();
    }
  }
}

main().catch(async error => {
  console.error('=== REAL PHASE 3C FAILED ===');
  console.error(error?.stack || error);

  // Expose the persisted validation details so duration/codec/path failures
  // can be diagnosed from a single smoke-test run without manual DB queries.
  try {
    const planningJobId = String(process.env.PLANNING_JOB_ID || '').trim();
    if (planningJobId && error?.code === 'ARTIFACT_VALIDATION_FAILED') {
      const database = new Database();
      await database.initialize();
      try {
        const preparation = await database.getShortsProductionPreparationByPlanningJob(planningJobId);
        const productionJob = preparation
          ? await database.getProductionJobByPreparation(preparation.preparation_id)
          : null;

        console.error('=== ARTIFACT VALIDATION DETAILS ===');
        console.error(JSON.stringify({
          approved_duration_seconds: preparation?.specification?.duration_seconds ?? null,
          voice_rate: preparation?.specification?.mpt_request?.voice_rate ?? null,
          production_job_id: productionJob?.job_id ?? error?.details?.production_job_id ?? null,
          mpt_task_id: productionJob?.mpt_task_id ?? null,
          artifact_path: productionJob?.artifact_path ?? null,
          validation_result:
            error?.details?.validation ||
            productionJob?.validation_result ||
            null
        }, null, 2));
      } finally {
        if (typeof database.close === 'function') {
          await database.close();
        }
      }
    }
  } catch (diagnosticError) {
    console.error('Validation diagnostics unavailable:', diagnosticError?.message || diagnosticError);
  }

  process.exitCode = 1;
});
