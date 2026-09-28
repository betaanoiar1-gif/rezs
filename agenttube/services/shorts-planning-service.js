const crypto = require('crypto');
const { Logger } = require('../utils/logger');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');

const STATUSES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'FAILED']);

class PlanningError extends Error {
  constructor(message, code = 'PLANNING_FAILED', details = null) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.details = details;
  }
}

class ShortsPlanningService {
  constructor({ database, credentials, strategyAgent, scriptAgent, seoAgent, researchProvider = null, logger } = {}) {
    this.database = database;
    this.credentials = credentials;
    this.strategyAgent = strategyAgent || new ContentStrategyAgent(database, credentials);
    this.scriptAgent = scriptAgent || new ScriptWriterAgent(database, credentials);
    this.seoAgent = seoAgent || new SEOOptimizerAgent(database, credentials);
    this.researchProvider = researchProvider;
    this.logger = logger || new Logger('ShortsPlanning');
  }

  providerStatus() {
    const services = [this.strategyAgent, this.scriptAgent, this.seoAgent]
      .map(agent => agent?.aiTextService)
      .filter(Boolean);
    const available = services.length === 3 && services.every(service => service.isAvailable());
    return {
      available,
      provider: available ? services[0].providerName : null,
      model: available ? services[0].model : null
    };
  }

  async planTopic(topic) {
    const normalizedTopic = validateTopic(topic);
    const jobId = `short_plan_${crypto.randomUUID()}`;
    await this.database.createShortsPlanningJob({ job_id: jobId, topic: normalizedTopic, status: 'PENDING', stage: 'RECEIVED' });

    const provider = this.providerStatus();
    if (!provider.available) {
      const message = 'No AI text provider is configured. Run npm run credentials:setup and configure OpenAI, Gemini, OpenRouter, Kimi, MiMo, or GLM.';
      await this.database.updateShortsPlanningJob(jobId, { status: 'BLOCKED', stage: 'BLOCKED_AI_PROVIDER', error_code: 'AI_PROVIDER_UNAVAILABLE', error_message: message });
      throw new PlanningError(message, 'AI_PROVIDER_UNAVAILABLE', { job_id: jobId });
    }

    try {
      await this.database.updateShortsPlanningJob(jobId, { status: 'RUNNING', stage: 'RESEARCHING', provider: provider.provider, model: provider.model });
      const research = await this._research(normalizedTopic);

      await this.database.updateShortsPlanningJob(jobId, { stage: 'STRATEGIZING' });
      const strategy = await this.strategyAgent.generateContentStrategy(normalizedTopic);
      if (strategy?.metadata?.generationSource !== 'ai') {
        throw new PlanningError('AI strategy generation failed; refusing template fallback for autonomous planning', 'AI_GENERATION_FAILED');
      }
      strategy.requestedLength = '60-120 seconds, target 80-110 seconds';
      strategy.researchSources = research.sources;

      await this.database.updateShortsPlanningJob(jobId, { stage: 'WRITING_SCRIPT' });
      const script = await this.scriptAgent.generateScript(strategy);
      if (script?.metadata?.generationSource !== 'ai') {
        throw new PlanningError('AI script generation failed; refusing template fallback for autonomous planning', 'AI_GENERATION_FAILED');
      }

      await this.database.updateShortsPlanningJob(jobId, { stage: 'PLANNING_SCENES' });
      const narration = buildNarration(script);
      const scenes = buildScenes(script, strategy, narration);

      await this.database.updateShortsPlanningJob(jobId, { stage: 'GENERATING_METADATA' });
      const seo = await this.seoAgent.optimize(script, strategy);
      if (seo?.metadata?.generationSource !== 'ai') {
        throw new PlanningError('AI metadata generation failed; refusing template fallback for autonomous planning', 'AI_GENERATION_FAILED');
      }

      const estimatedDurationSeconds = estimateDuration(narration);
      const artifact = {
        schema_version: 1,
        job_id: jobId,
        topic: normalizedTopic,
        content_angle: strategy.angle,
        target_audience: strategy.targetAudience,
        content_type: strategy.contentType,
        research,
        hook: extractHook(script.hook),
        script: narration,
        estimated_duration_seconds: estimatedDurationSeconds,
        scenes,
        metadata: {
          title: seo.title,
          description: seo.description,
          hashtags: seo.hashtags,
          category: seo.metadata?.category
        },
        ai_provider: provider,
        warnings: research.sources.length ? [] : ['No factual research provider was available; this plan is not marked fact-checked.'],
        validation: null,
        created_at: new Date().toISOString()
      };
      artifact.validation = validateShortsPlan(artifact);
      await this.database.updateShortsPlanningJob(jobId, { status: 'SUCCEEDED', stage: 'PLANNED', artifact, error_code: null, error_message: null });
      return await this.database.getShortsPlanningJob(jobId);
    } catch (error) {
      const normalized = error instanceof PlanningError ? error : new PlanningError(error.message || 'Planning generation failed');
      await this.database.updateShortsPlanningJob(jobId, { status: 'FAILED', stage: 'FAILED', error_code: normalized.code, error_message: normalized.message });
      normalized.details = { ...(normalized.details || {}), job_id: jobId };
      throw normalized;
    }
  }

  async _research(topic) {
    if (!this.researchProvider) return { available: false, claimed_verified: false, sources: [], findings: [] };
    const result = await this.researchProvider.research(topic);
    const research = {
      available: true,
      claimed_verified: Boolean(result?.claimed_verified),
      sources: Array.isArray(result?.sources) ? result.sources : [],
      findings: Array.isArray(result?.findings) ? result.findings : []
    };
    validateResearch(research);
    return research;
  }
}

function validateTopic(topic) {
  if (typeof topic !== 'string' || !topic.trim()) throw new PlanningError('topic must be a non-empty string', 'INVALID_TOPIC');
  return topic.trim().slice(0, 500);
}

function extractHook(hook) {
  return String(typeof hook === 'object' ? hook?.text || '' : hook || '').trim();
}

function textFrom(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(' ');
  for (const key of ['text', 'summary', 'content', 'subscribe']) if (value[key]) return textFrom(value[key]);
  return '';
}

function scriptSegments(script) {
  const hook = extractHook(script?.hook);
  const sections = (script?.mainContent?.sections || []).map(section => ({
    title: String(section.title || 'Explanation').trim(),
    text: textFrom(section.content)
  })).filter(section => section.text);
  const tail = [
    { title: 'Conclusion', text: textFrom(script?.conclusion) },
    { title: 'Call to action', text: textFrom(script?.callToAction) }
  ].filter(section => section.text);
  return [{ title: 'Hook', text: hook }, ...sections, ...tail].filter(section => section.text);
}

function buildNarration(script) { return scriptSegments(script).map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim(); }
function estimateDuration(script) { return Math.round((script.split(/\s+/).filter(Boolean).length / 150) * 60 * 10) / 10; }

function buildScenes(script, strategy, narration) {
  const segments = scriptSegments(script);
  const totalWords = Math.max(1, narration.split(/\s+/).filter(Boolean).length);
  const totalDuration = estimateDuration(narration);
  let cursor = 0;
  return segments.map((segment, index) => {
    const words = segment.text.split(/\s+/).filter(Boolean).length;
    const duration = index === segments.length - 1 ? Math.max(0.1, totalDuration - cursor) : Math.max(0.1, Math.round((totalDuration * words / totalWords) * 10) / 10);
    const scene = {
      scene_id: index + 1,
      start_seconds: Math.round(cursor * 10) / 10,
      duration_seconds: Math.round(duration * 10) / 10,
      script_segment: segment.text,
      visual_description: `Show a clear, directly relevant visual explanation of ${segment.title}: ${segment.text.slice(0, 180)}`,
      visual_search_terms: [...new Set([...(strategy.keywords || []), ...segment.title.toLowerCase().split(/\W+/).filter(word => word.length > 2)])].slice(0, 8)
    };
    cursor += duration;
    return scene;
  });
}

function validateResearch(research) {
  for (const source of research.sources || []) {
    if (!source || !source.url || !source.title) throw new PlanningError('Research sources require title and URL', 'INVALID_SOURCE');
    let url;
    try { url = new URL(source.url); } catch { throw new PlanningError('Research source URL is malformed', 'INVALID_SOURCE'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new PlanningError('Research source URL must use HTTP or HTTPS', 'INVALID_SOURCE');
  }
  if (research.claimed_verified && !(research.sources || []).length) throw new PlanningError('Verified research cannot be claimed without source records', 'UNSUPPORTED_RESEARCH_CLAIM');
}

function validateShortsPlan(plan) {
  if (!plan?.topic?.trim()) throw new PlanningError('Plan topic is missing', 'INVALID_PLAN');
  if (!plan?.script?.trim()) throw new PlanningError('Plan script is missing', 'INVALID_SCRIPT');
  if (!plan?.hook?.trim()) throw new PlanningError('Plan hook is missing', 'MISSING_HOOK');
  if (!Array.isArray(plan.scenes) || !plan.scenes.length) throw new PlanningError('Plan scene list is missing', 'MISSING_SCENES');
  const duration = Number(plan.estimated_duration_seconds);
  if (!Number.isFinite(duration) || duration < 60 || duration > 120) throw new PlanningError('Estimated narration duration must be between 60 and 120 seconds', 'INVALID_DURATION');
  if (!plan.metadata?.title?.trim() || !plan.metadata?.description?.trim() || !Array.isArray(plan.metadata?.hashtags) || !plan.metadata.hashtags.length || !plan.metadata?.category) {
    throw new PlanningError('Title, description, hashtags, and category are required', 'INVALID_METADATA');
  }
  validateResearch(plan.research || { sources: [], claimed_verified: false });
  return { passed: true, checks: ['topic', 'script', 'hook', 'scenes', 'duration', 'metadata', 'source_provenance'] };
}

module.exports = { ShortsPlanningService, PlanningError, validateTopic, validateResearch, validateShortsPlan, buildNarration, buildScenes, estimateDuration, STATUSES };
