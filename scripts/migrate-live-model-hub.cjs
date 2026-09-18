'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createPool, migrate, transaction } = require('../server/db.cjs');
const { encryptSecret } = require('../server/relay/secrets.cjs');

function idForModel(modelId) { return `model_${crypto.createHash('sha256').update(modelId).digest('hex').slice(0, 20)}`; }
function safeJson(value) { return value && typeof value === 'object' ? value : {}; }

async function optional(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows; } catch (error) { if (/does not exist|column .* does not exist/i.test(error.message)) return []; throw error; }
}

async function main() {
  if (!process.env.MODEL_RELAY_MASTER_KEY) throw new Error('MODEL_RELAY_MASTER_KEY is required');
  const target = createPool();
  const source = process.env.SOURCE_DATABASE_URL ? new Pool({ connectionString: process.env.SOURCE_DATABASE_URL }) : target;
  await target.query('SELECT 1');
  await migrate(target);

  const providers = await source.query(`SELECT id, name, base_url, protocol, supported_types, enabled, capacity_model, rate_limits, bucket_max, cooldown_ms, api_key FROM public.providers`);
  const models = await source.query(`SELECT id, model_id, display_name, mapping_name, type, enabled, capabilities, param_template, sort_order, provider_id FROM public.models`);
  const sourceBindings = await optional(source, `SELECT id, model_id, provider_id, upstream_model_name, enabled, priority, weight FROM public.provider_model_bindings`);
  const sourceKeys = await optional(source, `SELECT id, provider_id, api_key, label, status, weight FROM public.api_keys`);
  const bindings = sourceBindings.length ? sourceBindings : models.rows.filter((row) => row.provider_id).map((row) => ({ id: `legacy_${row.id}`, model_id: row.model_id, provider_id: row.provider_id, upstream_model_name: row.model_id, enabled: row.enabled, priority: 0, weight: 1 }));
  let keyCount = 0;
  await transaction(target, async (client) => {
    for (const row of providers.rows) {
      await client.query(`INSERT INTO model_relay.providers (id,name,base_url,protocol,supported_types,enabled,capacity_model,rate_limits,bucket_max,cooldown_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,base_url=EXCLUDED.base_url,protocol=EXCLUDED.protocol,supported_types=EXCLUDED.supported_types,enabled=EXCLUDED.enabled,capacity_model=EXCLUDED.capacity_model,rate_limits=EXCLUDED.rate_limits,bucket_max=EXCLUDED.bucket_max,cooldown_ms=EXCLUDED.cooldown_ms,updated_at=NOW()`, [row.id, row.name, row.base_url || '', row.protocol || 'openai-compatible', row.supported_types || [], row.enabled !== false, row.capacity_model || 'limited', JSON.stringify(safeJson(row.rate_limits)), row.bucket_max, row.cooldown_ms || 60000]);
    }
    const logical = new Map();
    for (const row of models.rows) {
      if (!logical.has(row.model_id)) logical.set(row.model_id, row);
    }
    for (const row of logical.values()) {
      await client.query(`INSERT INTO model_relay.models (id,model_id,display_name,mapping_name,type,enabled,capabilities,param_template,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,mapping_name=EXCLUDED.mapping_name,type=EXCLUDED.type,enabled=EXCLUDED.enabled,capabilities=EXCLUDED.capabilities,param_template=EXCLUDED.param_template,sort_order=EXCLUDED.sort_order,updated_at=NOW()`, [idForModel(row.model_id), row.model_id, row.display_name || row.model_id, row.mapping_name || '', row.type || 'image', row.enabled !== false, JSON.stringify(safeJson(row.capabilities)), JSON.stringify(safeJson(row.param_template)), row.sort_order || 0]);
    }
    for (const row of bindings) {
      await client.query(`INSERT INTO model_relay.provider_model_bindings (id,model_id,provider_id,upstream_model_name,enabled,priority,weight) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (model_id,provider_id) DO UPDATE SET upstream_model_name=EXCLUDED.upstream_model_name,enabled=EXCLUDED.enabled,priority=EXCLUDED.priority,weight=EXCLUDED.weight,updated_at=NOW()`, [`binding_${row.id}`, row.model_id, row.provider_id, row.upstream_model_name || row.model_id, row.enabled !== false, row.priority || 0, Math.max(1, row.weight || 1)]);
    }
    const keysByProvider = new Map();
    for (const row of sourceKeys) keysByProvider.set(row.provider_id, [...(keysByProvider.get(row.provider_id) || []), row]);
    for (const provider of providers.rows) {
      const keys = keysByProvider.get(provider.id) || (provider.api_key ? [{ id: `legacy_${provider.id}`, provider_id: provider.id, api_key: provider.api_key, label: 'legacy primary', status: 'active', weight: 1 }] : []);
      for (const key of keys) {
        if (!key.api_key) continue;
        // Encryption uses a random IV, so the stable source key ID is the idempotency key.
        await client.query(`INSERT INTO model_relay.provider_keys (id,provider_id,secret_ciphertext,label,status,weight) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id,secret_ciphertext=EXCLUDED.secret_ciphertext,label=EXCLUDED.label,status=EXCLUDED.status,weight=EXCLUDED.weight,updated_at=NOW()`, [`key_${key.id}`, provider.id, encryptSecret(key.api_key), key.label || '', ['active', 'manual_cold', 'disabled'].includes(key.status) ? key.status : 'active', Math.max(1, key.weight || 1)]);
        keyCount++;
      }
    }
  });
  console.log(JSON.stringify({ ok: true, providers: providers.rowCount, logicalModels: new Set(models.rows.map((row) => row.model_id)).size, bindings: bindings.length, keysProcessed: keyCount }));
  if (source !== target) await source.end();
  await target.end();
}

main().catch((error) => { console.error(`[migrate-live-model-hub] failed: ${error.message}`); process.exit(1); });
