/**
 * Normalised stock-video providers for Shorts material acquisition.
 *
 * MoneyPrinterTurbo already speaks Pexels, Pixabay and Coverr natively
 * (app/services/material.py). REZS stages material itself so it can attach
 * provenance and submit `video_source: "local"`, so the same three providers
 * are implemented here against the request and response shapes MPT uses, which
 * are the authoritative reference for these APIs in this repository.
 *
 * Every client exposes the same small contract:
 *
 *   isConfigured()            -> boolean
 *   search(query, options)    -> [candidate]
 *   downloadBest(query, opts) -> asset provenance record
 *
 * A candidate is provider-agnostic:
 *
 *   { asset_id, page_url, creator, tags, duration, url, width, height }
 *
 * API keys are read from the environment, are never written to disk, never
 * appear in cache files, and never reach a log line or an error message.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Logger } = require('../utils/logger');

const DEFAULT_SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ASSET_BYTES = 96 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 20000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;

class StockMediaError extends Error {
  constructor(message, code = 'STOCK_MEDIA_ERROR', details = null) {
    super(message);
    this.name = 'StockMediaError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Shared search-cache, ranking, download and safety behaviour. Subclasses only
 * describe how to talk to one provider.
 */
class StockVideoClient {
  constructor(options = {}) {
    this.provider = options.provider;
    this.apiKey = String(options.apiKey || '').trim();
    this.fetch = options.fetch || globalThis.fetch;
    this.downloadDirectory = path.resolve(
      options.downloadDirectory ||
      process.env.REZS_MPT_LOCAL_VIDEOS_DIR ||
      path.resolve(__dirname, '../../moneyprinterturbo/storage/local_videos')
    );
    // The search cache is REZS bookkeeping, not material. Keep it out of the
    // directory MoneyPrinterTurbo scans for local video files.
    this.searchCacheDirectory = path.resolve(
      options.searchCacheDirectory ||
      process.env.REZS_STOCK_SEARCH_CACHE_DIR ||
      path.resolve(__dirname, '..', 'data', 'stock-search-cache')
    );
    this.searchCacheTtlMs = numberOr(options.searchCacheTtlMs, DEFAULT_SEARCH_TTL_MS);
    this.maxAssetBytes = numberOr(options.maxAssetBytes ?? process.env.REZS_STOCK_MAX_ASSET_BYTES, DEFAULT_MAX_ASSET_BYTES);
    this.searchTimeoutMs = numberOr(options.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
    this.downloadTimeoutMs = numberOr(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
    this.logger = options.logger || new Logger(`Stock:${this.provider}`);
    if (typeof this.fetch !== 'function') {
      throw new StockMediaError('A fetch implementation is required', 'CONFIG_ERROR', { provider: this.provider });
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /** Subclasses return { url, headers } for a search. */
  _buildRequest() {
    throw new StockMediaError('Provider does not implement _buildRequest', 'CONFIG_ERROR');
  }

  /** Subclasses turn a provider payload into normalised candidates. */
  _parseHits() {
    throw new StockMediaError('Provider does not implement _parseHits', 'CONFIG_ERROR');
  }

  /** Hostnames this provider is allowed to serve media from. */
  _allowedHosts() {
    return [];
  }

  async search(query, options = {}) {
    if (!this.isConfigured()) {
      throw new StockMediaError(
        `${this.provider} API key is not configured`,
        'PROVIDER_NOT_CONFIGURED',
        { provider: this.provider }
      );
    }
    const term = normaliseQuery(query);
    const request = this._buildRequest(term, options);

    // The cache key covers the provider and the full request URL, but the URL
    // may embed the API key (Pixabay), so only the digest is ever persisted.
    const cachePath = path.join(
      this.searchCacheDirectory,
      `${this.provider}-${crypto.createHash('sha256').update(`${this.provider}:${request.url}`).digest('hex')}.json`
    );
    const cached = await this._readSearchCache(cachePath);
    if (cached) return cached;

    const response = await this._fetchWithTimeout(request.url, { headers: request.headers }, this.searchTimeoutMs, 'search');
    if (!response.ok) {
      throw new StockMediaError(
        `${this.provider} search failed with HTTP ${response.status}`,
        response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
        { provider: this.provider, status: response.status }
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new StockMediaError(
        `${this.provider} returned a non-JSON search response`,
        'PROVIDER_INVALID_RESPONSE',
        { provider: this.provider, reason: error.message }
      );
    }

    const candidates = this._parseHits(payload).filter(candidate => this._isUsableCandidate(candidate));
    await this._writeSearchCache(cachePath, term, candidates);
    return candidates;
  }

  /**
   * Rank the results for a term and download the best usable one.
   * Throws NO_VIDEO_RESULTS when the provider has nothing usable, which the
   * caller treats as "try the next term or the next provider".
   */
  async downloadBest(query, options = {}) {
    const term = normaliseQuery(query);
    const candidates = await this.search(term, options);
    const ranked = candidates
      .map(candidate => ({ candidate, score: scoreCandidate(candidate, term) }))
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) {
      throw new StockMediaError(
        `No usable ${this.provider} video found for "${term}"`,
        'NO_VIDEO_RESULTS',
        { provider: this.provider, term }
      );
    }
    return this.download(ranked[0].candidate);
  }

  async download(candidate) {
    const sourceUrl = this._assertSafeMediaUrl(candidate?.url);
    await fsp.mkdir(this.downloadDirectory, { recursive: true });
    const target = path.join(this.downloadDirectory, assetFileName(this.provider, candidate.asset_id));

    // Re-downloading an asset REZS already staged wastes bandwidth and can
    // race with a concurrent job, so a complete local copy is reused.
    const existing = await statOrNull(target);
    if (existing?.isFile() && existing.size > 0) {
      return provenanceRecord(this.provider, candidate, target, existing.size);
    }

    const response = await this._fetchWithTimeout(sourceUrl, {}, this.downloadTimeoutMs, 'download');
    if (!response.ok) {
      throw new StockMediaError(
        `${this.provider} download failed with HTTP ${response.status}`,
        'PROVIDER_DOWNLOAD_FAILED',
        { provider: this.provider, status: response.status }
      );
    }

    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > this.maxAssetBytes) {
      throw new StockMediaError(
        `${this.provider} asset exceeds the ${this.maxAssetBytes} byte limit`,
        'ASSET_TOO_LARGE',
        { provider: this.provider, bytes: declared }
      );
    }

    // A unique temporary name plus an atomic rename means a crashed or
    // truncated download can never be observed as a usable material file.
    const temporary = `${target}.${crypto.randomUUID()}.part`;
    let written = 0;
    try {
      written = await this._writeBody(response, temporary);
      if (!written) {
        throw new StockMediaError(`${this.provider} returned an empty video`, 'EMPTY_ASSET', { provider: this.provider });
      }
      await fsp.rename(temporary, target);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {
        this.logger.warn(`Could not remove the temporary ${this.provider} download file`);
      });
    }
    return provenanceRecord(this.provider, candidate, target, written);
  }

  /**
   * Stream the response to disk, enforcing the size cap as bytes arrive.
   * Buffering the whole asset first would let a hostile or broken provider
   * exhaust memory before any limit could be applied.
   */
  async _writeBody(response, temporary) {
    const handle = await fsp.open(temporary, 'wx');
    let written = 0;
    try {
      if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of response.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          written += buffer.length;
          if (written > this.maxAssetBytes) {
            throw new StockMediaError(
              `${this.provider} asset exceeds the ${this.maxAssetBytes} byte limit`,
              'ASSET_TOO_LARGE',
              { provider: this.provider }
            );
          }
          await handle.write(buffer);
        }
      } else {
        // Test doubles and older runtimes expose arrayBuffer() only.
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > this.maxAssetBytes) {
          throw new StockMediaError(
            `${this.provider} asset exceeds the ${this.maxAssetBytes} byte limit`,
            'ASSET_TOO_LARGE',
            { provider: this.provider }
          );
        }
        written = buffer.length;
        if (written) await handle.write(buffer);
      }
    } finally {
      await handle.close();
    }
    return written;
  }

  /**
   * Media URLs come from a third-party JSON payload, so they are untrusted
   * input. Only HTTPS on a known provider host is fetched; anything else could
   * turn a search result into a server-side request forgery primitive.
   */
  _assertSafeMediaUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      throw new StockMediaError(`${this.provider} candidate has no media URL`, 'INVALID_ASSET_URL', { provider: this.provider });
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new StockMediaError(`${this.provider} media URL is malformed`, 'INVALID_ASSET_URL', { provider: this.provider });
    }
    if (url.protocol !== 'https:') {
      throw new StockMediaError(`${this.provider} media URL must use HTTPS`, 'INVALID_ASSET_URL', { provider: this.provider });
    }
    const allowed = this._allowedHosts();
    const host = url.hostname.toLowerCase();
    const permitted = allowed.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    if (!permitted) {
      throw new StockMediaError(
        `${this.provider} media URL host is not allowed`,
        'INVALID_ASSET_URL',
        { provider: this.provider, host }
      );
    }
    return url.toString();
  }

  async _fetchWithTimeout(url, init, timeoutMs, stage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new StockMediaError(
        timedOut ? `${this.provider} ${stage} timed out` : `${this.provider} ${stage} request failed`,
        timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
        { provider: this.provider, stage }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async _readSearchCache(cachePath) {
    let raw;
    try {
      raw = await fsp.readFile(cachePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`${this.provider} search cache unreadable (${error.code || 'unknown'}); searching live`);
      }
      return null;
    }
    try {
      const cached = JSON.parse(raw);
      if (cached && Number(cached.cached_at) + this.searchCacheTtlMs > Date.now() && Array.isArray(cached.candidates)) {
        return cached.candidates;
      }
      return null;
    } catch (error) {
      this.logger.warn(`${this.provider} search cache is corrupt (${error.message}); searching live`);
      return null;
    }
  }

  async _writeSearchCache(cachePath, term, candidates) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        cachePath,
        JSON.stringify({ provider: this.provider, term, cached_at: Date.now(), candidates }),
        'utf8'
      );
    } catch (error) {
      // A cache that cannot be written must never fail a search.
      this.logger.warn(`${this.provider} search cache write failed (${error.code || error.message})`);
    }
  }

  /** Reject results that cannot produce a usable Shorts clip. */
  _isUsableCandidate(candidate) {
    if (!candidate || !candidate.url || !candidate.asset_id) return false;
    const width = Number(candidate.width) || 0;
    const height = Number(candidate.height) || 0;
    return width > 0 && height > 0;
  }
}

class PixabayStockClient extends StockVideoClient {
  constructor(options = {}) {
    super({ ...options, provider: 'pixabay', apiKey: options.apiKey ?? process.env.PIXABAY_API_KEY });
  }

  _allowedHosts() {
    return ['pixabay.com', 'cdn.pixabay.com'];
  }

  _buildRequest(term, options = {}) {
    const params = new URLSearchParams({
      key: this.apiKey,
      q: term.slice(0, 100),
      lang: 'en',
      video_type: 'all',
      safesearch: String(options.safesearch !== false),
      min_width: '720',
      min_height: '405',
      order: 'popular',
      per_page: String(perPage(options.perPage))
    });
    return { url: `https://pixabay.com/api/videos/?${params}`, headers: {} };
  }

  _parseHits(payload) {
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];
    return hits.map(hit => {
      const videos = hit?.videos || {};
      const variants = [videos.large, videos.medium, videos.small].filter(variant => variant?.url);
      const chosen = variants.find(variant => Number(variant.width) >= 1280) || variants[0];
      if (!chosen) return null;
      return {
        asset_id: String(hit.id),
        page_url: hit.pageURL || `https://pixabay.com/videos/id-${hit.id}/`,
        creator: hit.user || null,
        tags: String(hit.tags || ''),
        views: Number(hit.views || 0),
        duration: Number(hit.duration || 0),
        url: chosen.url,
        width: Number(chosen.width || 0),
        height: Number(chosen.height || 0)
      };
    }).filter(Boolean);
  }
}

class PexelsStockClient extends StockVideoClient {
  constructor(options = {}) {
    super({ ...options, provider: 'pexels', apiKey: options.apiKey ?? process.env.PEXELS_API_KEY });
  }

  _allowedHosts() {
    return ['pexels.com', 'videos.pexels.com', 'player.vimeo.com'];
  }

  _buildRequest(term, options = {}) {
    const params = new URLSearchParams({
      query: term.slice(0, 100),
      per_page: String(perPage(options.perPage)),
      orientation: options.orientation || 'portrait'
    });
    return {
      url: `https://api.pexels.com/v1/videos/search?${params}`,
      headers: { Authorization: this.apiKey }
    };
  }

  _parseHits(payload) {
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    return videos.map(video => {
      const files = Array.isArray(video?.video_files) ? video.video_files : [];
      const usable = files
        .filter(file => typeof file?.link === 'string' && Number(file.width) > 0 && Number(file.height) > 0)
        .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height));
      // Prefer the largest vertical rendition; fall back to the largest overall.
      const chosen = usable.find(file => Number(file.height) > Number(file.width)) || usable[0];
      if (!chosen) return null;
      return {
        asset_id: String(video.id),
        page_url: typeof video.url === 'string' ? video.url : null,
        creator: video?.user?.name || null,
        tags: String(video?.tags || ''),
        views: 0,
        duration: Number(video.duration || 0),
        url: chosen.link,
        width: Number(chosen.width || 0),
        height: Number(chosen.height || 0)
      };
    }).filter(Boolean);
  }
}

class CoverrStockClient extends StockVideoClient {
  constructor(options = {}) {
    super({ ...options, provider: 'coverr', apiKey: options.apiKey ?? process.env.COVERR_API_KEY });
  }

  _allowedHosts() {
    return ['coverr.co', 'api.coverr.co', 'storage.coverr.co', 'cdn.coverr.co'];
  }

  _buildRequest(term, options = {}) {
    const params = new URLSearchParams({
      query: term.slice(0, 100),
      page_size: String(perPage(options.perPage)),
      urls: 'true',
      sort: 'popular'
    });
    // Coverr can filter vertically server-side, which is what a Short needs.
    if (options.orientation !== 'landscape') params.set('filter', 'is_vertical:true');
    return {
      url: `https://api.coverr.co/videos?${params}`,
      headers: { Authorization: `Bearer ${this.apiKey}` }
    };
  }

  _parseHits(payload) {
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];
    return hits.map(hit => {
      const downloadUrl = hit?.urls?.mp4_download || hit?.urls?.mp4;
      if (!hit?.id || typeof downloadUrl !== 'string') return null;
      return {
        asset_id: String(hit.id),
        page_url: hit.canonical_url || hit.url || null,
        creator: hit?.creator?.name || hit?.author || null,
        tags: Array.isArray(hit.tags) ? hit.tags.join(' ') : String(hit.tags || ''),
        views: 0,
        duration: Number.parseFloat(hit.duration) || 0,
        url: downloadUrl,
        width: Number(hit.max_width || 0),
        height: Number(hit.max_height || 0)
      };
    }).filter(Boolean);
  }
}

const PROVIDER_CLIENTS = {
  pixabay: PixabayStockClient,
  pexels: PexelsStockClient,
  coverr: CoverrStockClient
};

const DEFAULT_PROVIDER_ORDER = ['pixabay', 'pexels', 'coverr'];

/**
 * Build the ordered provider chain. Unknown names are reported rather than
 * ignored, so a typo in REZS_STOCK_PROVIDER_ORDER cannot silently disable a
 * provider the operator believes is active.
 */
function resolveProviderOrder(configured) {
  const raw = String(configured ?? process.env.REZS_STOCK_PROVIDER_ORDER ?? '').trim();
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];
  const requested = raw.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  const unknown = requested.filter(name => !PROVIDER_CLIENTS[name]);
  if (unknown.length) {
    throw new StockMediaError(
      `Unknown stock media provider(s): ${unknown.join(', ')}`,
      'CONFIG_ERROR',
      { supported: Object.keys(PROVIDER_CLIENTS) }
    );
  }
  return [...new Set(requested)];
}

/** Instantiate the configured providers in fallback order. */
function createStockProviders(options = {}) {
  return resolveProviderOrder(options.order).map(name => new PROVIDER_CLIENTS[name]({
    ...options,
    apiKey: options.apiKeys?.[name],
    logger: options.logger
  }));
}

function scoreCandidate(candidate, term) {
  const tags = String(candidate?.tags || '').toLowerCase();
  const words = String(term).toLowerCase().split(/\s+/).filter(Boolean);
  const relevance = words.reduce((total, word) => total + (tags.includes(word) ? 4 : 0), 0);
  const resolution = Math.min(Number(candidate?.width || 0) / 1000, 4);
  const popularity = Math.log1p(Number(candidate?.views || 0)) / 10;
  // A vertical source needs no cropping for a 9:16 Short.
  const vertical = Number(candidate?.height || 0) > Number(candidate?.width || 0) ? 1.5 : 0;
  return relevance + resolution + popularity + vertical;
}

function provenanceRecord(provider, candidate, localPath, size) {
  return {
    provider,
    asset_id: String(candidate.asset_id),
    page_url: candidate.page_url || null,
    creator: candidate.creator || null,
    tags: candidate.tags || '',
    duration: Number(candidate.duration || 0),
    source_url: candidate.url,
    width: Number(candidate.width || 0),
    height: Number(candidate.height || 0),
    local_path: localPath,
    local_name: path.basename(localPath),
    file_size: Number(size || 0)
  };
}

function assetFileName(provider, assetId) {
  // Provider IDs reach the filesystem, so restrict them to a safe alphabet.
  const safeId = String(assetId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'asset';
  return `${provider}-${safeId}.mp4`;
}

function normaliseQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new StockMediaError('A stock media search query is required', 'INVALID_QUERY');
  }
  return query.trim();
}

function perPage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(20, Math.max(3, Math.trunc(number))) : 8;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StockMediaError(
      `Cannot inspect staged stock asset: ${error.code || error.message}`,
      'LOCAL_STORAGE_ERROR',
      { path: target }
    );
  }
}

module.exports = {
  StockMediaError,
  StockVideoClient,
  PixabayStockClient,
  PexelsStockClient,
  CoverrStockClient,
  PROVIDER_CLIENTS,
  DEFAULT_PROVIDER_ORDER,
  resolveProviderOrder,
  createStockProviders,
  scoreCandidate,
  assetFileName
};
