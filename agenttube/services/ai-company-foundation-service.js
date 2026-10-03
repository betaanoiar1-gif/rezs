const crypto = require('crypto');
const { validateArtifactEnvelope, ARTIFACT_SCHEMA_VERSION } = require('../schemas/ai-company-artifacts');
const FOUNDATION_SCHEMA_VERSION = 1;

class AICompanyFoundationService {
  constructor(database, { logger = null } = {}) {
    if (!database || typeof database.executeQuery !== 'function') throw new TypeError('A database with executeQuery() is required');
    this.database = database; this.logger = logger;
  }
  async initialize() { await this.ensureSchema(); return { schema_version: FOUNDATION_SCHEMA_VERSION, ready: true }; }
  async ensureSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ai_company_agents (agent_id TEXT PRIMARY KEY, layer TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', capabilities_json TEXT NOT NULL DEFAULT '[]', config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS ai_company_runs (run_id TEXT PRIMARY KEY, run_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', parent_run_id TEXT, context_json TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, error_code TEXT, error_message TEXT)`,
      `CREATE TABLE IF NOT EXISTS ai_company_artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT, artifact_type TEXT NOT NULL, schema_version INTEGER NOT NULL, producer_agent_id TEXT NOT NULL, parent_artifact_ids_json TEXT NOT NULL DEFAULT '[]', payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (run_id) REFERENCES ai_company_runs(run_id), FOREIGN KEY (producer_agent_id) REFERENCES ai_company_agents(agent_id))`,
      `CREATE INDEX IF NOT EXISTS idx_ai_company_artifacts_type_created ON ai_company_artifacts(artifact_type, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_company_artifacts_run ON ai_company_artifacts(run_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS ai_company_decisions (decision_id TEXT PRIMARY KEY, run_id TEXT, decision_type TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '{}', evidence_artifact_ids_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'low', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (run_id) REFERENCES ai_company_runs(run_id))`,
      `CREATE TABLE IF NOT EXISTS ai_company_channel_memory (memory_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, source_artifact_ids_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'low', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS ai_company_release_gates (gate_id TEXT PRIMARY KEY, run_id TEXT, production_id TEXT, status TEXT NOT NULL DEFAULT 'pending', checks_json TEXT NOT NULL DEFAULT '[]', blocking_reasons_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, evaluated_at TEXT, FOREIGN KEY (run_id) REFERENCES ai_company_runs(run_id))`,
      `CREATE INDEX IF NOT EXISTS idx_ai_company_release_gates_production ON ai_company_release_gates(production_id, created_at)`
    ];
    for (const statement of statements) await this.database.executeQuery(statement);
  }
  async registerAgent({ agentId, layer, role, capabilities = [], config = {} }) {
    if (!agentId || !layer || !role) throw new Error('agentId, layer and role are required');
    await this.database.executeQuery(`INSERT INTO ai_company_agents (agent_id, layer, role, capabilities_json, config_json, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(agent_id) DO UPDATE SET layer=excluded.layer, role=excluded.role, capabilities_json=excluded.capabilities_json, config_json=excluded.config_json, updated_at=CURRENT_TIMESTAMP`, [agentId, layer, role, JSON.stringify(capabilities), JSON.stringify(config)]);
    return this.getAgent(agentId);
  }
  async getAgent(agentId) { const row = await this.database.getRow('SELECT * FROM ai_company_agents WHERE agent_id = ?', [agentId]); return row ? this.parseAgent(row) : null; }
  async startRun({ runId = `company_\${crypto.randomUUID()}`, runType = 'shorts', parentRunId = null, context = {} } = {}) {
    await this.database.executeQuery('INSERT INTO ai_company_runs (run_id, run_type, status, parent_run_id, context_json) VALUES (?, ?, \'running\', ?, ?)', [runId, runType, parentRunId, JSON.stringify(context)]);
    return runId;
  }
  async finishRun(runId, { status = 'succeeded', errorCode = null, errorMessage = null } = {}) {
    await this.database.executeQuery('UPDATE ai_company_runs SET status=?, completed_at=CURRENT_TIMESTAMP, error_code=?, error_message=? WHERE run_id=?', [status, errorCode, errorMessage, runId]);
  }
  async saveArtifact(artifact) {
    validateArtifactEnvelope(artifact);
    await this.database.executeQuery('INSERT OR REPLACE INTO ai_company_artifacts (artifact_id, run_id, artifact_type, schema_version, producer_agent_id, parent_artifact_ids_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [artifact.artifact_id, artifact.run_id, artifact.artifact_type, ARTIFACT_SCHEMA_VERSION, artifact.producer.agent_id, JSON.stringify(artifact.parent_artifact_ids || []), JSON.stringify(artifact.payload || {}), artifact.created_at]);
    return this.getArtifact(artifact.artifact_id);
  }
  async getArtifact(artifactId) { const row = await this.database.getRow('SELECT * FROM ai_company_artifacts WHERE artifact_id = ?', [artifactId]); return row ? this.parseArtifact(row) : null; }
  async saveDecision({ decisionId = `decision_\${crypto.randomUUID()}`, runId = null, decisionType, decision, rationale = {}, evidenceArtifactIds = [], confidence = 'low' }) {
    if (!decisionType || !decision) throw new Error('decisionType and decision are required');
    await this.database.executeQuery('INSERT INTO ai_company_decisions (decision_id, run_id, decision_type, decision, rationale, evidence_artifact_ids_json, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)', [decisionId, runId, decisionType, decision, JSON.stringify(rationale), JSON.stringify(evidenceArtifactIds), confidence]);
    return decisionId;
  }
  async setMemory(memoryKey, value, { sourceArtifactIds = [], confidence = 'low' } = {}) {
    if (!memoryKey) throw new Error('memoryKey is required');
    await this.database.executeQuery('INSERT INTO ai_company_channel_memory (memory_key, value_json, source_artifact_ids_json, confidence, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(memory_key) DO UPDATE SET value_json=excluded.value_json, source_artifact_ids_json=excluded.source_artifact_ids_json, confidence=excluded.confidence, updated_at=CURRENT_TIMESTAMP', [memoryKey, JSON.stringify(value), JSON.stringify(sourceArtifactIds), confidence]);
  }
  async getMemory(memoryKey) {
    const row = await this.database.getRow('SELECT * FROM ai_company_channel_memory WHERE memory_key = ?', [memoryKey]);
    if (!row) return null;
    return { key: row.memory_key, value: JSON.parse(row.value_json || '{}'), sourceArtifactIds: JSON.parse(row.source_artifact_ids_json || '[]'), confidence: row.confidence, updatedAt: row.updated_at };
  }
  async setReleaseGate({ gateId = `gate_\${crypto.randomUUID()}`, runId = null, productionId = null, status = 'pending', checks = [], blockingReasons = [] }) {
    await this.database.executeQuery('INSERT OR REPLACE INTO ai_company_release_gates (gate_id, run_id, production_id, status, checks_json, blocking_reasons_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [gateId, runId, productionId, status, JSON.stringify(checks), JSON.stringify(blockingReasons)]);
    return gateId;
  }
  parseAgent(row) { return { agentId: row.agent_id, layer: row.layer, role: row.role, status: row.status, capabilities: JSON.parse(row.capabilities_json || '[]'), config: JSON.parse(row.config_json || '{}'), createdAt: row.created_at, updatedAt: row.updated_at }; }
  parseArtifact(row) { return { artifactId: row.artifact_id, runId: row.run_id, artifactType: row.artifact_type, schemaVersion: Number(row.schema_version), producerAgentId: row.producer_agent_id, parentArtifactIds: JSON.parse(row.parent_artifact_ids_json || '[]'), payload: JSON.parse(row.payload_json || '{}'), createdAt: row.created_at }; }
}
module.exports = { AICompanyFoundationService, FOUNDATION_SCHEMA_VERSION };