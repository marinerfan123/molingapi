'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskService, MemoryTaskStore } = require('./taskService.cjs');

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
