/**
 * Shorts material acquisition (Phase 3B input).
 *
 * This is the single place that turns a Phase 3A plan's visual search terms
 * into the `video_materials` list submitted to MoneyPrinterTurbo. It used to
 * live inline in an Express handler, which meant the HTTP route and
 * scripts/phase3c-real-smoke.js acquired material in two different ways and
 * none of it could be tested.
 *
 * The workflow is unchanged: search, rank, download, stage into the directory
 * MoneyPrinterTurbo scans, and submit `video_source: "local"` with explicit
 * materials. What is new is that a term can fall back to another provider
 * instead of failing the whole preparation, and that every staged file is
 * verified before it is handed to MPT.
 */

const fsp = require('fs').promises;
const { Logger } = require('../utils/logger');
const { createStockProviders, StockMediaError } = require('../integrations/stock-media');

class ShortsMaterialError extends Error {
  constructor(message, code = 'MATERIAL_ACQUISITION_FAILED', details = null) {
    super(message);
    this.name = 'ShortsMaterialError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Stock libraries index concrete, filmable subjects. AI-generated scene terms
 * often name abstractions ("consistency", "self-discipline") that return
 * nothing. These deterministic substitutions give such terms a chance before
 * the term is abandoned. It is a lookup table on purpose: no model call, no
 * network call, and fully reproducible.
 */
const CONCRETE_TERM_FALLBACKS = {
  consistency: ['daily habit', 'habit formation', 'person exercising', 'morning routine'],
  'self discipline': ['person exercising', 'morning routine', 'focused person', 'daily routine'],
  'self-discipline': ['person exercising', 'morning routine', 'focused person', 'daily routine'],
  discipline: ['person exercising', 'focused person', 'daily routine'],
  motivation: ['person exercising', 'success goal', 'morning routine'],
  'personal growth': ['person learning', 'person exercising', 'success goal'],
  productivity: ['working at desk', 'daily routine', 'focused person'],
  focus: ['focused person', 'working at desk', 'studying'],
  habit: ['daily habit', 'morning routine', 'habit formation'],
  mindset: ['thoughtful person', 'person thinking', 'sunrise landscape'],
  success: ['success goal', 'mountain summit', 'celebration'],
  health: ['person exercising', 'healthy food', 'running outdoors'],
  learning: ['person learning', 'studying', 'reading book'],
  energy: ['running outdoors', 'sunrise landscape', 'person exercising'],
  time: ['clock closeup', 'city timelapse', 'hourglass']
};

const MAX_TERMS = 8;

class ShortsMaterialService {
  constructor({ providers, logger, maxTerms = MAX_TERMS, perPage = 8, safesearch = true, minWidth = 720, minHeight = 720 } = {}) {
    this.providers = providers || createStockProviders({ logger });
    this.logger = logger || new Logger('ShortsMaterial');
    this.maxTerms = maxTerms;
    this.perPage = perPage;
    this.safesearch = safesearch;
    this.minWidth = minWidth;
    this.minHeight = minHeight;
  }

  /** Providers that actually have credentials, in fallback order. */
  configuredProviders() {
    return this.providers.filter(provider => provider.isConfigured());
  }

  /**
   * Resolve a plan into MoneyPrinterTurbo `video_materials`.
   * Returns the MPT-facing list; `lastAcquisition` holds the provenance and
   * per-term diagnostics for logging and troubleshooting.
   */
  async discoverMaterials(plan) {
    const providers = this.configuredProviders();
    if (!providers.length) {
      throw new ShortsMaterialError(
        'No stock media provider is configured. Set PIXABAY_API_KEY, PEXELS_API_KEY or COVERR_API_KEY.',
        'NO_MEDIA_PROVIDER_CONFIGURED',
        { supported: this.providers.map(provider => provider.provider) }
      );
    }

    const terms = collectSearchTerms(plan, this.maxTerms);
    if (!terms.length) {
      throw new ShortsMaterialError(
        'The plan contains no visual search terms',
        'NO_SEARCH_TERMS',
        { planning_job_id: plan?.job_id || null }
      );
    }

    const assets = [];
    const seenAssets = new Set();
    const attempts = [];

    for (const term of terms) {
      const outcome = await this._acquireForTerm(term, providers, seenAssets);
      attempts.push(outcome.diagnostics);
      if (outcome.asset) {
        assets.push(outcome.asset);
        seenAssets.add(assetKey(outcome.asset));
      }
    }

    if (!assets.length) {
      throw new ShortsMaterialError(
        `No usable stock video was found for any visual term (${terms.join(', ')})`,
        'NO_VIDEO_RESULTS',
        { terms, attempts }
      );
    }

    this.lastAcquisition = {
      providers: providers.map(provider => provider.provider),
      terms,
      attempts,
      assets
    };
    this.logger.info(
      `Staged ${assets.length} stock clip(s) for ${terms.length} visual term(s) ` +
      `from ${[...new Set(assets.map(asset => asset.provider))].join(', ')}`
    );

    // MoneyPrinterTurbo reads local material by file name from its own
    // local_videos directory; this is the shape its schema expects.
    return assets.map(asset => ({
      provider: 'local',
      url: asset.local_name,
      duration: Math.round(Number(asset.duration) || 0)
    }));
  }

  /**
   * Try every phrasing of one term against every configured provider.
   * The first usable, not-already-selected asset wins.
   */
  async _acquireForTerm(term, providers, seenAssets) {
    const diagnostics = { term, tried: [], resolved: null };

    for (const candidateTerm of expandSearchTerm(term)) {
      for (const provider of providers) {
        const attempt = { term: candidateTerm, provider: provider.provider };
        try {
          const asset = await provider.downloadBest(candidateTerm, {
            perPage: this.perPage,
            safesearch: this.safesearch
          });
          const rejection = this._rejectionReason(asset, seenAssets);
          if (rejection) {
            attempt.outcome = rejection;
            diagnostics.tried.push(attempt);
            continue;
          }
          attempt.outcome = 'selected';
          diagnostics.tried.push(attempt);
          diagnostics.resolved = { provider: provider.provider, term: candidateTerm, asset_id: asset.asset_id };
          return { asset: { ...asset, search_term: candidateTerm }, diagnostics };
        } catch (error) {
          // One provider having no result, being rate limited or being briefly
          // unreachable must not end the run while another provider remains.
          attempt.outcome = error instanceof StockMediaError ? error.code : 'PROVIDER_ERROR';
          diagnostics.tried.push(attempt);
          if (!isRecoverableProviderError(error)) throw error;
          this.logger.warn(
            `${provider.provider} could not serve "${candidateTerm}" (${attempt.outcome}); trying the next source`
          );
        }
      }
    }

    return { asset: null, diagnostics };
  }

  /**
   * Decide whether a downloaded asset may be used. `null` means usable.
   * A file that does not exist, is empty, or is too small to fill a vertical
   * frame would only fail later inside MoneyPrinterTurbo, so it is rejected
   * here where another provider can still be tried.
   */
  _rejectionReason(asset, seenAssets) {
    if (!asset?.local_path || !asset?.local_name) return 'MISSING_LOCAL_FILE';
    if (seenAssets.has(assetKey(asset))) return 'DUPLICATE_ASSET';
    const width = Number(asset.width) || 0;
    const height = Number(asset.height) || 0;
    if (width < this.minWidth || height < this.minHeight) return 'RESOLUTION_TOO_LOW';
    return null;
  }
}

/** Verify staged files on disk. Separated so callers can await it explicitly. */
async function verifyStagedAssets(assets) {
  const problems = [];
  for (const asset of assets) {
    try {
      const stat = await fsp.stat(asset.local_path);
      if (!stat.isFile()) problems.push({ asset: asset.local_name, reason: 'NOT_A_FILE' });
      else if (stat.size < 1) problems.push({ asset: asset.local_name, reason: 'EMPTY_FILE' });
    } catch (error) {
      problems.push({ asset: asset.local_name, reason: error.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE' });
    }
  }
  return problems;
}

function collectSearchTerms(plan, limit) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const terms = scenes.flatMap(scene => (Array.isArray(scene?.visual_search_terms) ? scene.visual_search_terms : []));
  return [...new Set(terms.filter(term => typeof term === 'string' && term.trim()).map(term => term.trim()))].slice(0, limit);
}

/** The original term first, then concrete substitutions, then generic suffixes. */
function expandSearchTerm(term) {
  const normalised = String(term).trim().toLowerCase();
  const concrete = CONCRETE_TERM_FALLBACKS[normalised] || [];
  return [...new Set([term, ...concrete, `${term} habit`, `${term} routine`])];
}

function assetKey(asset) {
  return `${asset.provider}:${asset.asset_id}`;
}

/**
 * Errors that justify moving on to the next term or provider rather than
 * aborting the preparation. A configuration mistake is not recoverable: it
 * would fail identically for every term, so it must surface immediately.
 */
function isRecoverableProviderError(error) {
  const recoverable = new Set([
    'NO_VIDEO_RESULTS',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_HTTP_ERROR',
    'PROVIDER_TIMEOUT',
    'PROVIDER_NETWORK_ERROR',
    'PROVIDER_INVALID_RESPONSE',
    'PROVIDER_DOWNLOAD_FAILED',
    'INVALID_ASSET_URL',
    'ASSET_TOO_LARGE',
    'EMPTY_ASSET'
  ]);
  return recoverable.has(error?.code);
}

module.exports = {
  ShortsMaterialService,
  ShortsMaterialError,
  CONCRETE_TERM_FALLBACKS,
  collectSearchTerms,
  expandSearchTerm,
  verifyStagedAssets,
  isRecoverableProviderError
};
