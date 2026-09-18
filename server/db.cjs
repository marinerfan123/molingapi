'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function createPool() {
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PG_HOST || '127.0.0.1',
        port: Number(process.env.PG_PORT || 5432),
        database: process.env.PG_DATABASE || 'molingapi',
        user: process.env.PG_USER || 'molingapi',
        password: process.env.PG_PASSWORD || '',
      };
  if (process.env.PG_SSLMODE === 'disable') config.ssl = false;
  if (process.env.PG_SSLMODE === 'require') config.ssl = { rejectUnauthorized: false };
  return new Pool({ ...config, max: Number(process.env.PG_POOL_MAX || 10), connectionTimeoutMillis: 5000 });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_model_relay.sql'), 'utf8');
  await pool.query(sql);
}

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, transaction };
