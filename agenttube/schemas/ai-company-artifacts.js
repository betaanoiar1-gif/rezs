const ARTIFACT_SCHEMA_VERSION = 1;

const ARTIFACT_TYPES = Object.freeze([
  'research', 'strategy', 'idea', 'story', 'creative_plan',
  'production_manifest', 'timeline', 'quality_report', 'performance', 'growth_memory'
]);

const AGENT_LAYERS = Object.freeze([
  'ceo', 'intelligence', 'strategy', 'creative', 'production', 'qa', 'publishing', 'analytics', 'learning'
]);

function validateArtifactEnvelope(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new TypeError('artifact must be an object');
  for (const field of ['artifact_id', 'artifact_type', 'schema_version', 'created_at', 'producer']) {
    if (artifact[field] === undefined || artifact[field] === null || artifact[field] === '') {
      throw new Error(`artifact.${field} is required`);
    }
  }
  if (!ARTIFACT_TYPES.includes(artifact.artifact_type)) throw new Error(`Unsupported artifact type: ${artifact.artifact_type}`);
  if (Number(artifact.schema_version) !== ARTIFACT_SCHEMA_VERSION) throw new Error(`Unsupported artifact schema version: ${artifact.schema_version}`);
  if (!artifact.producer.agent_id || !artifact.producer.layer) throw new Error('artifact.producer.agent_id and producer.layer are required');
  if (!AGENT_LAYERS.includes(artifact.producer.layer)) throw new Error(`Unsupported producer layer: ${artifact.producer.layer}`);
  return true;
}

function createArtifact({ artifactId, artifactType, producer, payload, runId = null, parentArtifactIds = [] }) {
  const artifact = {
    artifact_id: String(artifactId),
    artifact_type: String(artifactType),
    schema_version: ARTIFACT_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    producer: { agent_id: String(producer.agent_id), layer: String(producer.layer) },
    run_id: runId,
    parent_artifact_ids: Array.isArray(parentArtifactIds) ? parentArtifactIds.map(String) : [],
    payload: payload && typeof payload === 'object' ? payload : {}
  };
  validateArtifactEnvelope(artifact);
  return artifact;
}

module.exports = { ARTIFACT_SCHEMA_VERSION, ARTIFACT_TYPES, AGENT_LAYERS, validateArtifactEnvelope, createArtifact };
