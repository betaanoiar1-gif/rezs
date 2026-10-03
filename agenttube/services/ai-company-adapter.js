const { AICompanyFoundationService } = require('./ai-company-foundation-service');
const { registerAll } = require('../config/ai-company-agent-registry');
const { createArtifact } = require('../schemas/ai-company-artifacts');

const foundationCache = new WeakMap();

async function getAICompanyFoundation(database) {
  if (!database || typeof database.executeQuery !== 'function' || typeof database.getRow !== 'function') return null;
  let foundation = foundationCache.get(database);
  if (!foundation) {
    foundation = new AICompanyFoundationService(database);
    await foundation.initialize();
    await registerAll(foundation);
    foundationCache.set(database, foundation);
  }
  return foundation;
}

async function recordAIArtifact({
  database,
  artifactId,
  artifactType,
  producer,
  payload,
  parentArtifactIds = []
}) {
  const foundation = await getAICompanyFoundation(database);
  if (!foundation) return null;

  if (!foundation) return null;

  const runId = await foundation.startRun({
    runType: `ai_company_${artifactType}`,
    context: { artifact_id: artifactId, producer }
  });
  try {
    const artifact = createArtifact({
      artifactId,
      artifactType,
      producer,
      payload,
      runId,
      parentArtifactIds
    });
    const saved = await foundation.saveArtifact(artifact);
    await foundation.finishRun(runId, { status: 'succeeded' });
    return saved;
  } catch (error) {
    await foundation.finishRun(runId, {
      status: 'failed',
      errorCode: 'AI_COMPANY_ARTIFACT_FAILED',
      errorMessage: String(error?.message || error).slice(0, 500)
    });
    throw error;
  }
}

module.exports = { getAICompanyFoundation, recordAIArtifact };
