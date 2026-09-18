'use strict';

const { randomUUID } = require('node:crypto');
const { encryptSecret, decryptSecret, maskSecret } = require('./secrets.cjs');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function errorBody(error) {
  const status = Number(error.status || 500);
  const message = status >= 500 ? 'internal server error' : error.message;
  return { status, body: { error: error.code || 'internal_error', message } };
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request body is too large'), { status: 413, code: 'payload_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400, code: 'invalid_json' }); }
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : String(req.headers['x-internal-token'] || '');
}

function requireInternal(req, ctx) {
  if (!ctx.internalToken || bearer(req) !== ctx.internalToken) throw Object.assign(new Error('internal authentication required'), { status: 401, code: 'unauthorized' });
  const userId = String(req.headers['x-user-id'] || '').trim();
  if (!userId) throw Object.assign(new Error('x-user-id is required'), { status: 401, code: 'unauthorized' });
  return userId;
}

function requireAdmin(req, ctx) {
  const token = String(req.headers['x-admin-token'] || bearer(req));
  if (!ctx.adminToken || token !== ctx.adminToken) throw Object.assign(new Error('admin authentication required'), { status: 401, code: 'unauthorized' });
}

function pathParts(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function validateId(value, field) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) throw Object.assign(new Error(`${field} is invalid`), { status: 400, code: 'invalid_request' });
  return normalized;
}

function parseObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const parts = pathParts(url.pathname);
  try {
    if (req.method === 'GET' && (url.pathname === '/api/healthz' || url.pathname === '/healthz')) {
      return sendJson(res, 200, await ctx.health());
    }

    if (parts[0] === 'v1') {
      const userId = requireInternal(req, ctx);
      if (req.method === 'GET' && parts[1] === 'models') return sendJson(res, 200, { models: await ctx.routeService.listAvailableModels() });
      if (req.method === 'POST' && parts[1] === 'generations') {
        const body = await readJson(req);
        return sendJson(res, 202, await ctx.taskService.create({ userId, request: body }));
      }
      if (parts[1] === 'tasks' && parts[2]) {
        const taskId = validateId(parts[2], 'taskId');
        if (req.method === 'GET' && !parts[3]) return sendJson(res, 200, await ctx.taskService.get({ taskId, userId }));
        if (req.method === 'POST' && parts[3] === 'cancel') return sendJson(res, 200, await ctx.taskService.cancel({ taskId, userId }));
        if (req.method === 'GET' && parts[3] === 'events') {
          const initial = await ctx.taskService.get({ taskId, userId });
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
          if (['done', 'failed', 'canceled'].includes(initial.state)) return res.end();
          const unsubscribe = ctx.taskService.subscribe(taskId, (snapshot) => {
            res.write(`event: task\ndata: ${JSON.stringify(snapshot)}\n\n`);
            if (['done', 'failed', 'canceled'].includes(snapshot.state)) {
              unsubscribe();
              res.end();
            }
          });
          req.on('close', unsubscribe);
          return undefined;
        }
      }
      throw Object.assign(new Error('route not found'), { status: 404, code: 'not_found' });
    }

    if (parts[0] === 'api') {
      requireAdmin(req, ctx);
      if (req.method === 'GET' && parts[1] === 'providers' && !parts[2]) return sendJson(res, 200, { providers: await ctx.routeService.listProviders() });
      if (req.method === 'GET' && parts[1] === 'models' && !parts[2]) return sendJson(res, 200, { models: await ctx.routeService.listAdminModels() });
      if (parts[1] === 'providers' && parts[2]) {
        const providerId = validateId(parts[2], 'providerId');
        if (req.method === 'GET' && parts[3] === 'keys') {
          const result = await ctx.pool.query('SELECT id, label, status, weight, consecutive_failures, last_failure_at, last_used_at, secret_ciphertext FROM model_relay.provider_keys WHERE provider_id=$1 ORDER BY created_at', [providerId]);
          return sendJson(res, 200, { keys: result.rows.map((row) => ({ id: row.id, label: row.label, status: row.status, weight: row.weight, masked: maskSecret(decryptSecret(row.secret_ciphertext)), consecutiveFailures: row.consecutive_failures, lastFailureAt: row.last_failure_at, lastUsedAt: row.last_used_at })) });
        }
        if (req.method === 'POST' && parts[3] === 'keys') {
          const body = await readJson(req);
          const secret = String(body.secret || '');
          if (!secret) throw Object.assign(new Error('secret is required'), { status: 400, code: 'invalid_request' });
          const id = validateId(body.id || `key_${randomUUID()}`, 'key id');
          await ctx.pool.query('INSERT INTO model_relay.provider_keys (id, provider_id, secret_ciphertext, label, weight) VALUES ($1,$2,$3,$4,$5)', [id, providerId, encryptSecret(secret), String(body.label || ''), Math.max(1, Number(body.weight || 1))]);
          return sendJson(res, 201, { id, label: String(body.label || ''), masked: maskSecret(secret), status: 'active' });
        }
        if (req.method === 'DELETE' && parts[3] === 'keys' && parts[4]) {
          await ctx.pool.query('DELETE FROM model_relay.provider_keys WHERE id=$1 AND provider_id=$2', [validateId(parts[4], 'key id'), providerId]);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'PATCH' && !parts[3]) {
          const body = await readJson(req);
          if (!Number.isInteger(body.revision)) throw Object.assign(new Error('revision is required'), { status: 400, code: 'revision_required' });
          const updates = [];
          const values = [];
          const allowed = { name: 'name', baseUrl: 'base_url', protocol: 'protocol', supportedTypes: 'supported_types', enabled: 'enabled', capacityModel: 'capacity_model', rateLimits: 'rate_limits', bucketMax: 'bucket_max', cooldownMs: 'cooldown_ms' };
          for (const [key, column] of Object.entries(allowed)) if (body[key] !== undefined) { values.push(key === 'rateLimits' ? JSON.stringify(parseObject(body[key])) : body[key]); updates.push(`${column}=$${values.length}${key === 'rateLimits' ? '::jsonb' : ''}`); }
          if (!updates.length) return sendJson(res, 200, { ok: true });
          values.push(providerId, body.revision);
          const result = await ctx.pool.query(`UPDATE model_relay.providers SET ${updates.join(', ')}, revision=revision+1, updated_at=NOW() WHERE id=$${values.length - 1} AND revision=$${values.length} RETURNING revision`, values);
          if (!result.rows[0]) throw Object.assign(new Error('provider was changed by another administrator'), { status: 409, code: 'revision_conflict' });
          return sendJson(res, 200, { ok: true, revision: result.rows[0].revision });
        }
      }
      if (parts[1] === 'providers' && req.method === 'POST' && !parts[2]) {
        const body = await readJson(req);
        const id = validateId(body.id, 'provider id');
        await ctx.pool.query('INSERT INTO model_relay.providers (id,name,base_url,protocol,supported_types,capacity_model) VALUES ($1,$2,$3,$4,$5,$6)', [id, String(body.name || id), String(body.baseUrl || ''), body.protocol === 'custom' ? 'custom' : 'openai-compatible', body.supportedTypes || ['image'], body.capacityModel || 'limited']);
        if (body.secret) await ctx.pool.query('INSERT INTO model_relay.provider_keys (id,provider_id,secret_ciphertext,label) VALUES ($1,$2,$3,$4)', [`key_${randomUUID()}`, id, encryptSecret(String(body.secret)), String(body.keyLabel || 'primary')]);
        return sendJson(res, 201, { id });
      }
      if (parts[1] === 'models' && req.method === 'POST' && !parts[2]) {
        const body = await readJson(req);
        const id = validateId(body.id || `model_${randomUUID()}`, 'model id');
        const modelId = validateId(body.modelId, 'modelId');
        await ctx.pool.query('INSERT INTO model_relay.models (id,model_id,display_name,mapping_name,type,capabilities,param_template,sort_order) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [id, modelId, String(body.displayName || modelId), String(body.mappingName || ''), body.type || 'image', JSON.stringify(parseObject(body.capabilities)), JSON.stringify(parseObject(body.paramTemplate)), Number(body.sortOrder || 0)]);
        return sendJson(res, 201, { id, modelId });
      }
      if (parts[1] === 'models' && parts[2] && req.method === 'PATCH') {
        const modelId = validateId(parts[2], 'model id');
        const body = await readJson(req);
        if (!Number.isInteger(body.revision)) throw Object.assign(new Error('revision is required'), { status: 400, code: 'revision_required' });
        const updates = [];
        const values = [];
        const allowed = { displayName: 'display_name', mappingName: 'mapping_name', type: 'type', enabled: 'enabled', capabilities: 'capabilities', paramTemplate: 'param_template', sortOrder: 'sort_order' };
        for (const [key, column] of Object.entries(allowed)) if (body[key] !== undefined) { values.push(['capabilities', 'paramTemplate'].includes(key) ? JSON.stringify(parseObject(body[key])) : body[key]); updates.push(`${column}=$${values.length}${['capabilities', 'paramTemplate'].includes(key) ? '::jsonb' : ''}`); }
        if (!updates.length) return sendJson(res, 200, { ok: true });
        values.push(modelId, body.revision);
        const result = await ctx.pool.query(`UPDATE model_relay.models SET ${updates.join(', ')}, revision=revision+1, updated_at=NOW() WHERE id=$${values.length - 1} AND revision=$${values.length} RETURNING revision`, values);
        if (!result.rows[0]) throw Object.assign(new Error('model was changed by another administrator'), { status: 409, code: 'revision_conflict' });
        return sendJson(res, 200, { ok: true, revision: result.rows[0].revision });
      }
      if (parts[1] === 'bindings' && req.method === 'POST') {
        const body = await readJson(req);
        const id = validateId(body.id || `binding_${randomUUID()}`, 'binding id');
        await ctx.pool.query('INSERT INTO model_relay.provider_model_bindings (id,model_id,provider_id,upstream_model_name,priority,weight) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (model_id,provider_id) DO UPDATE SET upstream_model_name=EXCLUDED.upstream_model_name, enabled=TRUE', [id, validateId(body.modelId, 'modelId'), validateId(body.providerId, 'providerId'), String(body.upstreamModelName || body.modelId), Number(body.priority || 0), Math.max(1, Number(body.weight || 1))]);
        return sendJson(res, 201, { id });
      }
      throw Object.assign(new Error('route not found'), { status: 404, code: 'not_found' });
    }

    throw Object.assign(new Error('route not found'), { status: 404, code: 'not_found' });
  } catch (error) {
    const { status, body } = errorBody(error);
    if (!res.headersSent) sendJson(res, status, body); else res.end();
  }
}

module.exports = { handle, readJson };
