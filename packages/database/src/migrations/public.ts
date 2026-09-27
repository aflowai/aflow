/**
 * Public schema migrations.
 * Run these to set up the platform-level tables.
 */
import type postgres from 'postgres';
import { workflowRunDuePointerDdl } from '../tenant/workflowRunDue.js';
import { TENANT_DUE_POINTERS, WORKFLOW_RUN_DUE_POINTER } from '../tenant/duePointers.js';
import { tenantDuePointerDdl } from '../tenant/tenantDue.js';
import { scheduleDispatchOutboxDdl } from '../tenant/scheduleOutbox.js';
import { projectionFailuresDdl } from '../tenant/projectionFailures.js';
import { timerDeadLettersDdl } from '../tenant/timerDeadLetters.js';

/**
 * Apply public schema migrations.
 */
export async function applyPublicMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- Tenants registry
    CREATE TABLE IF NOT EXISTS public.tenants (
      tenant_id UUID PRIMARY KEY,
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

    -- Step type catalog
    CREATE TABLE IF NOT EXISTS public.step_type_catalog (
      step_type TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT,
      is_enabled BOOLEAN DEFAULT true,
      default_config JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    -- Seed step types
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

    -- Platform migrations tracking
    CREATE TABLE IF NOT EXISTS public.platform_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      description TEXT
    );

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (1, 'Initial public schema creation')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Apply identity & auth migrations (Plans 27-30).
 * Adds: users, user_identities, tenant_memberships, space_memberships,
 *        invites, api_keys, authz_outbox, and platform_audit_log enhancements.
 */
export async function applyIdentityMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- ================================================================
    -- Plan 27: Users, Identity, and Invites
    -- ================================================================

    -- Users table (one row per human or service principal)
    CREATE TABLE IF NOT EXISTS public.users (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name    TEXT NOT NULL,
      email           TEXT,
      avatar_url      TEXT,
      kind            TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'service_principal')),
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'deactivated')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deactivated_at  TIMESTAMPTZ,
      metadata        JSONB DEFAULT '{}'::jsonb
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
      ON public.users (email) WHERE email IS NOT NULL;

    -- User identities (links IdP identities to internal users)
    CREATE TABLE IF NOT EXISTS public.user_identities (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      provider        TEXT NOT NULL,
      provider_sub    TEXT NOT NULL,
      email           TEXT,
      raw_claims      JSONB DEFAULT '{}'::jsonb,
      linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at   TIMESTAMPTZ,
      UNIQUE (provider, provider_sub)
    );

    CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
      ON public.user_identities (user_id);

    -- Tenant memberships (user <-> tenant with role)
    CREATE TABLE IF NOT EXISTS public.tenant_memberships (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'billing')),
      invited_by  UUID REFERENCES public.users(id),
      joined_at   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
      UNIQUE (tenant_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_id
      ON public.tenant_memberships (user_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_id
      ON public.tenant_memberships (tenant_id);

    -- Space memberships (user <-> space with role, public schema for FK to users)
    CREATE TABLE IF NOT EXISTS public.space_memberships (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      space_id    UUID NOT NULL,
      user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, space_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_space_memberships_user_space
      ON public.space_memberships (user_id, tenant_id);

    -- Invites (invite-only onboarding)
    CREATE TABLE IF NOT EXISTS public.invites (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member',
      token       TEXT NOT NULL UNIQUE,
      invited_by  UUID NOT NULL REFERENCES public.users(id),
      expires_at  TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, email)
    );

    -- ================================================================
    -- Plan 29: API Keys
    -- ================================================================

    CREATE TABLE IF NOT EXISTS public.api_keys (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      tenant_id    UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      scopes       JSONB NOT NULL DEFAULT '[]',
      expires_at   TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (revoked_at IS NULL OR revoked_at >= created_at)
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
      ON public.api_keys (key_hash) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id
      ON public.api_keys (user_id);

    -- ================================================================
    -- Plan 28: AuthZ Outbox (Postgres -> OpenFGA tuple sync)
    -- ================================================================

    CREATE TABLE IF NOT EXISTS public.authz_outbox (
      id          BIGSERIAL PRIMARY KEY,
      operation   TEXT NOT NULL CHECK (operation IN ('write', 'delete')),
      tuple_key   JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed   BOOLEAN NOT NULL DEFAULT false,
      processed_at TIMESTAMPTZ,
      error       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_authz_outbox_unprocessed
      ON public.authz_outbox (id) WHERE processed = false;

    -- ================================================================
    -- Plan 30: Enhance platform_audit_log
    -- ================================================================

    ALTER TABLE public.platform_audit_log
      ADD COLUMN IF NOT EXISTS category TEXT,
      ADD COLUMN IF NOT EXISTS outcome TEXT,
      ADD COLUMN IF NOT EXISTS actor_context JSONB,
      ADD COLUMN IF NOT EXISTS target JSONB,
      ADD COLUMN IF NOT EXISTS request_metadata JSONB;

    CREATE TABLE IF NOT EXISTS public.terms_acceptances (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      version     TEXT NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address  TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS terms_acceptances_user_version_unique
      ON public.terms_acceptances (user_id, version);

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (2, 'Plans 27-30: Users, identity, access control, authentication, audit')
    ON CONFLICT (version) DO NOTHING;
  `);
}

export async function applyRecoveryMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- ================================================================
    -- Plan 49A: Durable Recovery Manifest
    -- ================================================================

    -- Tracks non-terminal runs for recovery after Redis loss or shard handoff.
    -- Unlike aflow:dirty:runs (Redis-local), this survives total Redis loss.
    CREATE TABLE IF NOT EXISTS public.recoverable_runs (
      run_id          UUID PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      shard_id        INTEGER NOT NULL,
      status          TEXT NOT NULL,
      last_recovery_seq INTEGER NOT NULL DEFAULT 0,
      latest_snapshot_ref TEXT,
      latest_snapshot_seq INTEGER,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_recoverable_runs_shard
      ON public.recoverable_runs (shard_id, status);
    CREATE INDEX IF NOT EXISTS idx_recoverable_runs_tenant
      ON public.recoverable_runs (tenant_id);

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (3, 'Plan 49A: Durable recovery manifest (recoverable_runs)')
    ON CONFLICT (version) DO NOTHING;
  `);
}

export async function applyOnboardingMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- ================================================================
    -- Plan 64: User Invite & Onboarding
    -- ================================================================

    -- Default space for new users joining this tenant
    ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS default_space_id UUID;

    -- Backfill: for each tenant, set default_space_id to the General space.
    -- Schema names use the t_<hex> convention derived from tenant_id.
    DO $$
    DECLARE
      t RECORD;
      space_uuid UUID;
      real_schema TEXT;
    BEGIN
      FOR t IN SELECT tenant_id FROM public.tenants LOOP
        real_schema := 't_' || replace(t.tenant_id::text, '-', '');
        BEGIN
          EXECUTE format(
            'SELECT id FROM %I.spaces WHERE slug = ''general'' LIMIT 1',
            real_schema
          ) INTO space_uuid;
          IF space_uuid IS NOT NULL THEN
            UPDATE public.tenants SET default_space_id = space_uuid WHERE tenant_id = t.tenant_id;
          END IF;
        EXCEPTION WHEN undefined_table THEN
          -- Schema or table doesn't exist yet — skip
          NULL;
        END;
      END LOOP;
    END $$;

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (4, 'Plan 64: default_space_id on tenants + onboarding')
    ON CONFLICT (version) DO NOTHING;
  `);
}

export async function applyErrorReportsMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- ================================================================
    -- Plan 72: Structured Error Reports
    -- ================================================================

    CREATE TABLE IF NOT EXISTS public.error_reports (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_execution_id TEXT,
      attempt INTEGER,
      flow_id TEXT,
      flow_name TEXT,
      step_id TEXT,
      step_type TEXT,
      operation_id TEXT,
      trace_id TEXT,
      span_id TEXT,
      provider_request_id TEXT,
      classification TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      cause TEXT,
      intent JSONB,
      provider JSONB,
      severity TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      suggested_action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_error_reports_fingerprint ON public.error_reports(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_error_reports_classification ON public.error_reports(classification);
    CREATE INDEX IF NOT EXISTS idx_error_reports_severity ON public.error_reports(severity);
    CREATE INDEX IF NOT EXISTS idx_error_reports_timestamp ON public.error_reports(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_error_reports_run_id ON public.error_reports(run_id);
    CREATE INDEX IF NOT EXISTS idx_error_reports_tenant_id ON public.error_reports(tenant_id);

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (6, 'Plan 72: Structured error reports for developer diagnostics')
    ON CONFLICT (version) DO NOTHING;
  `);
}

export async function applyInviteHardeningMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- ================================================================
    -- Plan 72 Phase 4A: Token hashing
    -- ================================================================

    -- Add token_hash column (nullable initially for backfill)
    ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS token_hash TEXT;

    -- Backfill: hash existing plaintext tokens (only if token column still exists)
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invites' AND column_name = 'token'
      ) THEN
        UPDATE public.invites
          SET token_hash = encode(sha256(token::bytea), 'hex')
          WHERE token_hash IS NULL AND token IS NOT NULL;
      END IF;
    END $$;

    -- Make token_hash NOT NULL + unique after backfill
    ALTER TABLE public.invites ALTER COLUMN token_hash SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_unique ON public.invites (token_hash);

    -- Drop the old plaintext token column and its unique index
    ALTER TABLE public.invites DROP COLUMN IF EXISTS token;

    -- ================================================================
    -- Plan 72 Phase 4B: Acceptance attribution
    -- ================================================================

    ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS accepted_by_user_id UUID
      REFERENCES public.users(id);

    -- ================================================================
    -- Plan 72 Phase 4C: Invite lifecycle status
    -- ================================================================

    ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

    -- Backfill existing rows
    UPDATE public.invites SET status = 'accepted' WHERE accepted_at IS NOT NULL AND status = 'pending';
    UPDATE public.invites SET status = 'expired' WHERE accepted_at IS NULL AND expires_at < now() AND status = 'pending';

    -- Replace blanket unique with lifecycle-aware partial unique index
    -- (only one pending invite per tenant+email at a time). The blanket rule
    -- was declared inline in CREATE TABLE, so Postgres owns its index through
    -- a constraint named invites_tenant_id_email_key: only DROP CONSTRAINT
    -- removes it, and DROP INDEX on that name errors instead of dropping it.
    ALTER TABLE public.invites DROP CONSTRAINT IF EXISTS invites_tenant_id_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS invites_tenant_email_pending_unique
      ON public.invites (tenant_id, email)
      WHERE status = 'pending';

    -- Record this migration
    INSERT INTO public.platform_migrations (version, description)
    VALUES (5, 'Plan 72: invite hardening — token hash, status lifecycle, acceptance attribution')
    ON CONFLICT (version) DO NOTHING;
  `);

  await sqlClient.unsafe(`
    -- Add compute_defaults JSONB column to tenants
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS compute_defaults JSONB;

    -- Egress approval requests — pending/approved/rejected host expansion requests
    CREATE TABLE IF NOT EXISTS public.egress_approval_requests (
      request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'tenant',
      space_id UUID,
      requested_hosts TEXT[] NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_egress_requests_tenant
      ON public.egress_approval_requests (tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_egress_requests_space
      ON public.egress_approval_requests (space_id, status)
      WHERE space_id IS NOT NULL;

    INSERT INTO public.platform_migrations (version, description)
    VALUES (6, 'Plan 101 — Tenant compute defaults + egress approval requests')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Per-tenant OAuth ownership default policy (Plan 185 §4.5). First-class
 * columns on public.tenants (not JSONB) — the per-tenant runner cannot ALTER
 * public.tenants, so these live in the public-schema migration path.
 */
export async function applyOAuthOwnershipMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS oauth_default_owner_scope     text NOT NULL DEFAULT 'tenant',
      ADD COLUMN IF NOT EXISTS oauth_default_client_scope    text NOT NULL DEFAULT 'platform',
      ADD COLUMN IF NOT EXISTS oauth_allow_user_self_connect boolean NOT NULL DEFAULT true;

    INSERT INTO public.platform_migrations (version, description)
    VALUES (7, 'Plan 185 — per-tenant OAuth ownership default policy')
    ON CONFLICT (version) DO NOTHING;
  `);

  // A tenant-wide shared OAuth account was never a real use case (the owner
  // scope is now user|space), and the 'platform' client is CIMD (MCP-only) —
  // an API issuer has no platform client, so a connector binding defaulted to
  // it dead-ends at consent with the provider's invalid_client. Space-BYO is
  // the working default; existing rows holding the old defaults move with it.
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants
      ALTER COLUMN oauth_default_owner_scope  SET DEFAULT 'space',
      ALTER COLUMN oauth_default_client_scope SET DEFAULT 'space';

    UPDATE public.tenants
      SET oauth_default_owner_scope = 'space'
      WHERE oauth_default_owner_scope = 'tenant';

    UPDATE public.tenants
      SET oauth_default_client_scope = 'space'
      WHERE oauth_default_client_scope = 'platform';

    INSERT INTO public.platform_migrations (version, description)
    VALUES (10, 'OAuth ownership defaults: owner space (tenant scope removed), client space-BYO')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Store governance policy: first-class tenant policy columns (integration
 * policy mode, store shelf default, signup policy) plus the tenant-admin
 * integration host allowlist and per-listing store availability overrides.
 */
export async function applyStoreGovernanceMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS integration_policy_mode    text NOT NULL DEFAULT 'open',
      ADD COLUMN IF NOT EXISTS store_default_availability text NOT NULL DEFAULT 'available',
      ADD COLUMN IF NOT EXISTS signup_policy              text NOT NULL DEFAULT 'invite_only';

    CREATE TABLE IF NOT EXISTS public.tenant_integration_allowlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      host_pattern TEXT NOT NULL,
      note TEXT,
      added_by UUID,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_integration_allowlist
      ON public.tenant_integration_allowlist (tenant_id, kind, host_pattern);

    CREATE TABLE IF NOT EXISTS public.tenant_store_overrides (
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      catalog_id TEXT NOT NULL,
      availability TEXT NOT NULL,
      PRIMARY KEY (tenant_id, catalog_id)
    );

    INSERT INTO public.platform_migrations (version, description)
    VALUES (8, 'Plan 244 P0 — tenant integration/store/signup policy + allowlist + listing overrides')
    ON CONFLICT (version) DO NOTHING;
  `);

  await sqlClient.unsafe(`
    ALTER TABLE public.egress_approval_requests
      ADD COLUMN IF NOT EXISTS integration_kind text,
      ADD COLUMN IF NOT EXISTS review_note text;

    INSERT INTO public.platform_migrations (version, description)
    VALUES (9, 'Plan 244 P3 — integration-host requests ride egress_approval_requests')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Public request-access queue feeding the invite flow.
 */
export async function applyInviteRequestMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS public.invite_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
      decided_by UUID REFERENCES public.users(id),
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Only one live request per tenant+email; decided rows stay as history
    CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_tenant_email_pending_unique
      ON public.invite_requests (tenant_id, email)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_invite_requests_tenant_created
      ON public.invite_requests (tenant_id, created_at DESC);

    INSERT INTO public.platform_migrations (version, description)
    VALUES (11, 'Invite requests — public request-access queue for invite-only onboarding')
    ON CONFLICT (version) DO NOTHING;
  `);

  await sqlClient.unsafe(`
    -- Rename before the ADD COLUMNs below, or 'use_case' already exists and the
    -- rename is skipped, stranding the note column with its data.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invite_requests' AND column_name = 'note'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invite_requests' AND column_name = 'use_case'
      ) THEN
        ALTER TABLE public.invite_requests RENAME COLUMN note TO use_case;
      END IF;
    END $$;

    ALTER TABLE public.invite_requests
      ADD COLUMN IF NOT EXISTS use_case TEXT,
      ADD COLUMN IF NOT EXISTS email_canonical TEXT,
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS link TEXT,
      ADD COLUMN IF NOT EXISTS occupation TEXT,
      ADD COLUMN IF NOT EXISTS referral TEXT;

    -- The new pending-unique index keys on email_canonical, and NULLs are
    -- distinct in a Postgres unique index — an unbackfilled legacy row would
    -- silently stop being deduplicated. Seeding it from the stored address
    -- reproduces exactly the old (tenant_id, email) semantics for those rows,
    -- so the index below cannot fail to build.
    UPDATE public.invite_requests SET email_canonical = email WHERE email_canonical IS NULL;

    DROP INDEX IF EXISTS public.invite_requests_tenant_email_pending_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_tenant_email_canonical_pending_unique
      ON public.invite_requests (tenant_id, email_canonical)
      WHERE status = 'pending';

    INSERT INTO public.platform_migrations (version, description)
    VALUES (18, 'Plan 283 — invite request profile fields + canonical-email dedupe key')
    ON CONFLICT (version) DO NOTHING;
  `);
}

export async function applySpaceGrantMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS public.space_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      space_id UUID NOT NULL,
      email TEXT NOT NULL,
      space_role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'pending',
      granted_by UUID NOT NULL REFERENCES public.users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      redeemed_at TIMESTAMPTZ,
      redeemed_by_user_id UUID REFERENCES public.users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS space_grants_pending_unique
      ON public.space_grants (tenant_id, space_id, email)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_space_grants_tenant_email_status
      ON public.space_grants (tenant_id, email, status);

    INSERT INTO public.platform_migrations (version, description)
    VALUES (12, 'Space grants — share-by-email seam, redeemed at admission')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * The cross-tenant due pointer the workflow-run reconciler discovers work
 * through, and the trigger function each tenant schema attaches to its own
 * rows. The per-tenant triggers are installed by the tenant migration.
 */
export async function applyWorkflowRunDueMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ${workflowRunDuePointerDdl()}

    INSERT INTO public.platform_migrations (version, description)
    VALUES (13, 'Workflow-run due pointer — per-tenant candidate index for the run reconciler')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * The remaining cross-tenant due pointers — schedules, OAuth consent state, and
 * pending memory embeddings — plus the trigger function each tenant schema
 * attaches to its own rows. The per-tenant triggers are installed by the tenant
 * migration.
 */
export async function applyTenantDuePointerMigrations(sqlClient: postgres.Sql): Promise<void> {
  const pointers = TENANT_DUE_POINTERS.filter(
    (pointer) => pointer.table !== WORKFLOW_RUN_DUE_POINTER.table,
  );
  await sqlClient.unsafe(`
    ${pointers.map((pointer) => tenantDuePointerDdl(pointer)).join('\n')}

    INSERT INTO public.platform_migrations (version, description)
    VALUES (14, 'Schedule, OAuth-state, and memory-embed due pointers — candidate indexes replacing tenant walks')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * The dispatch outbox a schedule occurrence is recorded in, in the same
 * transaction that advances the schedule past it.
 */
export async function applyScheduleDispatchOutboxMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ${scheduleDispatchOutboxDdl()}

    INSERT INTO public.platform_migrations (version, description)
    VALUES (15, 'Schedule dispatch outbox — the re-drivable half of a schedule fire')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Where a session goes when Postgres cannot be told about it. The candidate
 * index covers sessions that still have a path to the durable copy; this covers
 * the ones that no longer do, so no drop ends with nothing pointing at the run.
 */
export async function applyProjectionFailuresMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ${projectionFailuresDdl()}

    INSERT INTO public.platform_migrations (version, description)
    VALUES (16, 'Projection failure record — no candidate is evicted without one')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Timer dead letters: the lossless home for a wake whose disposition kept
 * failing. Retiring one from the live index without a durable record deleted
 * the only copy of correctness work.
 */
export async function applyTimerDeadLettersMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ${timerDeadLettersDdl()}

    INSERT INTO public.platform_migrations (version, description)
    VALUES (17, 'Timer dead letters — no poisoned wake is retired without a durable record')
    ON CONFLICT (version) DO NOTHING;
  `);
}

/**
 * Seed the model catalog with common models.
 */
export async function seedModelCatalog(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    INSERT INTO public.model_catalog (model_id, provider, display_name, capabilities, context_window, max_output_tokens, input_price_per_1m, output_price_per_1m, supports_streaming, supports_tool_calling)
    VALUES 
      ('gpt-4o', 'openai', 'GPT-4o', '["text", "json", "tools", "vision"]', 128000, 16384, 250, 1000, true, true),
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', '["text", "json", "tools", "vision"]', 128000, 16384, 15, 60, true, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', '["text", "json", "tools", "vision"]', 128000, 4096, 1000, 3000, true, true),
      ('claude-3-5-sonnet-20241022', 'anthropic', 'Claude 3.5 Sonnet', '["text", "json", "tools", "vision"]', 200000, 8192, 300, 1500, true, true),
      ('claude-3-opus-20240229', 'anthropic', 'Claude 3 Opus', '["text", "json", "tools", "vision"]', 200000, 4096, 1500, 7500, true, true),
      ('claude-3-haiku-20240307', 'anthropic', 'Claude 3 Haiku', '["text", "json", "tools"]', 200000, 4096, 25, 125, true, true),
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
  `);
}

/**
 * Capability governance: tenant-wide capability ceiling plus per-user grants
 * that pierce it (operator re-enables e.g. coding for a named user).
 */
export async function applyCapabilityGovernanceMigrations(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS capability_ceiling JSONB;

    CREATE TABLE IF NOT EXISTS public.tenant_capability_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      capability_group_ids JSONB NOT NULL,
      note TEXT,
      granted_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_capability_grants
      ON public.tenant_capability_grants (tenant_id, user_id);
  `);
}

/**
 * Freemium defaults for the public tenant — generous but BOUNDED, so an
 * open-signup account cannot drive unbounded platform-funded embedding spend
 * or unlimited space fan-out. Seeds `quotas` keys only where ABSENT (never
 * clobbers operator-set values), and only for the given tenant, so private
 * tenants stay unlimited. Idempotent.
 *
 * Cost basis: text-embedding-3-small is ~$0.02 / 1M tokens, so 10M tokens/space
 * ≈ $0.20/space/day and a 500M tenant/day backstop ≈ $10/day. These are the
 * initial values of operator knobs (editable in Tenant Admin), not fixed
 * thresholds in code.
 */
export async function seedPublicTenantFreemiumDefaults(
  sqlClient: postgres.Sql,
  publicTenantId: string,
): Promise<void> {
  // UUID-guard so the id can be inlined safely (operator-supplied env value).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicTenantId)) {
    throw new Error(`seedPublicTenantFreemiumDefaults: invalid tenant id ${publicTenantId}`);
  }
  // Constant, JSON-encoded defaults — safe to inline (no user input). Merge as
  // `defaults || existing` so any operator-set key WINS and absent keys are
  // filled (fill-only-absent, without jsonb_each).
  const defaultsJson = JSON.stringify({
    maxSpacesPerUser: 25,
    embeddingDailyTokensPerSpace: 10_000_000,
    embeddingDailyTokensTenant: 500_000_000,
    computeDailySecondsPerSpace: 7_200,
    computeDailySecondsTenant: 72_000,
  });
  await sqlClient.unsafe(`
    UPDATE public.tenants
    SET quotas = '${defaultsJson}'::jsonb || COALESCE(quotas, '{}'::jsonb)
    WHERE tenant_id = '${publicTenantId}';
  `);
}

/**
 * `user_identities.provider` held the OIDC issuer URL, so it changed whenever
 * the Auth0 domain did — and since the row is keyed on
 * `(provider, provider_sub)`, moving onto a custom domain orphaned every
 * existing identity at once. Each returning user then looked like a first-time
 * signup, which is not a state the system has a graceful answer for.
 *
 * The subject is stable across the domains of one Auth0 tenant, so the column
 * now holds what its own comment always claimed: the provider's name.
 *
 * Idempotent, and never fails on the unique constraint: rows that would
 * collide with an existing `auth0` row for the same subject are left as they
 * are rather than merged, so a genuine conflict stays visible instead of
 * being silently resolved in one direction.
 */
export async function applyIdentityProviderKeyMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    -- Same subject and same user under two issuer URLs: the later login is the
    -- one to keep, and the other carries no information the first lacks.
    DELETE FROM public.user_identities a
    USING public.user_identities b
    WHERE a.provider LIKE 'https://%'
      AND b.provider LIKE 'https://%'
      AND a.provider_sub = b.provider_sub
      AND a.user_id = b.user_id
      AND a.id <> b.id
      AND (
        COALESCE(a.last_login_at, a.linked_at) < COALESCE(b.last_login_at, b.linked_at)
        OR (
          COALESCE(a.last_login_at, a.linked_at) = COALESCE(b.last_login_at, b.linked_at)
          AND a.id > b.id
        )
      );

    -- Both guards are needed. The first skips a subject that already has an
    -- 'auth0' row. The second skips a subject that still has more than one
    -- issuer-shaped row — those would collide with EACH OTHER inside this
    -- statement, since the NOT EXISTS above sees the pre-statement snapshot
    -- and cannot know a sibling row is about to take the same key.
    UPDATE public.user_identities u
    SET provider = 'auth0'
    WHERE u.provider LIKE 'https://%'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_identities x
        WHERE x.provider = 'auth0' AND x.provider_sub = u.provider_sub
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.user_identities y
        WHERE y.provider LIKE 'https://%'
          AND y.provider_sub = u.provider_sub
          AND y.id <> u.id
      );
  `);
}

/**
 * Remove the withdrawn public concierge lane's tenant configuration.
 *
 * The lane was built, never enabled, and removed; the migration that added this
 * column went with it, so a fresh database never gains it. Already-migrated
 * ones still carry it, and a column nothing reads is worse than absent — it
 * reads as a feature to whoever finds it next. No production tenant ever held a
 * value, since enabling the lane required provisioning that never happened.
 */
export async function applyConciergeConfigRemovalMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants DROP COLUMN IF EXISTS concierge_config;
  `);
}

/**
 * Tenant-chosen set of models a space may assign to a cybernetic role.
 *
 * NULL means the platform's recommended set, which is what every tenant gets
 * until an admin narrows or widens it. Storing the choice as absent rather than
 * as a copy of today's recommendations keeps a tenant that never expressed one
 * following the platform as it moves.
 */
export async function applyAgentModelAllowlistMigration(sqlClient: postgres.Sql): Promise<void> {
  await sqlClient.unsafe(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS agent_model_allowlist jsonb;
  `);
}
