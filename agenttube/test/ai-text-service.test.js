const test = require('node:test');
const assert = require('node:assert/strict');
const { AITextService, PROVIDERS, baseUrlEnvKey, normaliseBaseURL } = require('../utils/ai-text-service');

const PROVIDER_ENV_KEYS = Object.values(PROVIDERS).flatMap(preset => [
  preset.envKey,
  baseUrlEnvKey(preset),
  preset.modelEnvKey
].filter(Boolean)).concat('GEMINI_API_KEY');

/**
 * Provider selection reads process.env directly, so every test starts from a
 * clean slate and restores the original environment afterwards. Otherwise the
 * host's own credentials would decide which provider a test selects.
 */
function withEnv(t, values) {
  const saved = new Map();
  for (const key of PROVIDER_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  });
}

test('each provider keeps its documented endpoint when nothing overrides it', t => {
  withEnv(t, { OPENAI_API_KEY: 'test-key' });
  const service = new AITextService();
  assert.equal(service.baseURL, PROVIDERS.openai.baseURL);
  assert.equal(service.providerName, 'OpenAI');
});

test('a provider can be pointed at another endpoint without editing code', t => {
  withEnv(t, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://gateway.internal/v1' });
  const service = new AITextService();
  assert.equal(service.baseURL, 'https://gateway.internal/v1');
  // Overriding the endpoint must not change which provider or model was chosen.
  assert.equal(service.providerName, 'OpenAI');
  assert.equal(service.model, PROVIDERS.openai.defaultModel);
});

test('the override is scoped to the provider it names', t => {
  // A Clean APIs override must not leak into an OpenAI-backed run.
  withEnv(t, { OPENAI_API_KEY: 'test-key', CLEANAPIS_BASE_URL: 'https://wrong.internal/v1' });
  assert.equal(new AITextService().baseURL, PROVIDERS.openai.baseURL);
});

test('every provider derives a base URL variable from its key variable', () => {
  assert.equal(baseUrlEnvKey(PROVIDERS.cleanapis), 'CLEANAPIS_BASE_URL');
  assert.equal(baseUrlEnvKey(PROVIDERS.openrouter), 'OPENROUTER_BASE_URL');
  assert.equal(baseUrlEnvKey(PROVIDERS.kimi), 'MOONSHOT_BASE_URL');
  for (const preset of Object.values(PROVIDERS)) {
    assert.match(baseUrlEnvKey(preset), /^[A-Z0-9]+_BASE_URL$/);
  }
});

test('an unusable endpoint is rejected where the cause is still visible', t => {
  withEnv(t, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'not-a-url' });
  // Failing at construction beats an opaque request failure much later.
  assert.throws(() => new AITextService(), /Invalid AI provider base URL/);
});

test('non-http endpoint schemes are refused', () => {
  assert.throws(() => normaliseBaseURL('file:///etc/passwd'), /must be http or https/);
  assert.throws(() => normaliseBaseURL('ftp://example.com/v1'), /must be http or https/);
  assert.equal(normaliseBaseURL('  https://example.com/v1  '), 'https://example.com/v1');
});

test('explicit credentials outrank environment variables', t => {
  withEnv(t, { OPENAI_API_KEY: 'env-key' });
  const service = new AITextService({
    aiProvider: { provider: 'kimi', apiKey: 'explicit-key', model: 'kimi-k3', baseURL: 'https://kimi.internal/v1' }
  });
  assert.equal(service.providerName, 'Kimi (Moonshot AI)');
  assert.equal(service.baseURL, 'https://kimi.internal/v1');
  assert.equal(service.model, 'kimi-k3');
});

test('with no credentials at all the service stays inert rather than half-configured', t => {
  withEnv(t, {});
  const service = new AITextService();
  assert.equal(service.client, null);
  assert.equal(service.gemini, null);
  assert.equal(service.model, null);
});

test('a provider without a default model refuses to guess one', async t => {
  // Clean APIs publishes no model list, so a run must name its model instead
  // of silently falling back to some other provider's default.
  withEnv(t, { CLEANAPIS_API_KEY: 'test-key' });
  const service = new AITextService();
  assert.equal(service.providerName, 'Clean APIs');
  assert.equal(service.model, null);
  await assert.rejects(service.generateText('hello'), /requires an explicitly selected model/);
});

test('the model variable selects the model for providers that publish one', t => {
  withEnv(t, { CLEANAPIS_API_KEY: 'test-key', CLEANAPIS_MODEL: 'some-model' });
  assert.equal(new AITextService().model, 'some-model');
});
