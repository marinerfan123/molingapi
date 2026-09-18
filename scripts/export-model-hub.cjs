'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPool, migrate } = require('../server/db.cjs');

async function main() {
  const output = process.argv[2] || path.join(process.cwd(), 'model-hub-export.json');
  const pool = createPool();
  await migrate(pool);
  const [providers, models, bindings] = await Promise.all([
    pool.query('SELECT id,name,base_url,protocol,supported_types,enabled,capacity_model,rate_limits,bucket_max,cooldown_ms,revision FROM model_relay.providers ORDER BY id'),
    pool.query('SELECT id,model_id,display_name,mapping_name,type,enabled,capabilities,param_template,sort_order,revision FROM model_relay.models ORDER BY sort_order,id'),
    pool.query('SELECT id,model_id,provider_id,upstream_model_name,enabled,priority,weight,revision FROM model_relay.provider_model_bindings ORDER BY id'),
  ]);
  const data = { version: 1, exportedAt: new Date().toISOString(), providers: providers.rows, models: models.rows, bindings: bindings.rows, keyPolicy: 'provider keys are intentionally excluded; migrate them only through server-side re-encryption' };
  fs.writeFileSync(output, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, output, providers: data.providers.length, models: data.models.length, bindings: data.bindings.length, containsSecrets: false }));
  await pool.end();
}

main().catch((error) => { console.error(`[export-model-hub] failed: ${error.message}`); process.exit(1); });
