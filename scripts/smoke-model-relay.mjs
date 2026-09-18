const baseUrl = (process.env.MODEL_RELAY_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const internal = process.env.MODEL_RELAY_INTERNAL_TOKEN || '';
const admin = process.env.MODEL_RELAY_ADMIN_TOKEN || '';
const userId = process.env.MODEL_RELAY_SMOKE_USER || 'smoke-user';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.message || ''}`);
  return body;
}

const health = await request('/api/healthz');
if (!health.ok) throw new Error('health check returned not ok');
const models = await request('/v1/models', { headers: { authorization: `Bearer ${internal}`, 'x-user-id': userId } });
console.log(JSON.stringify({ ok: true, database: health.database, availableModels: models.models?.length || 0 }));
if (process.env.MODEL_RELAY_SMOKE_GENERATE === 'true') {
  const model = models.models?.[0];
  if (!model) throw new Error('no model available for generation smoke test');
  const accepted = await request('/v1/generations', { method: 'POST', headers: { authorization: `Bearer ${internal}`, 'x-user-id': userId }, body: JSON.stringify({ modelId: model.modelId, contentType: model.type, prompt: 'smoke test', idempotencyKey: `smoke-${Date.now()}` }) });
  const snapshot = await request(`/v1/tasks/${accepted.taskId}`, { headers: { authorization: `Bearer ${internal}`, 'x-user-id': userId } });
  console.log(JSON.stringify({ taskId: accepted.taskId, initialState: snapshot.state }));
}
