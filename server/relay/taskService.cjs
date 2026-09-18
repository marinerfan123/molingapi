'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ProviderError, submitProviderJob } = require('./providerClient.cjs');

const TERMINAL = new Set(['done', 'failed', 'canceled']);

function publicSnapshot(row) {
  if (!row) return null;
  return {
    taskId: row.taskId,
    state: row.state,
    modelId: row.modelId,
    result: row.result || undefined,
    error: row.error || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class MemoryTaskStore {
  constructor() { this.tasks = new Map(); }
  async findByIdempotency(userId, key) { return [...this.tasks.values()].find((t) => t.userId === userId && t.idempotencyKey === key) || null; }
  async create(input) {
    const existing = await this.findByIdempotency(input.userId, input.idempotencyKey);
    if (existing) return { row: existing, created: false };
    const now = new Date().toISOString();
    const row = { ...input, state: 'queued', result: null, error: null, createdAt: now, updatedAt: now };
    this.tasks.set(row.taskId, row);
    return { row, created: true };
  }
  async get(taskId) { return this.tasks.get(taskId) || null; }
  async update(taskId, patch) {
    const row = this.tasks.get(taskId);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return row;
  }
}

function createDbTaskStore(pool) {
  return {
    async findByIdempotency(userId, key) {
      const result = await pool.query('SELECT * FROM model_relay.generation_tasks WHERE user_id=$1 AND idempotency_key=$2', [userId, key]);
      return mapDbRow(result.rows[0]);
    },
    async create(input) {
      const result = await pool.query(`
        INSERT INTO model_relay.generation_tasks (task_id, user_id, idempotency_key, model_id, state, request_json)
        VALUES ($1, $2, $3, $4, 'queued', $5::jsonb)
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING *
      `, [input.taskId, input.userId, input.idempotencyKey, input.modelId, JSON.stringify(input.request)]);
      if (result.rows[0]) return { row: mapDbRow(result.rows[0]), created: true };
      return { row: await this.findByIdempotency(input.userId, input.idempotencyKey), created: false };
    },
    async get(taskId) {
      const result = await pool.query('SELECT * FROM model_relay.generation_tasks WHERE task_id=$1', [taskId]);
      return mapDbRow(result.rows[0]);
    },
    async update(taskId, patch) {
      const values = [];
      const sets = [];
      const fields = { state: 'state', result: 'result_json', error: 'error', providerId: 'provider_id', providerKeyId: 'provider_key_id' };
      for (const [key, column] of Object.entries(fields)) {
        if (patch[key] === undefined) continue;
        values.push(key === 'result' ? JSON.stringify(patch[key]) : patch[key]);
        sets.push(`${column}=$${values.length}${key === 'result' ? '::jsonb' : ''}`);
      }
      if (patch.state && TERMINAL.has(patch.state)) sets.push('completed_at=NOW()');
      if (!sets.length) return this.get(taskId);
      values.push(taskId);
      const result = await pool.query(`UPDATE model_relay.generation_tasks SET ${sets.join(', ')}, updated_at=NOW() WHERE task_id=$${values.length} RETURNING *`, values);
      return mapDbRow(result.rows[0]);
    },
  };
}

function mapDbRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id, userId: row.user_id, idempotencyKey: row.idempotency_key, modelId: row.model_id,
    state: row.state, request: row.request_json, result: row.result_json, error: row.error,
    providerId: row.provider_id, providerKeyId: row.provider_key_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

class TaskService {
  constructor({ store, routeService, providerSubmit = submitProviderJob, logger = console } = {}) {
    this.store = store;
    this.routeService = routeService;
    this.providerSubmit = providerSubmit;
    this.logger = logger;
    this.events = new Map();
  }

  async create({ userId, request }) {
    if (!userId) throw Object.assign(new Error('user identity is required'), { status: 401, code: 'unauthorized' });
    if (!request?.idempotencyKey || !String(request.idempotencyKey).trim()) throw Object.assign(new Error('idempotencyKey is required'), { status: 400, code: 'invalid_request' });
    if (!request.prompt || !String(request.prompt).trim()) throw Object.assign(new Error('prompt is required'), { status: 400, code: 'invalid_request' });
    const modelId = String(request.modelId || request.model || '').trim();
    if (!modelId) throw Object.assign(new Error('modelId is required'), { status: 400, code: 'invalid_request' });
    const input = { taskId: `task_${randomUUID()}`, userId, idempotencyKey: String(request.idempotencyKey), modelId, request: { ...request, modelId } };
    const result = await this.store.create(input);
    if (result.created) {
      this.emit(result.row);
      queueMicrotask(() => this.run(result.row.taskId));
    }
    return { status: 'pending', taskId: result.row.taskId, modelId: result.row.modelId };
  }

  async get({ taskId, userId }) {
    const row = await this.store.get(taskId);
    if (!row) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    if (row.userId !== userId) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    return publicSnapshot(row);
  }

  async cancel({ taskId, userId }) {
    const row = await this.store.get(taskId);
    if (!row) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    if (row.userId !== userId) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    if (TERMINAL.has(row.state)) throw Object.assign(new Error('task is already terminal'), { status: 409, code: 'task_terminal' });
    const updated = await this.store.update(taskId, { state: 'canceled', error: 'canceled by user' });
    this.emit(updated);
    return publicSnapshot(updated);
  }

  subscribe(taskId, listener) {
    const emitter = this.events.get(taskId) || new EventEmitter();
    this.events.set(taskId, emitter);
    emitter.on('update', listener);
    return () => emitter.off('update', listener);
  }

  emit(row) {
    const emitter = this.events.get(row.taskId);
    if (emitter) emitter.emit('update', publicSnapshot(row));
  }

  async run(taskId) {
    let row = await this.store.get(taskId);
    if (!row || TERMINAL.has(row.state)) return;
    try {
      row = await this.store.update(taskId, { state: 'running' });
      this.emit(row);
      const route = await this.routeService.selectRoute(row.modelId);
      row = await this.store.update(taskId, { providerId: route.providerId, providerKeyId: route.keyId });
      this.emit(row);
      const result = await this.providerSubmit({ provider: route.provider, model: route.upstreamModel, apiKey: route.apiKey, request: row.request });
      const done = await this.store.update(taskId, { state: 'done', result: result.kind === 'sync' ? result : { providerTaskId: result.providerTaskId } });
      this.emit(done);
    } catch (error) {
      const current = await this.store.get(taskId);
      if (!current || current.state === 'canceled') return;
      const safeMessage = error instanceof ProviderError ? error.message : (error.code === 'model_route_unavailable' ? error.message : 'generation failed');
      const failed = await this.store.update(taskId, { state: 'failed', error: safeMessage });
      this.emit(failed);
      this.logger.error?.('[relay] task failed', { taskId, code: error.code || 'internal_error' });
    }
  }
}

module.exports = { TaskService, MemoryTaskStore, createDbTaskStore, publicSnapshot, TERMINAL };
