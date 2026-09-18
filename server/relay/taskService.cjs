'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { ProviderError, submitProviderJob } = require('./providerClient.cjs');

const TERMINAL = new Set(['done', 'failed', 'canceled']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requestHash(request) {
  const copy = { ...request };
  delete copy.idempotencyKey;
  return crypto.createHash('sha256').update(stableStringify(copy)).digest('hex');
}

function publicSnapshot(row) {
  if (!row) return null;
  return { taskId: row.taskId, state: row.state, modelId: row.modelId, result: row.result || undefined, error: row.error || undefined, createdAt: row.createdAt, updatedAt: row.updatedAt };
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
  async transition(taskId, expectedStates, patch) {
    const row = await this.get(taskId);
    if (!row || !expectedStates.includes(row.state)) return null;
    return this.update(taskId, patch);
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
        INSERT INTO model_relay.generation_tasks (task_id, user_id, idempotency_key, model_id, request_hash, state, request_json)
        VALUES ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING *
      `, [input.taskId, input.userId, input.idempotencyKey, input.modelId, input.requestHash, JSON.stringify(input.request)]);
      if (result.rows[0]) return { row: mapDbRow(result.rows[0]), created: true };
      return { row: await this.findByIdempotency(input.userId, input.idempotencyKey), created: false };
    },
    async get(taskId) {
      const result = await pool.query('SELECT * FROM model_relay.generation_tasks WHERE task_id=$1', [taskId]);
      return mapDbRow(result.rows[0]);
    },
    async update(taskId, patch) { return updateDbTask(pool, taskId, patch); },
    async transition(taskId, expectedStates, patch) { return updateDbTask(pool, taskId, patch, expectedStates); },
  };
}

async function updateDbTask(pool, taskId, patch, expectedStates) {
  const values = [];
  const sets = [];
  const fields = { state: 'state', result: 'result_json', error: 'error', providerId: 'provider_id', providerKeyId: 'provider_key_id' };
  for (const [key, column] of Object.entries(fields)) {
    if (patch[key] === undefined) continue;
    values.push(key === 'result' ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column}=$${values.length}${key === 'result' ? '::jsonb' : ''}`);
  }
  if (patch.state && TERMINAL.has(patch.state)) sets.push('completed_at=NOW()');
  if (!sets.length) return queryTask(pool, taskId);
  values.push(taskId);
  let where = `task_id=$${values.length}`;
  if (expectedStates) {
    values.push(expectedStates);
    where += ` AND state=ANY($${values.length}::text[])`;
  }
  const result = await pool.query(`UPDATE model_relay.generation_tasks SET ${sets.join(', ')}, updated_at=NOW() WHERE ${where} RETURNING *`, values);
  return mapDbRow(result.rows[0]);
}

async function queryTask(pool, taskId) {
  const result = await pool.query('SELECT * FROM model_relay.generation_tasks WHERE task_id=$1', [taskId]);
  return mapDbRow(result.rows[0]);
}

function mapDbRow(row) {
  if (!row) return null;
  return { taskId: row.task_id, userId: row.user_id, idempotencyKey: row.idempotency_key, modelId: row.model_id, requestHash: row.request_hash, state: row.state, request: row.request_json, result: row.result_json, error: row.error, providerId: row.provider_id, providerKeyId: row.provider_key_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

class CapacityGate {
  constructor() { this.states = new Map(); }
  acquire(route) {
    const id = `${route.providerId}:${route.keyId}`;
    const now = Date.now();
    const state = this.states.get(id) || { active: 0, recent: [], failures: 0, openUntil: 0 };
    if (state.openUntil > now) throw Object.assign(new Error('provider route is cooling down'), { status: 503, code: 'provider_circuit_open' });
    const limit = Number(route.provider.bucketMax || 0);
    if (limit > 0 && state.active >= limit) throw Object.assign(new Error('provider route is at capacity'), { status: 503, code: 'provider_capacity' });
    const rpm = Number(route.provider.rateLimits?.rpm || route.provider.rateLimits?.['1k'] || 0);
    state.recent = state.recent.filter((timestamp) => timestamp > now - 60000);
    if (rpm > 0 && state.recent.length >= rpm) throw Object.assign(new Error('provider route is rate limited'), { status: 429, code: 'provider_rate_limited' });
    state.active += 1;
    state.recent.push(now);
    this.states.set(id, state);
    let released = false;
    return { release: (success) => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      state.failures = success ? 0 : state.failures + 1;
      if (state.failures >= 3) state.openUntil = Date.now() + Number(route.provider.cooldownMs || 60000);
    } };
  }
}

class TaskService {
  constructor({ store, routeService, providerSubmit = submitProviderJob, logger = console, capacityGate = new CapacityGate() } = {}) {
    this.store = store;
    this.routeService = routeService;
    this.providerSubmit = providerSubmit;
    this.logger = logger;
    this.capacityGate = capacityGate;
    this.events = new Map();
    this.controllers = new Map();
  }

  async create({ userId, request }) {
    if (!userId) throw Object.assign(new Error('user identity is required'), { status: 401, code: 'unauthorized' });
    const idempotencyKey = String(request?.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw Object.assign(new Error('idempotencyKey is required and must be <= 200 characters'), { status: 400, code: 'invalid_request' });
    const prompt = String(request?.prompt || '').trim();
    if (!prompt) throw Object.assign(new Error('prompt is required'), { status: 400, code: 'invalid_request' });
    const modelId = String(request.modelId || request.model || '').trim();
    if (!modelId) throw Object.assign(new Error('modelId is required'), { status: 400, code: 'invalid_request' });
    const normalizedRequest = { ...request, prompt, modelId, idempotencyKey };
    const input = { taskId: `task_${randomUUID()}`, userId, idempotencyKey, modelId, requestHash: requestHash(normalizedRequest), request: normalizedRequest };
    const result = await this.store.create(input);
    if (!result.created) {
      if (result.row.requestHash && result.row.requestHash !== input.requestHash) throw Object.assign(new Error('idempotencyKey was reused with a different request'), { status: 409, code: 'idempotency_conflict' });
      return { status: 'pending', taskId: result.row.taskId, modelId: result.row.modelId };
    }
    this.emit(result.row);
    queueMicrotask(() => this.run(result.row.taskId));
    return { status: 'pending', taskId: result.row.taskId, modelId: result.row.modelId };
  }

  async get({ taskId, userId }) {
    const row = await this.store.get(taskId);
    if (!row || row.userId !== userId) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    return publicSnapshot(row);
  }

  async cancel({ taskId, userId }) {
    const row = await this.store.get(taskId);
    if (!row || row.userId !== userId) throw Object.assign(new Error('task not found'), { status: 404, code: 'not_found' });
    if (TERMINAL.has(row.state)) throw Object.assign(new Error('task is already terminal'), { status: 409, code: 'task_terminal' });
    const updated = await this.store.transition(taskId, ['queued', 'running', 'waiting'], { state: 'canceled', error: 'canceled by user' });
    if (!updated) return this.cancel({ taskId, userId });
    this.controllers.get(taskId)?.abort();
    this.emit(updated);
    return publicSnapshot(updated);
  }

  subscribe(taskId, listener) {
    const emitter = this.events.get(taskId) || new EventEmitter();
    this.events.set(taskId, emitter);
    emitter.on('update', listener);
    return () => emitter.off('update', listener);
  }

  emit(row) { this.events.get(row.taskId)?.emit('update', publicSnapshot(row)); }

  async pollAsync(result, route, signal) {
    if (typeof result.poll !== 'function') throw Object.assign(new Error('provider returned an asynchronous job without a poller'), { status: 502, code: 'provider_async_unsupported' });
    const maxPolls = Number(process.env.MODEL_RELAY_MAX_POLLS || 60);
    const delayMs = Number(process.env.MODEL_RELAY_POLL_DELAY_MS || 2000);
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (signal.aborted) throw Object.assign(new Error('generation canceled'), { name: 'AbortError', code: 'aborted' });
      if (attempt) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('generation canceled'), { name: 'AbortError', code: 'aborted' })); }, { once: true }); });
      const snapshot = await result.poll({ provider: route.provider, providerTaskId: result.providerTaskId, apiKey: route.apiKey, signal });
      if (snapshot.done) return snapshot.result || {};
    }
    throw new ProviderError('provider task timed out', { code: 'provider_timeout', status: 504, retryable: true });
  }

  async run(taskId) {
    let row = await this.store.get(taskId);
    if (!row || TERMINAL.has(row.state)) return;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    let lease;
    let success = false;
    try {
      row = await this.store.transition(taskId, ['queued'], { state: 'running' });
      if (!row) return;
      this.emit(row);
      const route = await this.routeService.selectRoute(row.modelId);
      route.taskId = taskId;
      row = await this.store.update(taskId, { providerId: route.providerId, providerKeyId: route.keyId });
      if (!row || row.state === 'canceled') return;
      this.emit(row);
      lease = this.capacityGate.acquire(route);
      const result = await this.providerSubmit({ provider: route.provider, model: route.upstreamModel, apiKey: route.apiKey, request: row.request, signal: controller.signal });
      let finalResult = result.kind === 'sync' ? result : null;
      if (result.kind === 'async') {
        row = await this.store.transition(taskId, ['running'], { state: 'waiting' });
        if (!row) return;
        this.emit(row);
        finalResult = await this.pollAsync(result, route, controller.signal);
      }
      const done = await this.store.transition(taskId, ['running', 'waiting'], { state: 'done', result: finalResult });
      if (done) { success = true; this.emit(done); }
    } catch (error) {
      const current = await this.store.get(taskId);
      if (!current || current.state === 'canceled' || error.code === 'aborted' || error.name === 'AbortError') return;
      const safeMessage = error instanceof ProviderError || error.code === 'model_route_unavailable' || error.code?.startsWith('provider_') ? error.message : 'generation failed';
      const failed = await this.store.transition(taskId, ['running', 'waiting'], { state: 'failed', error: safeMessage });
      if (failed) this.emit(failed);
      this.logger.error?.('[relay] task failed', { taskId, code: error.code || 'internal_error' });
    } finally {
      lease?.release(success);
      this.controllers.delete(taskId);
    }
  }
}

module.exports = { TaskService, MemoryTaskStore, createDbTaskStore, publicSnapshot, TERMINAL, CapacityGate, requestHash };
