CREATE SCHEMA IF NOT EXISTS model_relay;

CREATE TABLE IF NOT EXISTS model_relay.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_relay.providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'openai-compatible',
  supported_types TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  capacity_model TEXT NOT NULL DEFAULT 'limited',
  rate_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  bucket_max INTEGER,
  cooldown_ms INTEGER NOT NULL DEFAULT 60000,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS model_relay.provider_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_relay.providers(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'manual_cold', 'disabled')),
  weight INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, secret_ciphertext)
);

CREATE TABLE IF NOT EXISTS model_relay.models (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mapping_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'image' CHECK (type IN ('image', 'video', 'text')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  param_template JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS model_relay_models_model_idx ON model_relay.models (model_id);

CREATE TABLE IF NOT EXISTS model_relay.provider_model_bindings (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES model_relay.providers(id) ON DELETE CASCADE,
  upstream_model_name TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_id, provider_id)
);

CREATE TABLE IF NOT EXISTS model_relay.generation_tasks (
  task_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'waiting', 'done', 'failed', 'canceled')),
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error TEXT,
  provider_id TEXT,
  provider_key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS model_relay_tasks_user_idx ON model_relay.generation_tasks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_relay.generation_jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES model_relay.generation_tasks(task_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  chosen_provider_id TEXT,
  chosen_binding_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  route_reason JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS model_relay.generation_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES model_relay.generation_jobs(job_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_key_id TEXT,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

INSERT INTO model_relay.schema_migrations (version)
VALUES ('001_model_relay')
ON CONFLICT (version) DO NOTHING;
