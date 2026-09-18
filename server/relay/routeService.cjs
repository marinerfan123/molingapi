'use strict';

const { randomInt } = require('node:crypto');
const { decryptSecret, maskSecret } = require('./secrets.cjs');

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function weightedPick(candidates) {
  if (!candidates.length) return null;
  const ranked = [...candidates].sort((a, b) => (b.priority - a.priority) || (b.weight - a.weight) || a.providerId.localeCompare(b.providerId));
  const topPriority = ranked[0].priority;
  const top = ranked.filter((item) => item.priority === topPriority);
  const total = top.reduce((sum, item) => sum + Math.max(1, Number(item.weight || 1)), 0);
  let cursor = randomInt(total);
  for (const item of top) {
    cursor -= Math.max(1, Number(item.weight || 1));
    if (cursor < 0) return item;
  }
  return top[0];
}

class RouteService {
  constructor({ pool, decrypt = decryptSecret } = {}) {
    this.pool = pool;
    this.decrypt = decrypt;
  }

  async listAvailableModels() {
    const result = await this.pool.query(`
      SELECT m.id, m.model_id, m.display_name, m.mapping_name, m.type, m.enabled,
             m.capabilities, m.param_template, m.sort_order,
             ARRAY_AGG(DISTINCT p.id ORDER BY p.id) AS provider_ids
      FROM model_relay.models m
      JOIN model_relay.provider_model_bindings b ON b.model_id = m.model_id AND b.enabled = TRUE
      JOIN model_relay.providers p ON p.id = b.provider_id AND p.enabled = TRUE
      JOIN model_relay.provider_keys k ON k.provider_id = p.id AND k.status = 'active'
      WHERE m.enabled = TRUE
      GROUP BY m.id
      ORDER BY m.sort_order ASC, m.display_name ASC
    `);
    return result.rows.map((row) => ({
      id: row.id,
      modelId: row.model_id,
      displayName: row.display_name,
      mappingName: row.mapping_name || undefined,
      type: row.type,
      enabled: row.enabled,
      providerIds: row.provider_ids || [],
      capabilities: parseJson(row.capabilities),
      paramTemplate: parseJson(row.param_template),
      sortOrder: row.sort_order || 0,
    }));
  }

  async selectRoute(modelId) {
    const result = await this.pool.query(`
      SELECT m.model_id, m.type, b.id AS binding_id, b.provider_id, b.upstream_model_name,
             b.priority, b.weight, p.name AS provider_name, p.base_url, p.protocol,
             p.supported_types, p.capacity_model, p.rate_limits, p.bucket_max, p.cooldown_ms,
             k.id AS key_id, k.secret_ciphertext, k.label
      FROM model_relay.models m
      JOIN model_relay.provider_model_bindings b ON b.model_id = m.model_id AND b.enabled = TRUE
      JOIN model_relay.providers p ON p.id = b.provider_id AND p.enabled = TRUE
      JOIN model_relay.provider_keys k ON k.provider_id = p.id AND k.status = 'active'
      WHERE m.model_id = $1 AND m.enabled = TRUE
      ORDER BY b.priority DESC, b.weight DESC, p.id, k.id
    `, [modelId]);
    const candidates = [];
    for (const row of result.rows) {
      try {
        candidates.push({
          modelId: row.model_id,
          contentType: row.type,
          bindingId: row.binding_id,
          providerId: row.provider_id,
          provider: {
            id: row.provider_id,
            name: row.provider_name,
            baseUrl: row.base_url,
            protocol: row.protocol,
            supportedTypes: row.supported_types || [],
            capacityModel: row.capacity_model,
            rateLimits: parseJson(row.rate_limits),
            bucketMax: row.bucket_max,
            cooldownMs: row.cooldown_ms,
          },
          keyId: row.key_id,
          apiKey: this.decrypt(row.secret_ciphertext),
          maskedKey: maskSecret(this.decrypt(row.secret_ciphertext)),
          upstreamModel: row.upstream_model_name || modelId,
          priority: Number(row.priority || 0),
          weight: Number(row.weight || 1),
        });
      } catch {
        // A bad key must make a route unavailable, not leak its value or stop all routes.
      }
    }
    const selected = weightedPick(candidates);
    if (!selected) {
      const error = new Error('no enabled provider route for model');
      error.code = 'model_route_unavailable';
      error.status = 503;
      throw error;
    }
    return selected;
  }

  async listProviders() {
    const result = await this.pool.query(`
      SELECT p.id, p.name, p.base_url, p.protocol, p.supported_types, p.enabled,
             COUNT(k.id)::int AS key_count
      FROM model_relay.providers p
      LEFT JOIN model_relay.provider_keys k ON k.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at ASC, p.id ASC
    `);
    return result.rows.map((row) => ({
      id: row.id, name: row.name, baseUrl: row.base_url, protocol: row.protocol,
      supportedTypes: row.supported_types || [], enabled: row.enabled, keyCount: row.key_count,
    }));
  }

  async listAdminModels() {
    const result = await this.pool.query(`
      SELECT m.*, ARRAY(SELECT provider_id FROM model_relay.provider_model_bindings b WHERE b.model_id = m.model_id ORDER BY provider_id) AS provider_ids
      FROM model_relay.models m ORDER BY m.sort_order ASC, m.created_at ASC
    `);
    return result.rows.map((row) => ({
      id: row.id, modelId: row.model_id, displayName: row.display_name, mappingName: row.mapping_name,
      type: row.type, enabled: row.enabled, providerIds: row.provider_ids || [],
      capabilities: parseJson(row.capabilities), paramTemplate: parseJson(row.param_template),
      sortOrder: row.sort_order, revision: row.revision,
    }));
  }
}

module.exports = { RouteService, weightedPick };
