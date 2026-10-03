const test = require('node:test');
const assert = require('node:assert/strict');
const { createArtifact, validateArtifactEnvelope } = require('../schemas/ai-company-artifacts');
const { AICompanyFoundationService } = require('../services/ai-company-foundation-service');

function mockDatabase() {
  const agents = new Map(), artifacts = new Map(), memories = new Map(), runs = new Map();
  return {
    async executeQuery(sql, params=[]) {
      const q=sql.replace(/\s+/g,' ').trim();
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return { changes:0 };
      if (q.startsWith('INSERT INTO ai_company_agents')) { agents.set(params[0], {agent_id:params[0],layer:params[1],role:params[2],capabilities_json:params[3],config_json:params[4],status:'active'}); return {changes:1}; }
      if (q.startsWith('INSERT INTO ai_company_runs')) { runs.set(params[0],{run_id:params[0],status:'running'}); return {changes:1}; }
      if (q.startsWith('INSERT OR REPLACE INTO ai_company_artifacts')) { artifacts.set(params[0],{artifact_id:params[0],run_id:params[1],artifact_type:params[2],schema_version:params[3],producer_agent_id:params[4],parent_artifact_ids_json:params[5],payload_json:params[6],created_at:params[7]}); return {changes:1}; }
      if (q.startsWith('INSERT INTO ai_company_channel_memory')) { memories.set(params[0],{memory_key:params[0],value_json:params[1],source_artifact_ids_json:params[2],confidence:params[3],updated_at:new Date().toISOString()}); return {changes:1}; }
      throw new Error('Unhandled mock query: '+q);
    },
    async getRow(sql, params=[]) {
      if (sql.includes('FROM ai_company_agents')) return agents.get(params[0]) || null;
      if (sql.includes('FROM ai_company_artifacts')) return artifacts.get(params[0]) || null;
      if (sql.includes('FROM ai_company_channel_memory')) return memories.get(params[0]) || null;
      return null;
    }
  };
}

test('artifact envelopes are strict and versioned', () => {
  const artifact=createArtifact({artifactId:'artifact_test',artifactType:'research',producer:{agent_id:'research-agent',layer:'intelligence'},payload:{topic:'discipline'}});
  assert.equal(validateArtifactEnvelope(artifact),true);
  assert.equal(artifact.schema_version,1);
  assert.equal(artifact.artifact_type,'research');
});

test('foundation persists agent, artifact and memory state', async () => {
  const foundation=new AICompanyFoundationService(mockDatabase());
  assert.equal((await foundation.initialize()).ready,true);
  await foundation.registerAgent({agentId:'research-agent',layer:'intelligence',role:'Topic Research',capabilities:['research']});
  const runId=await foundation.startRun({runType:'shorts_foundation_test'});
  const artifact=createArtifact({artifactId:'artifact_foundation_test',artifactType:'research',producer:{agent_id:'research-agent',layer:'intelligence'},runId,payload:{sources:[]}});
  await foundation.saveArtifact(artifact);
  await foundation.setMemory('channel.test',{enabled:true},{sourceArtifactIds:[artifact.artifact_id],confidence:'medium'});
  assert.equal((await foundation.getAgent('research-agent')).role,'Topic Research');
  assert.deepEqual((await foundation.getArtifact(artifact.artifact_id)).payload,{sources:[]});
  assert.deepEqual((await foundation.getMemory('channel.test')).value,{enabled:true});
});