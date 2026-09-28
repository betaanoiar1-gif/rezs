const test = require('node:test');
const assert = require('node:assert/strict');
const { AITextService, PROVIDERS } = require('../utils/ai-text-service');

const originalKey = process.env.CLEANAPIS_API_KEY;
const originalModel = process.env.CLEANAPIS_MODEL;

test.afterEach(() => {
  if (originalKey === undefined) delete process.env.CLEANAPIS_API_KEY;
  else process.env.CLEANAPIS_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.CLEANAPIS_MODEL;
  else process.env.CLEANAPIS_MODEL = originalModel;
});

test('Clean APIs provider preset uses the exact OpenAI-compatible configuration', () => {
  assert.ok(PROVIDERS.cleanapis);
  assert.equal(PROVIDERS.cleanapis.baseURL, 'https://www.cleanapis.com/v1');
  assert.equal(PROVIDERS.cleanapis.envKey, 'CLEANAPIS_API_KEY');
  assert.equal(PROVIDERS.cleanapis.modelEnvKey, 'CLEANAPIS_MODEL');
});

test('Clean APIs is selected from runtime key and model without network access', () => {
  process.env.CLEANAPIS_API_KEY = 'test-key-not-real';
  process.env.CLEANAPIS_MODEL = 'model-returned-by-discovery';
  const service = new AITextService();
  assert.equal(service.providerName, 'Clean APIs');
  assert.equal(service.model, 'model-returned-by-discovery');
  assert.equal(service.client.baseURL, 'https://www.cleanapis.com/v1');
  assert.equal(service.isAvailable(), true);
});

test('credential-manager aiProvider selects Clean APIs and its selected model', () => {
  delete process.env.CLEANAPIS_API_KEY;
  delete process.env.CLEANAPIS_MODEL;
  const service = new AITextService({
    aiProvider: { provider: 'cleanapis', apiKey: 'test-key-not-real', model: 'credential-selected-model' }
  });
  assert.equal(service.providerName, 'Clean APIs');
  assert.equal(service.model, 'credential-selected-model');
  assert.equal(service.client.baseURL, 'https://www.cleanapis.com/v1');
});

test('Clean APIs uses the existing non-streaming chat.completions.create path', async () => {
  process.env.CLEANAPIS_API_KEY = 'test-key-not-real';
  process.env.CLEANAPIS_MODEL = 'available-model';
  const service = new AITextService();
  let request;
  service.client.chat.completions.create = async input => {
    request = input;
    return { choices: [{ message: { content: 'CLEANAPIS_AGENTTUBE_TEST_OK' } }] };
  };
  const response = await service.generateText('Reply with exactly: CLEANAPIS_AGENTTUBE_TEST_OK', {
    maxTokens: 20,
    temperature: 0
  });
  assert.equal(response, 'CLEANAPIS_AGENTTUBE_TEST_OK');
  assert.equal(request.model, 'available-model');
  assert.equal(request.stream, undefined);
  assert.equal(request.messages[0].role, 'user');
  assert.equal(request.max_completion_tokens, 20);
});

test('Clean APIs requires a discovered model instead of assuming one', async () => {
  process.env.CLEANAPIS_API_KEY = 'test-key-not-real';
  delete process.env.CLEANAPIS_MODEL;
  const service = new AITextService();
  await assert.rejects(service.generateText('hello'), /requires an explicitly selected model/);
});
