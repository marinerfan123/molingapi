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

test('returns a poller for asynchronous video jobs', async () => {
  const calls = [];
  const job = await submitProviderJob({
    provider: { baseUrl: 'https://provider.test', protocol: 'openai-compatible' },
    model: 'video-1', apiKey: 'secret-key', request: { contentType: 'video', prompt: 'x' },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(calls.length === 1 ? { id: 'job-1', status: 'queued' } : { id: 'job-1', status: 'completed', video_url: 'https://cdn.test/video.mp4' }) };
    },
  });
  assert.equal(job.kind, 'async');
  const polled = await job.poll({ provider: { baseUrl: 'https://provider.test', protocol: 'openai-compatible' }, providerTaskId: 'job-1', apiKey: 'secret-key' });
  assert.deepEqual(polled, { done: true, result: { videoUrl: 'https://cdn.test/video.mp4' } });
  assert.equal(calls[1], 'https://provider.test/videos/job-1');
});
