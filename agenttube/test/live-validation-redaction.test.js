/**
 * The live validation harness handles real provider credentials, and Pixabay
 * carries its key in the query string, so any URL that reaches a report, a log
 * line or a console would publish it. Redaction is therefore a security
 * property and is tested rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, credentialState, STATUS } = require('../scripts/live-integration-validation');

const SECRET = 'abcd1234secretkeyvalue567890';

test('a Pixabay-style key in a query string never survives redaction', () => {
  const url = `https://pixabay.com/api/videos/?key=${SECRET}&q=ocean+water&per_page=8`;
  const output = redact(url);
  assert.ok(!output.includes(SECRET), 'the key must not appear in the output');
  assert.match(output, /[?&]key=REDACTED/);
  // The rest of the URL is diagnostic and must survive.
  assert.match(output, /q=ocean\+water/);
  assert.match(output, /per_page=8/);
});

test('every common key parameter spelling is covered', () => {
  for (const parameter of ['key', 'api_key', 'apikey', 'token', 'access_token', 'API_KEY', 'ApiKey']) {
    const output = redact(`https://example.com/v1?${parameter}=${SECRET}&q=x`);
    assert.ok(!output.includes(SECRET), `${parameter} must be redacted`);
    assert.match(output, /=REDACTED/);
  }
});

test('a bearer token is redacted wherever it appears', () => {
  const output = redact(`Authorization: Bearer ${SECRET}`);
  assert.ok(!output.includes(SECRET));
  assert.match(output, /Bearer REDACTED/);
});

test('redaction survives a key embedded in a multi-line stack trace', () => {
  const stack = [
    'Error: request failed',
    `    at fetch (https://pixabay.com/api/videos/?key=${SECRET}&q=forest)`,
    '    at process.processTicksAndRejections'
  ].join('\n');
  const output = redact(stack);
  assert.ok(!output.includes(SECRET));
  assert.match(output, /at process\.processTicksAndRejections/);
});

test('a key appearing more than once is redacted every time', () => {
  const output = redact(`https://a/?key=${SECRET} and https://b/?token=${SECRET}`);
  assert.equal(output.includes(SECRET), false);
  assert.equal((output.match(/REDACTED/g) || []).length, 2);
});

test('text with no secret is passed through unchanged', () => {
  const message = 'pixabay search failed with HTTP 429';
  assert.equal(redact(message), message);
});

test('redaction tolerates null and undefined rather than throwing mid-report', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test('credential state reports presence and length but never the value', () => {
  const name = 'REZS_TEST_ONLY_CREDENTIAL';
  process.env[name] = SECRET;
  try {
    const state = credentialState(name);
    assert.equal(state.configured, true);
    assert.ok(!state.detail.includes(SECRET), 'the detail string must not contain the value');
    assert.match(state.detail, new RegExp(`${SECRET.length} characters`));
  } finally {
    delete process.env[name];
  }
});

test('an unset credential is reported as unset, not as an empty value', () => {
  const state = credentialState('REZS_DEFINITELY_NOT_SET_ANYWHERE');
  assert.equal(state.configured, false);
  assert.match(state.detail, /is not set/);
});

test('a whitespace-only credential counts as unset', () => {
  const name = 'REZS_TEST_ONLY_BLANK';
  process.env[name] = '   ';
  try {
    assert.equal(credentialState(name).configured, false);
  } finally {
    delete process.env[name];
  }
});

test('the status vocabulary distinguishes every outcome the report must express', () => {
  // A silent substitution is the specific failure mode this guards against:
  // each of these must remain a distinct, reportable state.
  assert.deepEqual(
    Object.keys(STATUS).sort(),
    ['FAIL', 'NOT_TESTED', 'NO_CREDENTIAL', 'PASS', 'SUBSTITUTED', 'UNREACHABLE'].sort()
  );
  for (const key of Object.keys(STATUS)) assert.equal(STATUS[key], key);
});
