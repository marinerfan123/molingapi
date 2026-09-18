'use strict';

const fs = require('node:fs');
const { createPool, migrate, transaction } = require('../server/db.cjs');

function assertSafe(value, key = '') {
  if (/(secret|api.?key|ciphertext|token|password)/i.test(key)) throw new Error(`secret-like field is not allowed in import: ${key}`);
  if (Array.isArray(value)) return value.forEach((item) => assertSafe(item, key));
  if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) assertSafe(child, childKey);
}

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('usage: node scripts/import-model-hub.cjs <export.json>');
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assertSafe(data);
  if (data.version !== 1) throw new Error('unsupported export version');
  const pool = createPool();
  await migrate(pool);
  await transaction(pool, async (client) => {
    for (const row of data.providers || []) await client.query(`INSERT INTO model_relay.providers (id,name,base_url,protocol,supported_types,enabled,capacity_model,rate_limits,bucket_max,cooldown_ms,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,base_url=EXCLUDED.base_url,protocol=EXCLUDED.protocol,supported_types=EXCLUDED.supported_types,enabled=EXCLUDED.enabled,capacity_model=EXCLUDED.capacity_model,rate_limits=EXCLUDED.rate_limits,bucket_max=EXCLUDED.bucket_max,cooldown_ms=EXCLUDED.cooldown_ms`, [row.id,row.name,row.base_url,row.protocol,row.supported_types || [],row.enabled,row.capacity_model || 'limited',JSON.stringify(row.rate_limits || {}),row.bucket_max,row.cooldown_ms || 60000,row.revision || 1]);
    for (const row of data.models || []) await client.query(`INSERT INTO model_relay.models (id,model_id,display_name,mapping_name,type,enabled,capabilities,param_template,sort_order,revision) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,mapping_name=EXCLUDED.mapping_name,type=EXCLUDED.type,enabled=EXCLUDED.enabled,capabilities=EXCLUDED.capabilities,param_template=EXCLUDED.param_template,sort_order=EXCLUDED.sort_order`, [row.id,row.model_id,row.display_name,row.mapping_name || '',row.type,row.enabled,JSON.stringify(row.capabilities || {}),JSON.stringify(row.param_template || {}),row.sort_order || 0,row.revision || 1]);
    for (const row of data.bindings || []) await client.query(`INSERT INTO model_relay.provider_model_bindings (id,model_id,provider_id,upstream_model_name,enabled,priority,weight,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (model_id,provider_id) DO UPDATE SET upstream_model_name=EXCLUDED.upstream_model_name,enabled=EXCLUDED.enabled,priority=EXCLUDED.priority,weight=EXCLUDED.weight`, [row.id,row.model_id,row.provider_id,row.upstream_model_name || row.model_id,row.enabled,row.priority || 0,Math.max(1,row.weight || 1),row.revision || 1]);
  });
  console.log(JSON.stringify({ ok: true, providers: (data.providers || []).length, models: (data.models || []).length, bindings: (data.bindings || []).length, keysImported: 0 }));
  await pool.end();
}

main().catch((error) => { console.error(`[import-model-hub] failed: ${error.message}`); process.exit(1); });
