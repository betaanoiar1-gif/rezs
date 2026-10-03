const AGENT_REGISTRY = Object.freeze([
  ['channel-ceo','ceo','Channel CEO / Orchestrator'],
  ['market-intelligence','intelligence','Market Intelligence'],
  ['competitor-intelligence','intelligence','Competitor Intelligence'],
  ['audience-psychologist','intelligence','Audience Psychologist'],
  ['trend-detection','intelligence','Trend Detection'],
  ['topic-research','intelligence','Topic Research'],
  ['idea-hunter','intelligence','Idea Hunter'],
  ['fact-checker','intelligence','Fact Checking'],
  ['content-strategist','strategy','Content Strategist'],
  ['topic-strategist','strategy','Topic Strategy'],
  ['hook-engineer','creative','Hook Engineer'],
  ['story-architect','creative','Story Architect'],
  ['creative-director','creative','Creative Director'],
  ['continuity-agent','creative','Continuity'],
  ['prompt-engineer','creative','Prompt Engineering'],
  ['brand-guardian','creative','Brand Guardian'],
  ['production-agent','production','Production'],
  ['editor-agent','production','Editor'],
  ['audio-director','production','Audio Director'],
  ['asset-librarian','production','Asset Librarian'],
  ['rights-provenance','qa','Rights / Provenance'],
  ['quality-control','qa','Quality Control'],
  ['duplicate-detector','qa','Duplicate / Similarity Detection'],
  ['safety-policy','qa','Safety / Policy'],
  ['release-gate','qa','Release Gate'],
  ['resource-manager','qa','Resource Manager'],
  ['cost-controller','qa','Cost Controller'],
  ['packaging-agent','publishing','Packaging'],
  ['thumbnail-director','publishing','Thumbnail Director'],
  ['publishing-agent','publishing','Publishing'],
  ['schedule-optimizer','publishing','Schedule Optimization'],
  ['community-agent','publishing','Community'],
  ['repurposing-agent','publishing','Content Repurposing'],
  ['performance-analyst','analytics','Performance Analytics'],
  ['retention-analyst','analytics','Retention Analytics'],
  ['audience-analytics','analytics','Audience Analytics'],
  ['failure-analyst','learning','Failure Analysis'],
  ['pattern-miner','learning','Pattern Mining'],
  ['channel-memory','learning','Channel Memory'],
  ['knowledge-memory','learning','Knowledge / Research Memory'],
  ['experimentation','learning','Experimentation'],
  ['experiment-manager','learning','Experiment Management'],
  ['content-lifecycle','learning','Content Lifecycle'],
  ['content-portfolio','learning','Content Portfolio'],
  ['decision-audit','learning','Decision Audit'],
  ['chief-learning-officer','learning','Chief Learning Officer']
]);

function registerAll(foundation) {
  return Promise.all(AGENT_REGISTRY.map(([agentId, layer, role]) =>
    foundation.registerAgent({ agentId, layer, role })
  ));
}

module.exports = { AGENT_REGISTRY, registerAll };
