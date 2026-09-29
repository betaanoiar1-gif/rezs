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

    const preparationService = new ShortsProductionPreparationService({ database });
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
      maxPolls: Number(process.env.MPT_MAX_POLLS || 300)
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

main().catch(error => {
  console.error('=== REAL PHASE 3C FAILED ===');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
