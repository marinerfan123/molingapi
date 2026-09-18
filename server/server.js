'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createPool, migrate } = require('./db.cjs');
const { RouteService } = require('./relay/routeService.cjs');
const { TaskService, MemoryTaskStore, createDbTaskStore } = require('./relay/taskService.cjs');
const { handle } = require('./relay/httpRoutes.cjs');

function loadEnvFile() {
  const filename = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function main() {
  loadEnvFile();
  const production = process.env.NODE_ENV === 'production';
  const memoryAllowed = !production && process.env.MODEL_RELAY_ALLOW_MEMORY === 'true';
  if (production && (!process.env.MODEL_RELAY_MASTER_KEY || !process.env.MODEL_RELAY_INTERNAL_TOKEN || !process.env.MODEL_RELAY_ADMIN_TOKEN)) {
    throw new Error('production requires MODEL_RELAY_MASTER_KEY, MODEL_RELAY_INTERNAL_TOKEN and MODEL_RELAY_ADMIN_TOKEN');
  }

  let pool = null;
  if (!memoryAllowed) {
    pool = createPool();
    await pool.query('SELECT 1');
    await migrate(pool);
  }

  const routeService = pool
    ? new RouteService({ pool })
    : { listAvailableModels: async () => [], listProviders: async () => [], listAdminModels: async () => [], selectRoute: async () => { throw Object.assign(new Error('database is disabled'), { status: 503, code: 'database_unavailable' }); } };
  const store = pool ? createDbTaskStore(pool) : new MemoryTaskStore();
  const taskService = new TaskService({ store, routeService });
  const port = Number(process.env.PORT || 3010);
  const publicIndex = path.join(__dirname, '..', 'public', 'index.html');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(publicIndex));
    }
    return handle(req, res, {
      pool,
      internalToken: process.env.MODEL_RELAY_INTERNAL_TOKEN || '',
      adminToken: process.env.MODEL_RELAY_ADMIN_TOKEN || '',
      routeService,
      taskService,
      health: async () => {
        let database = 'disabled';
        if (pool) {
          try { await pool.query('SELECT 1'); database = 'ok'; } catch { database = 'error'; }
        }
        return { ok: database === 'ok' || memoryAllowed, service: 'molingapi', database, version: '0.1.0' };
      },
    });
  });

  const shutdown = async () => {
    server.close();
    if (pool) await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(port, '0.0.0.0', () => console.log(`[molingapi] listening on ${port}`));
}

main().catch((error) => {
  console.error('[molingapi] startup failed:', error.message);
  process.exit(1);
});
