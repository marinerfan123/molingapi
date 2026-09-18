'use strict';

class ProviderError extends Error {
  constructor(message, { code = 'provider_error', status = 502, retryable = false, details } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

function imageBody(model, request) {
  const body = {
    model,
    prompt: request.prompt,
    n: Math.min(Math.max(Number(request.count || 1), 1), 4),
  };
  const size = request.resolution || request.ratio;
  if (size) body.size = size;
  if (request.quality) body.quality = request.quality;
  if (request.negative) body.negative_prompt = request.negative;
  if (Array.isArray(request.referenceImages) && request.referenceImages.length) body.reference_images = request.referenceImages;
  return body;
}

function textBody(model, request) {
  return {
    model,
    messages: [{ role: 'user', content: request.prompt }],
  };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function normalizeResult(payload, type) {
  const images = Array.isArray(payload.data)
    ? payload.data.map((item) => item?.url || item?.b64_json).filter(Boolean)
    : [];
  if (images.length) return { images };
  if (payload.video_url || payload.url) return { videoUrl: payload.video_url || payload.url };
  const text = payload.choices?.[0]?.message?.content || payload.output_text || payload.text;
  if (text) return { text };
  if (type === 'video' && payload.id) return { providerTaskId: payload.id };
  return {};
}

async function submitProviderJob({ provider, model, apiKey, request, signal, fetchImpl = globalThis.fetch }) {
  if (!provider?.baseUrl || !apiKey) throw new ProviderError('provider is not configured', { code: 'provider_config_error', status: 503 });
  if (typeof fetchImpl !== 'function') throw new ProviderError('fetch is unavailable', { code: 'provider_client_error', status: 500 });

  const type = request.contentType || 'image';
  const pathName = provider.protocol === 'custom'
    ? provider.endpoint?.path || '/generate'
    : type === 'image' ? '/images/generations' : type === 'text' ? '/chat/completions' : '/videos';
  const body = provider.protocol === 'custom' && provider.endpoint?.body
    ? { ...provider.endpoint.body, model, prompt: request.prompt }
    : type === 'text' ? textBody(model, request) : imageBody(model, request);
  let response;
  try {
    response = await fetchImpl(joinUrl(provider.baseUrl, pathName), {
      method: provider.endpoint?.method || 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new ProviderError('provider connection failed', { code: 'provider_network_error', status: 502, retryable: true, details: error.message });
  }
  const raw = await response.text();
  const payload = parseJson(raw);
  if (!response.ok) {
    throw new ProviderError('provider request failed', {
      code: response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      details: payload.error?.message || payload.message || undefined,
    });
  }
  const result = normalizeResult(payload, type);
  if (result.providerTaskId) return { kind: 'async', ...result, poll: provider.endpoint?.poll || null };
  return { kind: 'sync', ...result };
}

module.exports = { ProviderError, submitProviderJob, joinUrl };
