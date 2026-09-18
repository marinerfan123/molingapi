'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError, submitProviderJob } = require('./providerClient.cjs');

test('submits an OpenAI-compatible image request without exposing the key in the body', async () => {
  let seen;
  const result = await submitProviderJob({
    provider: { baseUrl: 'https://provider.test/v1', protocol: 'openai-compatible' },
    model: 'flux-1',
    apiKey: 'secret-key',
    request: { contentType: 'image', prompt: 'a cat', count: 2, resolution: '1024x1024' },
    fetchImpl: async (url, options) => {
      seen = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn.test/a.png' }] }) };
    },
  });
  assert.equal(seen.url, 'https://provider.test/v1/images/generations');
  assert.equal(seen.options.headers.authorization, 'Bearer secret-key');
  assert.equal(seen.body.model, 'flux-1');
  assert.equal(seen.body.prompt, 'a cat');
  assert.equal(seen.body.n, 2);
  assert.equal(seen.body.size, '1024x1024');
  assert.equal(seen.body.apiKey, undefined);
  assert.deepEqual(result, { kind: 'sync', images: ['https://cdn.test/a.png'] });
});

test('classifies non-2xx provider responses', async () => {
  await assert.rejects(
    () => submitProviderJob({
      provider: { baseUrl: 'https://provider.test', protocol: 'openai-compatible' },
      model: 'flux-1', apiKey: 'secret-key', request: { contentType: 'image', prompt: 'x' },
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'busy' } }) }),
    }),
    (error) => error instanceof ProviderError && error.code === 'provider_rate_limited' && error.retryable,
  );
});
