-- =============================================================================
-- Aflow Platform - Database Initialization
-- =============================================================================
-- This script runs automatically when the PostgreSQL container starts.
-- It creates the base tables needed by the platform.
--
-- For full migrations, use: yarn workspace @aflow/database db:migrate
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- PUBLIC SCHEMA - Platform-wide tables
-- =============================================================================

-- Tenants registry
CREATE TABLE IF NOT EXISTS public.tenants (
  tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_name TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  plan TEXT DEFAULT 'free',
  quotas JSONB,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON public.tenants (status);
CREATE INDEX IF NOT EXISTS idx_tenants_schema ON public.tenants (schema_name);

-- Platform audit log
CREATE TABLE IF NOT EXISTS public.platform_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id TEXT,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  tenant_id UUID,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_timestamp 
  ON public.platform_audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant 
  ON public.platform_audit_log (tenant_id);

-- Step type catalog
CREATE TABLE IF NOT EXISTS public.step_type_catalog (
  step_type TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  default_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Model catalog
CREATE TABLE IF NOT EXISTS public.model_catalog (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]',
  context_window INTEGER,
  max_output_tokens INTEGER,
  input_price_per_1m NUMERIC(12, 4),
  output_price_per_1m NUMERIC(12, 4),
  supports_streaming BOOLEAN DEFAULT true,
  supports_tool_calling BOOLEAN DEFAULT false,
  is_available BOOLEAN DEFAULT true,
  reliability_tier INTEGER DEFAULT 2,
  compliance_flags JSONB DEFAULT '[]',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operation catalog
CREATE TABLE IF NOT EXISTS public.operation_catalog (
  operation_id TEXT PRIMARY KEY,
  step_type TEXT NOT NULL REFERENCES public.step_type_catalog(step_type),
  display_name TEXT NOT NULL,
  semantic_description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB,
  side_effects JSONB NOT NULL,
  permissions JSONB,
  is_enabled BOOLEAN DEFAULT true,
  is_experimental BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Platform migrations tracking
CREATE TABLE IF NOT EXISTS public.platform_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

-- =============================================================================
-- SEED DATA
-- =============================================================================

-- Step types
INSERT INTO public.step_type_catalog (step_type, display_name, description)
VALUES 
  ('ai', 'AI', 'AI model operations (generation, embedding, agents)'),
  ('memory', 'Memory', 'Memory operations (read, write, search)'),
  ('api', 'API', 'External API calls'),
  ('compute', 'Compute', 'Code execution'),
  ('search', 'Search', 'Web and data search'),
  ('flow', 'Flow', 'Flow orchestration (dispatch, subflow, abort)'),
  ('user', 'User', 'User interaction (input, approval)'),
  ('platform', 'Platform', 'Platform management operations')
ON CONFLICT (step_type) DO NOTHING;

-- AI Models
INSERT INTO public.model_catalog (model_id, provider, display_name, capabilities, context_window, max_output_tokens, input_price_per_1m, output_price_per_1m, supports_streaming, supports_tool_calling)
VALUES 
  ('gpt-4o', 'openai', 'GPT-4o', '["text", "json", "tools", "vision"]', 128000, 16384, 250, 1000, true, true),
  ('gpt-4o-mini', 'openai', 'GPT-4o Mini', '["text", "json", "tools", "vision"]', 128000, 16384, 15, 60, true, true),
  ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', '["text", "json", "tools", "vision"]', 128000, 4096, 1000, 3000, true, true),
  ('claude-sonnet-4-20250514', 'anthropic', 'Claude Sonnet 4', '["text", "json", "tools", "vision"]', 200000, 16384, 300, 1500, true, true),
  ('claude-3-5-sonnet-20241022', 'anthropic', 'Claude 3.5 Sonnet', '["text", "json", "tools", "vision"]', 200000, 8192, 300, 1500, true, true),
  ('claude-3-opus-20240229', 'anthropic', 'Claude 3 Opus', '["text", "json", "tools", "vision"]', 200000, 4096, 1500, 7500, true, true),
  ('claude-3-haiku-20240307', 'anthropic', 'Claude 3 Haiku', '["text", "json", "tools"]', 200000, 4096, 25, 125, true, true),
  ('gemini-2.0-flash', 'google', 'Gemini 2.0 Flash', '["text", "json", "tools", "vision"]', 1000000, 8192, 10, 40, true, true),
  ('gemini-1.5-pro', 'google', 'Gemini 1.5 Pro', '["text", "json", "tools", "vision"]', 2000000, 8192, 125, 500, true, true),
  ('gemini-1.5-flash', 'google', 'Gemini 1.5 Flash', '["text", "json", "tools", "vision"]', 1000000, 8192, 7.5, 30, true, true)
ON CONFLICT (model_id) DO UPDATE SET
  provider = EXCLUDED.provider,
  display_name = EXCLUDED.display_name,
  capabilities = EXCLUDED.capabilities,
  context_window = EXCLUDED.context_window,
  max_output_tokens = EXCLUDED.max_output_tokens,
  input_price_per_1m = EXCLUDED.input_price_per_1m,
  output_price_per_1m = EXCLUDED.output_price_per_1m,
  supports_streaming = EXCLUDED.supports_streaming,
  supports_tool_calling = EXCLUDED.supports_tool_calling,
  updated_at = NOW();

-- Record initial migration
INSERT INTO public.platform_migrations (version, description)
VALUES (1, 'Initial database setup via init-db.sql')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- DEVELOPMENT TENANT
-- =============================================================================
-- Create a default development tenant row for local testing.
-- The actual tenant SCHEMA (tables, indexes) is created by `yarn db:migrate`
-- via createTenantSchema() — never duplicate table DDL here.

INSERT INTO public.tenants (tenant_id, schema_name, name, status, plan)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  't_a0000000000000000000000000000001',
  'Development Tenant',
  'active',
  'free'
)
ON CONFLICT (tenant_id) DO NOTHING;

-- =============================================================================
-- COMPLETE
-- =============================================================================
DO $$
BEGIN
  RAISE NOTICE 'Aflow database initialized successfully!';
END $$;
