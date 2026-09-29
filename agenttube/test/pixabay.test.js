const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { PixabayVideoClient } = require('../integrations/pixabay');

test('Pixabay search returns video hits and uses safesearch', async t => {
  // The search cache must be scoped to this test; a shared cache directory
  // would let one run's entry satisfy the next run and skip the HTTP call.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixabay-search-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let requested;
  const client = new PixabayVideoClient({
    apiKey: 'fixture-key',
    downloadDirectory: directory,
    fetch: async url => {
      requested = String(url);
      return { ok: true, json: async () => ({ hits: [{ id: 7, tags: 'ocean water', videos: { medium: { url: 'https://cdn.example/video.mp4', width: 1920, height: 1080 } } }] }) };
    }
  });
  const hits = await client.search('ocean water');
  assert.equal(hits.length, 1);
  assert.match(requested, /safesearch=true/);
  // URLSearchParams encodes the space as "+"; the literal must be escaped so
  // the assertion does not silently degrade into "one or more n" and fail.
  assert.match(requested, /q=ocean\+water/);
});

test('Pixabay chooses a relevant high-resolution clip and caches the local file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixabay-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let downloads = 0;
  const client = new PixabayVideoClient({
    apiKey: 'fixture-key',
    downloadDirectory: directory,
    fetch: async url => {
      if (String(url).includes('/api/videos/')) {
        return { ok: true, json: async () => ({ hits: [
          { id: 1, tags: 'forest city', views: 10, pageURL: 'https://pixabay.com/videos/id-1/', videos: { medium: { url: 'https://cdn.example/a.mp4', width: 1920, height: 1080 } } },
          { id: 2, tags: 'forest', views: 1000, pageURL: 'https://pixabay.com/videos/id-2/', videos: { medium: { url: 'https://cdn.example/b.mp4', width: 1280, height: 720 } } }
        ] }) };
      }
      downloads += 1;
      return { ok: true, arrayBuffer: async () => Buffer.from('fixture-video') };
    }
  });
  const first = await client.downloadBest('forest');
  const second = await client.downloadBest('forest');
  assert.equal(first.provider, 'pixabay');
  // Both hits match the term, so resolution decides. A 1920x1080 source is
  // preferred over a more-viewed 1280x720 one because MoneyPrinterTurbo
  // rejects material below its minimum dimension when building a 1080x1920
  // Short; view count must not outrank usable pixels.
  assert.equal(first.local_name, 'pixabay-1.mp4');
  assert.equal(first.width, 1920);
  // Repeating the same search reuses the already-downloaded file.
  assert.equal(second.local_name, first.local_name);
  assert.equal(downloads, 1);
});

test('Pixabay ranks tag relevance above raw resolution', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixabay-rank-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = new PixabayVideoClient({
    apiKey: 'fixture-key',
    downloadDirectory: directory,
    fetch: async url => {
      if (String(url).includes('/api/videos/')) {
        return { ok: true, json: async () => ({ hits: [
          // Irrelevant tags but the highest resolution available.
          { id: 10, tags: 'desert sand', views: 10, videos: { large: { url: 'https://cdn.example/x.mp4', width: 3840, height: 2160 } } },
          // Directly relevant tags at a lower, still usable resolution.
          { id: 11, tags: 'forest trees', views: 10, videos: { large: { url: 'https://cdn.example/y.mp4', width: 1920, height: 1080 } } }
        ] }) };
      }
      return { ok: true, arrayBuffer: async () => Buffer.from('fixture-video') };
    }
  });
  const chosen = await client.downloadBest('forest');
  assert.equal(chosen.local_name, 'pixabay-11.mp4');
});

test('missing Pixabay key fails explicitly', async () => {
  const client = new PixabayVideoClient({ apiKey: '', fetch: async () => { throw new Error('network should not be called'); } });
  await assert.rejects(client.search('space'), error => error.code === 'PIXABAY_API_KEY_MISSING');
});
