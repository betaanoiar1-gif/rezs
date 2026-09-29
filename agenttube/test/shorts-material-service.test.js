const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const {
  ShortsMaterialService,
  ShortsMaterialError,
  collectSearchTerms,
  expandSearchTerm,
  verifyStagedAssets,
  isRecoverableProviderError
} = require('../services/shorts-material-service');
const { StockMediaError } = require('../integrations/stock-media');

function plan(terms = [['ocean'], ['forest']]) {
  return {
    job_id: 'short_plan_test',
    scenes: terms.map((visual_search_terms, index) => ({
      scene_id: index + 1,
      visual_search_terms
    }))
  };
}

/**
 * A provider double. `results` maps a search term to either an asset
 * descriptor or an error to throw, so every fallback branch can be driven
 * deterministically without touching the network.
 */
function fakeProvider(name, results, { configured = true } = {}) {
  const calls = [];
  return {
    provider: name,
    calls,
    isConfigured: () => configured,
    downloadBest: async term => {
      calls.push(term);
      const outcome = results[term];
      if (!outcome) throw new StockMediaError(`no results for ${term}`, 'NO_VIDEO_RESULTS');
      if (outcome instanceof Error) throw outcome;
      return {
        provider: name,
        asset_id: outcome.asset_id,
        local_name: `${name}-${outcome.asset_id}.mp4`,
        local_path: `/staged/${name}-${outcome.asset_id}.mp4`,
        duration: outcome.duration ?? 10,
        width: outcome.width ?? 1080,
        height: outcome.height ?? 1920,
        tags: '',
        source_url: `https://cdn.example/${outcome.asset_id}.mp4`
      };
    }
  };
}

test('materials are returned in MoneyPrinterTurbo local format', async () => {
  const pixabay = fakeProvider('pixabay', { ocean: { asset_id: '1', duration: 12.7 }, forest: { asset_id: '2' } });
  const service = new ShortsMaterialService({ providers: [pixabay] });
  const materials = await service.discoverMaterials(plan());
  assert.deepEqual(materials, [
    { provider: 'local', url: 'pixabay-1.mp4', duration: 13 },
    { provider: 'local', url: 'pixabay-2.mp4', duration: 10 }
  ]);
});

test('a term with no results falls through to the next provider', async () => {
  const pixabay = fakeProvider('pixabay', {});
  const pexels = fakeProvider('pexels', { ocean: { asset_id: '9' } });
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  const materials = await service.discoverMaterials(plan([['ocean']]));
  assert.deepEqual(materials, [{ provider: 'local', url: 'pexels-9.mp4', duration: 10 }]);
  assert.ok(pixabay.calls.includes('ocean'), 'the primary provider is tried first');
});

test('a rate-limited provider does not end the run', async () => {
  const pixabay = fakeProvider('pixabay', { ocean: new StockMediaError('slow down', 'PROVIDER_RATE_LIMITED') });
  const coverr = fakeProvider('coverr', { ocean: { asset_id: '3' } });
  const service = new ShortsMaterialService({ providers: [pixabay, coverr] });
  const materials = await service.discoverMaterials(plan([['ocean']]));
  assert.equal(materials[0].url, 'coverr-3.mp4');
});

test('a provider timeout falls back to the next source', async () => {
  const pixabay = fakeProvider('pixabay', { ocean: new StockMediaError('timed out', 'PROVIDER_TIMEOUT') });
  const pexels = fakeProvider('pexels', { ocean: { asset_id: '4' } });
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  assert.equal((await service.discoverMaterials(plan([['ocean']])))[0].url, 'pexels-4.mp4');
});

test('an unusable provider response falls back rather than aborting', async () => {
  const pixabay = fakeProvider('pixabay', { ocean: new StockMediaError('garbage', 'PROVIDER_INVALID_RESPONSE') });
  const pexels = fakeProvider('pexels', { ocean: { asset_id: '5' } });
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  assert.equal((await service.discoverMaterials(plan([['ocean']])))[0].url, 'pexels-5.mp4');
});

test('a configuration error is never masked by the fallback chain', async () => {
  // A bad configuration would fail identically for every term and provider,
  // so it must surface immediately instead of looking like "no results".
  const broken = fakeProvider('pixabay', { ocean: new StockMediaError('bad setup', 'CONFIG_ERROR') });
  const pexels = fakeProvider('pexels', { ocean: { asset_id: '6' } });
  const service = new ShortsMaterialService({ providers: [broken, pexels] });
  await assert.rejects(service.discoverMaterials(plan([['ocean']])), error => error.code === 'CONFIG_ERROR');
  assert.equal(pexels.calls.length, 0, 'the chain stops on an unrecoverable error');
});

test('abstract terms are expanded to concrete searchable phrases', async () => {
  const pixabay = fakeProvider('pixabay', { 'daily habit': { asset_id: '7' } });
  const service = new ShortsMaterialService({ providers: [pixabay] });
  const materials = await service.discoverMaterials(plan([['consistency']]));
  assert.equal(materials[0].url, 'pixabay-7.mp4');
  assert.equal(pixabay.calls[0], 'consistency', 'the original term is always tried first');
  assert.ok(pixabay.calls.includes('daily habit'));
});

test('the same asset is never staged twice for different terms', async () => {
  const pixabay = fakeProvider('pixabay', {
    ocean: { asset_id: 'same' },
    forest: { asset_id: 'same' },
    'forest habit': { asset_id: 'other' }
  });
  const service = new ShortsMaterialService({ providers: [pixabay] });
  const materials = await service.discoverMaterials(plan([['ocean'], ['forest']]));
  assert.deepEqual(materials.map(material => material.url), ['pixabay-same.mp4', 'pixabay-other.mp4']);
});

test('material below the Shorts minimum resolution is rejected and replaced', async () => {
  const pixabay = fakeProvider('pixabay', { ocean: { asset_id: 'tiny', width: 320, height: 240 } });
  const pexels = fakeProvider('pexels', { ocean: { asset_id: 'big', width: 1080, height: 1920 } });
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  assert.equal((await service.discoverMaterials(plan([['ocean']])))[0].url, 'pexels-big.mp4');
});

test('no configured provider is a configuration failure, not an empty result', async () => {
  const service = new ShortsMaterialService({
    providers: [fakeProvider('pixabay', {}, { configured: false })]
  });
  await assert.rejects(service.discoverMaterials(plan()), error =>
    error instanceof ShortsMaterialError && error.code === 'NO_MEDIA_PROVIDER_CONFIGURED');
});

test('a plan without visual terms is reported distinctly', async () => {
  const service = new ShortsMaterialService({ providers: [fakeProvider('pixabay', {})] });
  await assert.rejects(service.discoverMaterials({ job_id: 'x', scenes: [{ scene_id: 1, visual_search_terms: [] }] }),
    error => error.code === 'NO_SEARCH_TERMS');
});

test('exhausting every term and provider reports the attempts made', async () => {
  const pixabay = fakeProvider('pixabay', {});
  const pexels = fakeProvider('pexels', {});
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  await assert.rejects(service.discoverMaterials(plan([['ocean']])), error => {
    assert.equal(error.code, 'NO_VIDEO_RESULTS');
    assert.deepEqual(error.details.terms, ['ocean']);
    const tried = error.details.attempts[0].tried;
    assert.ok(tried.length >= 2);
    assert.ok(tried.every(attempt => attempt.outcome === 'NO_VIDEO_RESULTS'));
    return true;
  });
});

test('acquisition diagnostics record which provider answered each term', async () => {
  const pixabay = fakeProvider('pixabay', {});
  const pexels = fakeProvider('pexels', { ocean: { asset_id: '11' } });
  const service = new ShortsMaterialService({ providers: [pixabay, pexels] });
  await service.discoverMaterials(plan([['ocean']]));
  assert.deepEqual(service.lastAcquisition.attempts[0].resolved, {
    provider: 'pexels', term: 'ocean', asset_id: '11'
  });
  assert.deepEqual(service.lastAcquisition.providers, ['pixabay', 'pexels']);
});

test('at most maxTerms unique terms are searched', async () => {
  const pixabay = fakeProvider('pixabay', {});
  const service = new ShortsMaterialService({ providers: [pixabay], maxTerms: 2 });
  await assert.rejects(service.discoverMaterials(plan([['a'], ['b'], ['c'], ['d']])), () => true);
  assert.deepEqual([...new Set(pixabay.calls.map(call => call.split(' ')[0]))], ['a', 'b']);
});

/* ------------------------------ pure helpers ----------------------------- */

test('search terms are de-duplicated, trimmed and capped', () => {
  const terms = collectSearchTerms({
    scenes: [
      { visual_search_terms: [' ocean ', 'ocean', 'forest'] },
      { visual_search_terms: ['forest', 'sky', null, 42, ''] }
    ]
  }, 8);
  assert.deepEqual(terms, ['ocean', 'forest', 'sky']);
});

test('term expansion always starts with the original term', () => {
  const expanded = expandSearchTerm('Consistency');
  assert.equal(expanded[0], 'Consistency');
  assert.ok(expanded.includes('daily habit'));
  assert.ok(expanded.includes('Consistency routine'));
});

test('recoverable provider errors are classified explicitly', () => {
  assert.equal(isRecoverableProviderError({ code: 'NO_VIDEO_RESULTS' }), true);
  assert.equal(isRecoverableProviderError({ code: 'PROVIDER_RATE_LIMITED' }), true);
  assert.equal(isRecoverableProviderError({ code: 'CONFIG_ERROR' }), false);
  assert.equal(isRecoverableProviderError(new Error('boom')), false);
});

test('staged assets are verified on disk', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const good = path.join(directory, 'good.mp4');
  const empty = path.join(directory, 'empty.mp4');
  await fs.writeFile(good, 'bytes');
  await fs.writeFile(empty, '');
  const problems = await verifyStagedAssets([
    { local_name: 'good.mp4', local_path: good },
    { local_name: 'empty.mp4', local_path: empty },
    { local_name: 'gone.mp4', local_path: path.join(directory, 'gone.mp4') }
  ]);
  assert.deepEqual(problems, [
    { asset: 'empty.mp4', reason: 'EMPTY_FILE' },
    { asset: 'gone.mp4', reason: 'MISSING' }
  ]);
});
