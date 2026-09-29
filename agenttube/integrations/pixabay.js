const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Logger } = require('../utils/logger');

const API_BASE = 'https://pixabay.com/api/videos/';

class PixabayError extends Error {
  constructor(message, code = 'PIXABAY_ERROR', details = null) {
    super(message);
    this.name = 'PixabayError';
    this.code = code;
    this.details = details;
  }
}

class PixabayVideoClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || process.env.PIXABAY_API_KEY || '').trim();
    this.fetch = options.fetch || globalThis.fetch;
    this.downloadDirectory = path.resolve(options.downloadDirectory || process.env.REZS_MPT_LOCAL_VIDEOS_DIR || path.resolve(__dirname, '../../moneyprinterturbo/storage/local_videos'));
    this.searchCacheDirectory = path.resolve(options.searchCacheDirectory || path.join(this.downloadDirectory, '.pixabay-search-cache'));
    this.searchCacheTtlMs = Number(options.searchCacheTtlMs || 24 * 60 * 60 * 1000);
    this.logger = options.logger || new Logger('Pixabay');
    if (typeof this.fetch !== 'function') throw new PixabayError('A fetch implementation is required', 'CONFIG_ERROR');
  }

  async search(query, { perPage = 8, safesearch = true } = {}) {
    if (!this.apiKey) throw new PixabayError('PIXABAY_API_KEY is required', 'PIXABAY_API_KEY_MISSING');
    if (typeof query !== 'string' || !query.trim()) throw new PixabayError('A Pixabay search query is required', 'INVALID_QUERY');
    const params = new URLSearchParams({
      key: this.apiKey, q: query.trim().slice(0, 100), lang: 'en',
      video_type: 'all', safesearch: String(Boolean(safesearch)),
      min_width: '720', min_height: '405', order: 'popular',
      per_page: String(Math.min(20, Math.max(3, perPage)))
    });
    await fsp.mkdir(this.searchCacheDirectory, { recursive: true });
    const cacheKey = crypto.createHash('sha256').update(params.toString()).digest('hex');
    const cachePath = path.join(this.searchCacheDirectory, `${cacheKey}.json`);
    const cached = await this._readSearchCache(cachePath);
    if (cached) return cached;
    const response = await this.fetch(`${API_BASE}?${params}`);
    if (!response.ok) throw new PixabayError(`Pixabay search failed with HTTP ${response.status}`, 'PIXABAY_HTTP_ERROR', { status: response.status });
    const data = await response.json();
    const hits = Array.isArray(data.hits) ? data.hits : [];
    await fsp.writeFile(cachePath, JSON.stringify({ cached_at: Date.now(), query: query.trim(), hits }), 'utf8');
    return hits;
  }

  async downloadBest(query, options = {}) {
    const hits = await this.search(query, options);
    const ranked = hits.filter(hit => hit?.videos?.medium?.url || hit?.videos?.large?.url).map(hit => {
      const variants = [hit.videos.large, hit.videos.medium, hit.videos.small].filter(v => v?.url);
      const chosen = variants.find(v => Number(v.width) >= 1280) || variants[0];
      return { hit, chosen, score: scoreVideo(hit, chosen, query) };
    }).sort((a, b) => b.score - a.score);
    if (!ranked.length) throw new PixabayError(`No usable Pixabay video found for "${query}"`, 'NO_VIDEO_RESULTS');
    return this.download(ranked[0].hit, ranked[0].chosen);
  }

  async download(hit, variant) {
    const sourceUrl = String(variant?.url || '').trim();
    if (!sourceUrl) throw new PixabayError('Pixabay video URL is missing', 'INVALID_VIDEO_URL');
    await fsp.mkdir(this.downloadDirectory, { recursive: true });
    const target = path.join(this.downloadDirectory, `pixabay-${String(hit.id)}.mp4`);
    if (await this._hasUsableFile(target)) return provenance(hit, variant, target);
    const response = await this.fetch(sourceUrl);
    if (!response.ok) throw new PixabayError(`Pixabay download failed with HTTP ${response.status}`, 'PIXABAY_DOWNLOAD_FAILED', { status: response.status });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new PixabayError('Pixabay returned an empty video', 'EMPTY_VIDEO');
    const temporary = `${target}.${crypto.randomUUID()}.part`;
    try {
      await fsp.writeFile(temporary, bytes, { flag: 'wx' });
      await fsp.rename(temporary, target);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
    return provenance(hit, variant, target);
  }

  /**
   * Read a cached search result. A missing or expired entry is a normal cache
   * miss and returns null. An unreadable or corrupt entry is also treated as a
   * miss so a poisoned cache file can never block a live search, but it is
   * logged so the condition stays observable instead of silently swallowed.
   */
  async _readSearchCache(cachePath) {
    let raw;
    try {
      raw = await fsp.readFile(cachePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`Pixabay search cache unreadable (${error.code || 'unknown'}); performing a live search`);
      }
      return null;
    }
    try {
      const cached = JSON.parse(raw);
      if (cached && Number(cached.cached_at) + this.searchCacheTtlMs > Date.now() && Array.isArray(cached.hits)) {
        return cached.hits;
      }
      return null;
    } catch (error) {
      this.logger.warn(`Pixabay search cache is corrupt (${error.message}); performing a live search`);
      return null;
    }
  }

  /**
   * Report whether a previously downloaded asset can be reused. Only ENOENT
   * means "not downloaded yet"; any other stat failure is a real filesystem
   * problem and must surface rather than trigger a silent re-download.
   */
  async _hasUsableFile(target) {
    try {
      const stat = await fsp.stat(target);
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new PixabayError(
        `Cannot inspect cached Pixabay asset: ${error.code || error.message}`,
        'LOCAL_STORAGE_ERROR',
        { path: target }
      );
    }
  }
}

function scoreVideo(hit, variant, query) {
  const tags = String(hit?.tags || '').toLowerCase();
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const relevance = terms.reduce((n, term) => n + (tags.includes(term) ? 4 : 0), 0);
  const resolution = Math.min(Number(variant?.width || 0) / 1000, 4);
  const popularity = Math.log1p(Number(hit?.views || 0)) / 10;
  return relevance + resolution + popularity;
}

function provenance(hit, variant, localPath) {
  return {
    provider: 'pixabay', asset_id: String(hit.id),
    page_url: hit.pageURL || `https://pixabay.com/videos/id-${hit.id}/`,
    creator: hit.user || null, tags: hit.tags || '',
    duration: Number(hit.duration || 0), source_url: variant.url,
    width: Number(variant.width || 0), height: Number(variant.height || 0),
    local_path: localPath, local_name: path.basename(localPath)
  };
}

module.exports = { PixabayVideoClient, PixabayError };
