const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRetryWithAlternativeModel } = require('./langchainClient');

test('retries with an alternative model when NVIDIA reports a degraded function', () => {
  const error = new Error("NVIDIA API error 400: {\"detail\":\"Function id 'abc': DEGRADED function cannot be invoked\"}");
  assert.equal(shouldRetryWithAlternativeModel(error), true);
});

test('does not retry for unrelated NVIDIA errors', () => {
  const error = new Error('NVIDIA API error 401: invalid API key');
  assert.equal(shouldRetryWithAlternativeModel(error), false);
});
