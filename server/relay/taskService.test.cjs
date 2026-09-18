'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskService, MemoryTaskStore, CapacityGate } = require('./taskService.cjs');

function createService() {
  return new TaskService({
    store: new MemoryTaskStore(),
    routeService: { selectRoute: async () => ({ providerId: 'p1', keyId: 'k1', upstreamModel: 'upstream', provider: { baseUrl: 'https://provider.test', protocol: 'openai-compatible' }, apiKey: 'secret' }) },
    providerSubmit: async () => ({ kind: 'sync', images: ['https://cdn.test/image.png'] }),
    logger: { error() {} },
  });
}

test('same user and idempotency key returns one task', async () => {
  const service = createService();
  const first = await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'x', idempotencyKey: 'same' } });
  const second = await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'x', idempotencyKey: 'same' } });
  assert.equal(first.taskId, second.taskId);
});

test('same idempotency key with a different payload is rejected', async () => {
  const service = createService();
  await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'first', idempotencyKey: 'conflict' } });
  await assert.rejects(() => service.create({ userId: 'u1', request: { modelId: 'm2', prompt: 'second', idempotencyKey: 'conflict' } }), (error) => error.code === 'idempotency_conflict');
});

test('task reaches done and cannot be canceled afterward', async () => {
  const service = createService();
  const accepted = await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'x', idempotencyKey: 'done' } });
  await service.run(accepted.taskId);
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = await service.get({ taskId: accepted.taskId, userId: 'u1' });
  assert.equal(snapshot.state, 'done');
  await assert.rejects(() => service.cancel({ taskId: accepted.taskId, userId: 'u1' }), /already terminal/);
});

test('another user cannot read or cancel a task', async () => {
  const service = createService();
  const accepted = await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'x', idempotencyKey: 'owner' } });
  await assert.rejects(() => service.get({ taskId: accepted.taskId, userId: 'u2' }), (error) => error.status === 404);
  await assert.rejects(() => service.cancel({ taskId: accepted.taskId, userId: 'u2' }), (error) => error.status === 404);
});

test('cancel wins a provider completion race', async () => {
  let resolveProvider;
  const service = new TaskService({
    store: new MemoryTaskStore(),
    routeService: { selectRoute: async () => ({ providerId: 'p1', keyId: 'k1', upstreamModel: 'upstream', provider: { baseUrl: 'https://provider.test', protocol: 'openai-compatible' }, apiKey: 'secret' }) },
    providerSubmit: async () => new Promise((resolve) => { resolveProvider = resolve; }),
    logger: { error() {} },
  });
  const accepted = await service.create({ userId: 'u1', request: { modelId: 'm1', prompt: 'x', idempotencyKey: 'race' } });
  await new Promise((resolve) => setImmediate(resolve));
  await service.cancel({ taskId: accepted.taskId, userId: 'u1' });
  resolveProvider({ kind: 'sync', images: ['should-not-win'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.get({ taskId: accepted.taskId, userId: 'u1' })).state, 'canceled');
});

test('capacity gate rejects a second concurrent lease', () => {
  const gate = new CapacityGate();
  const route = { providerId: 'p1', keyId: 'k1', provider: { bucketMax: 1, rateLimits: {} } };
  const lease = gate.acquire(route);
  assert.throws(() => gate.acquire(route), (error) => error.code === 'provider_capacity');
  lease.release(true);
  assert.doesNotThrow(() => gate.acquire(route));
});
