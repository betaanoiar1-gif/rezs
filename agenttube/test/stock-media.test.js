const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const {
  PixabayStockClient,
  PexelsStockClient,
  CoverrStockClient,
  StockMediaError,
  resolveProviderOrder,
  createStockProviders,
  assetFileName
} = require('../integrations/stock-media');

/** Every client needs isolated download and cache directories per test. */
async function scratch(t, prefix) {
  const downloadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-dl-`));
  const searchCacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-cache-`));
  t.after(() => Promise.all([
    fs.rm(downloadDirectory, { recursive: true, force: true }),
    fs.rm(searchCacheDirectory, { recursive: true, force: true })
  ]));
  return { downloadDirectory, searchCacheDirectory };
}

function body(bytes = 'fixture-video') {
  return { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from(bytes) };
}

/* ------------------------------- Pixabay -------------------------------- */

test('Pixabay search sends safesearch and the encoded query', async t => {
  const dirs = await scratch(t, 'pixabay');
  let requested;
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => {
      requested = String(url);
      return { ok: true, json: async () => ({ hits: [
        { id: 7, tags: 'ocean water', videos: { medium: { url: 'https://cdn.pixabay.com/video.mp4', width: 1920, height: 1080 } } }
      ] }) };
    }
  });
  const candidates = await client.search('ocean water');
  assert.equal(candidates.length, 1);
  assert.match(requested, /safesearch=true/);
  // URLSearchParams encodes the space as "+"; escape it so the assertion is
  // not silently reinterpreted as "one or more n".
  assert.match(requested, /q=ocean\+water/);
  assert.equal(candidates[0].asset_id, '7');
});

test('Pixabay ranks resolution above view count and reuses the staged file', async t => {
  const dirs = await scratch(t, 'pixabay-rank');
  let downloads = 0;
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => {
      if (String(url).includes('/api/videos/')) {
        return { ok: true, json: async () => ({ hits: [
          { id: 1, tags: 'forest city', views: 10, videos: { medium: { url: 'https://cdn.pixabay.com/a.mp4', width: 1920, height: 1080 } } },
          { id: 2, tags: 'forest', views: 1000, videos: { medium: { url: 'https://cdn.pixabay.com/b.mp4', width: 1280, height: 720 } } }
        ] }) };
      }
      downloads += 1;
      return body();
    }
  });
  const first = await client.downloadBest('forest');
  const second = await client.downloadBest('forest');
  // MoneyPrinterTurbo drops material below its minimum dimension when building
  // a 1080x1920 Short, so pixels must outrank popularity.
  assert.equal(first.local_name, 'pixabay-1.mp4');
  assert.equal(first.width, 1920);
  assert.equal(second.local_name, first.local_name);
  assert.equal(downloads, 1, 'an already staged asset is not downloaded again');
});

test('Pixabay ranks tag relevance above raw resolution', async t => {
  const dirs = await scratch(t, 'pixabay-relevance');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 10, tags: 'desert sand', views: 10, videos: { large: { url: 'https://cdn.pixabay.com/x.mp4', width: 3840, height: 2160 } } },
        { id: 11, tags: 'forest trees', views: 10, videos: { large: { url: 'https://cdn.pixabay.com/y.mp4', width: 1920, height: 1080 } } }
      ] }) }
      : body()
  });
  assert.equal((await client.downloadBest('forest')).local_name, 'pixabay-11.mp4');
});

test('Pixabay prefers a vertical source for a 9:16 Short', async t => {
  const dirs = await scratch(t, 'pixabay-vertical');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 20, tags: 'forest', views: 10, videos: { large: { url: 'https://cdn.pixabay.com/h.mp4', width: 1920, height: 1080 } } },
        { id: 21, tags: 'forest', views: 10, videos: { large: { url: 'https://cdn.pixabay.com/v.mp4', width: 1080, height: 1920 } } }
      ] }) }
      : body()
  });
  assert.equal((await client.downloadBest('forest')).local_name, 'pixabay-21.mp4');
});

test('an unconfigured provider reports itself and never calls the network', async () => {
  const client = new PixabayStockClient({
    apiKey: '',
    fetch: async () => { throw new Error('network should not be called'); }
  });
  assert.equal(client.isConfigured(), false);
  await assert.rejects(client.search('space'), error => error.code === 'PROVIDER_NOT_CONFIGURED');
});

/* -------------------------------- Pexels -------------------------------- */

test('Pexels authenticates with the raw key and requests portrait results', async t => {
  const dirs = await scratch(t, 'pexels');
  let requested;
  let headers;
  const client = new PexelsStockClient({
    ...dirs,
    apiKey: 'pexels-key',
    fetch: async (url, init) => {
      requested = String(url);
      headers = init.headers;
      return { ok: true, json: async () => ({ videos: [{
        id: 42, duration: 12, url: 'https://www.pexels.com/video/42/', user: { name: 'Camera Person' },
        video_files: [
          { link: 'https://videos.pexels.com/small.mp4', width: 640, height: 360 },
          { link: 'https://videos.pexels.com/tall.mp4', width: 1080, height: 1920 }
        ]
      }] }) };
    }
  });
  const candidates = await client.search('mountain');
  assert.match(requested, /^https:\/\/api\.pexels\.com\/v1\/videos\/search\?/);
  assert.match(requested, /orientation=portrait/);
  assert.equal(headers.Authorization, 'pexels-key');
  assert.equal(candidates.length, 1);
  // The vertical rendition must win even though another file is listed first.
  assert.equal(candidates[0].url, 'https://videos.pexels.com/tall.mp4');
  assert.equal(candidates[0].height, 1920);
  assert.equal(candidates[0].creator, 'Camera Person');
});

test('Pexels downloads produce a pexels-prefixed staged file', async t => {
  const dirs = await scratch(t, 'pexels-dl');
  const client = new PexelsStockClient({
    ...dirs,
    apiKey: 'pexels-key',
    fetch: async url => String(url).includes('api.pexels.com')
      ? { ok: true, json: async () => ({ videos: [{
        id: 99, duration: 9, video_files: [{ link: 'https://videos.pexels.com/v.mp4', width: 1080, height: 1920 }]
      }] }) }
      : body('pexels-bytes')
  });
  const asset = await client.downloadBest('river');
  assert.equal(asset.provider, 'pexels');
  assert.equal(asset.local_name, 'pexels-99.mp4');
  assert.equal(await fs.readFile(asset.local_path, 'utf8'), 'pexels-bytes');
});

/* -------------------------------- Coverr -------------------------------- */

test('Coverr uses bearer auth, vertical filtering and mp4_download URLs', async t => {
  const dirs = await scratch(t, 'coverr');
  let requested;
  let headers;
  const client = new CoverrStockClient({
    ...dirs,
    apiKey: 'coverr-key',
    fetch: async (url, init) => {
      requested = String(url);
      headers = init.headers;
      return { ok: true, json: async () => ({ hits: [{
        id: 'abc123', duration: '10.5', max_width: 1080, max_height: 1920, is_vertical: true,
        canonical_url: 'https://coverr.co/videos/abc123',
        urls: { mp4_download: 'https://storage.coverr.co/abc123.mp4' }
      }] }) };
    }
  });
  const candidates = await client.search('city');
  assert.match(requested, /^https:\/\/api\.coverr\.co\/videos\?/);
  assert.match(requested, /filter=is_vertical/);
  assert.equal(headers.Authorization, 'Bearer coverr-key');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].asset_id, 'abc123');
  assert.equal(candidates[0].duration, 10.5);
  assert.equal(candidates[0].url, 'https://storage.coverr.co/abc123.mp4');
});

/* ------------------------------- security ------------------------------- */

test('media URLs outside the provider hosts are refused', async t => {
  const dirs = await scratch(t, 'ssrf');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 5, tags: 'x', videos: { large: { url: 'https://169.254.169.254/latest/meta-data', width: 1920, height: 1080 } } }
      ] }) }
      : body()
  });
  await assert.rejects(client.downloadBest('x'), error =>
    error instanceof StockMediaError && error.code === 'INVALID_ASSET_URL');
});

test('plain HTTP media URLs are refused', async t => {
  const dirs = await scratch(t, 'http');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 6, tags: 'x', videos: { large: { url: 'http://cdn.pixabay.com/a.mp4', width: 1920, height: 1080 } } }
      ] }) }
      : body()
  });
  await assert.rejects(client.downloadBest('x'), error => error.code === 'INVALID_ASSET_URL');
});

test('an oversized asset is rejected and leaves no partial file behind', async t => {
  const dirs = await scratch(t, 'toobig');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    maxAssetBytes: 8,
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 8, tags: 'x', videos: { large: { url: 'https://cdn.pixabay.com/a.mp4', width: 1920, height: 1080 } } }
      ] }) }
      : { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.alloc(64) }
  });
  await assert.rejects(client.downloadBest('x'), error => error.code === 'ASSET_TOO_LARGE');
  assert.deepEqual(await fs.readdir(dirs.downloadDirectory), []);
});

test('an empty download is rejected and leaves no staged file', async t => {
  const dirs = await scratch(t, 'empty');
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'fixture-key',
    fetch: async url => String(url).includes('/api/videos/')
      ? { ok: true, json: async () => ({ hits: [
        { id: 9, tags: 'x', videos: { large: { url: 'https://cdn.pixabay.com/a.mp4', width: 1920, height: 1080 } } }
      ] }) }
      : { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) }
  });
  await assert.rejects(client.downloadBest('x'), error => error.code === 'EMPTY_ASSET');
  assert.deepEqual(await fs.readdir(dirs.downloadDirectory), []);
});

test('provider ids are sanitised before they reach the filesystem', () => {
  assert.equal(assetFileName('coverr', '../../etc/passwd'), 'coverr-______etc_passwd.mp4');
  assert.equal(assetFileName('pexels', 42), 'pexels-42.mp4');
});

test('an HTTP error is classified, and a rate limit is distinguished', async t => {
  const dirs = await scratch(t, 'errors');
  const limited = new PixabayStockClient({ ...dirs, apiKey: 'k', fetch: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(limited.search('x'), error => error.code === 'PROVIDER_RATE_LIMITED');
  const broken = new PixabayStockClient({ ...dirs, apiKey: 'k', fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(broken.search('y'), error => error.code === 'PROVIDER_HTTP_ERROR' && error.details.status === 503);
});

/* -------------------------------- cache --------------------------------- */

test('the search cache is scoped per provider and never stores the API key', async t => {
  const dirs = await scratch(t, 'cache');
  let searches = 0;
  const client = new PixabayStockClient({
    ...dirs,
    apiKey: 'super-secret-key',
    fetch: async () => {
      searches += 1;
      return { ok: true, json: async () => ({ hits: [
        { id: 3, tags: 'sky', videos: { large: { url: 'https://cdn.pixabay.com/s.mp4', width: 1920, height: 1080 } } }
      ] }) };
    }
  });
  await client.search('sky');
  await client.search('sky');
  assert.equal(searches, 1, 'the second identical search is served from cache');

  const files = await fs.readdir(dirs.searchCacheDirectory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^pixabay-[a-f0-9]{64}\.json$/);
  const contents = await fs.readFile(path.join(dirs.searchCacheDirectory, files[0]), 'utf8');
  assert.ok(!contents.includes('super-secret-key'), 'the cache must never contain the API key');
});

test('an expired or corrupt cache entry falls back to a live search', async t => {
  const dirs = await scratch(t, 'cache-stale');
  let searches = 0;
  const make = ttl => new PixabayStockClient({
    ...dirs,
    apiKey: 'k',
    searchCacheTtlMs: ttl,
    fetch: async () => {
      searches += 1;
      return { ok: true, json: async () => ({ hits: [
        { id: 4, tags: 'sea', videos: { large: { url: 'https://cdn.pixabay.com/x.mp4', width: 1920, height: 1080 } } }
      ] }) };
    }
  });
  await make(1).search('sea');
  await new Promise(resolve => setTimeout(resolve, 5));
  await make(1).search('sea');
  assert.equal(searches, 2, 'an expired entry is refetched');

  const [file] = await fs.readdir(dirs.searchCacheDirectory);
  await fs.writeFile(path.join(dirs.searchCacheDirectory, file), '{ not json', 'utf8');
  await make(60000).search('sea');
  assert.equal(searches, 3, 'a corrupt entry is refetched rather than throwing');
});

/* ------------------------------ provider order --------------------------- */

test('the default provider order is Pixabay then Pexels then Coverr', () => {
  assert.deepEqual(resolveProviderOrder(''), ['pixabay', 'pexels', 'coverr']);
});

test('the provider order is configurable and de-duplicated', () => {
  assert.deepEqual(resolveProviderOrder('pexels, coverr ,pexels'), ['pexels', 'coverr']);
});

test('an unknown provider name is rejected instead of silently dropped', () => {
  assert.throws(() => resolveProviderOrder('pexels,youtube'), error =>
    error instanceof StockMediaError && error.code === 'CONFIG_ERROR');
});

test('createStockProviders builds the chain in order with injected keys', () => {
  const providers = createStockProviders({
    order: 'coverr,pixabay',
    apiKeys: { coverr: 'c', pixabay: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  assert.deepEqual(providers.map(provider => provider.provider), ['coverr', 'pixabay']);
  assert.equal(providers[0].isConfigured(), true);
  assert.equal(providers[1].isConfigured(), false);
});
