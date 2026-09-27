/**
 * Public schema tables.
 * Contains platform-level tables shared across all tenants.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  numeric,
  bigserial,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Tenants Registry
// ============================================================================

/**
 * Tenants table - the source of truth for all tenants.
 */
export const tenants = pgTable('tenants', {
  /** Unique tenant identifier (UUID v4) */
  tenantId: uuid('tenant_id').primaryKey(),

  /** Generated schema name (t_<hex_id>) */
  schemaName: text('schema_name').notNull().unique(),

  /** Tenant display name */
  name: text('name').notNull(),

  /** Tenant status */
  status: text('status').notNull().default('active'),

  /** When the tenant was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the tenant was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** Tenant plan/tier */
  plan: text('plan').default('free'),

  /** Usage quotas as JSON */
  quotas: jsonb('quotas'),

  /** Custom metadata */
  metadata: jsonb('metadata'),

  defaultSpaceId: uuid('default_space_id'),

  computeDefaults: jsonb('compute_defaults').$type<{
    approvedHosts: string[];
    presets: Array<{ name: string; description?: string; hosts: string[] }>;
  }>(),

  /** Default identity ownership scope for new OAuth bindings (Plan 185 §4.5). */
  oauthDefaultOwnerScope: text('oauth_default_owner_scope').notNull().default('space'),

  /** Default client (app) ownership scope for new OAuth bindings. */
  oauthDefaultClientScope: text('oauth_default_client_scope').notNull().default('space'),

  /** Whether end-users may self-connect their own OAuth accounts. */
  oauthAllowUserSelfConnect: boolean('oauth_allow_user_self_connect').notNull().default(true),

  /**
   * Custom (non-catalog) integration policy: 'open' (unrestricted) or
   * 'allowlist' (only hosts granted in tenant_integration_allowlist).
   * Explicit — never inferred from allowlist rows, so closed-with-zero-hosts
   * is expressible.
   */
  integrationPolicyMode: text('integration_policy_mode').notNull().default('open'),

  /** Store shelf default for platform listings: 'available' or 'hidden'. */
  storeDefaultAvailability: text('store_default_availability').notNull().default('available'),

  /** JIT provisioning admission: 'invite_only' or 'open'. */
  signupPolicy: text('signup_policy').notNull().default('invite_only'),

  /**
   * Tenant-wide capability exclusion ANDed over every space profile
   * (`{ excludedGroups: string[] }`), so member profile-switching cannot
   * re-enable an excluded group. NULL = no ceiling. Pierced per user by
   * `tenant_capability_grants`.
   */
  capabilityCeiling: jsonb('capability_ceiling'),

  /**
   * Model refs a space may assign to a cybernetic role (`string[]`). NULL = the
   * platform's recommended set, so a tenant that never chose keeps following it
   * as it moves rather than pinning a copy of whatever it held that day.
   */
  agentModelAllowlist: jsonb('agent_model_allowlist'),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * Per-user piercing of the tenant capability ceiling — the operator's
 * deliberate re-enable of excluded groups (e.g. coding) for one user.
 */
export const tenantCapabilityGrants = pgTable(
  'tenant_capability_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Capability group ids re-enabled for this user (string[]). */
    capabilityGroupIds: jsonb('capability_group_ids').notNull(),
    note: text('note'),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_tenant_capability_grants').on(table.tenantId, table.userId)],
);

export type TenantCapabilityGrant = typeof tenantCapabilityGrants.$inferSelect;

// ============================================================================
// Platform Audit Log
// ============================================================================

/**
 * Platform-level audit log for administrative actions.
 */
export const platformAuditLog = pgTable('platform_audit_log', {
  /** Unique audit entry ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Timestamp of the action */
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),

  /** Actor who performed the action */
  actorId: text('actor_id'),

  /** Actor type (user, system, service) */
  actorType: text('actor_type').notNull(),

  /** Action performed */
  action: text('action').notNull(),

  /** Resource type affected */
  resourceType: text('resource_type'),

  /** Resource ID affected */
  resourceId: text('resource_id'),

  /** Tenant ID if action was tenant-scoped */
  tenantId: uuid('tenant_id'),

  /** Additional details as JSON */
  details: jsonb('details'),

  /** IP address of the actor */
  ipAddress: text('ip_address'),

  /** User agent string */
  userAgent: text('user_agent'),

  category: text('category'),

  outcome: text('outcome'),

  actorContext: jsonb('actor_context'),

  target: jsonb('target'),

  requestMetadata: jsonb('request_metadata'),
});

export type PlatformAuditEntry = typeof platformAuditLog.$inferSelect;
export type NewPlatformAuditEntry = typeof platformAuditLog.$inferInsert;

// ============================================================================

/**
 * Internal user record. One row per human or service-principal identity.
 * Lives in public schema — shared across all tenants.
 */
export const users = pgTable('users', {
  /** Internal Phoenix user ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Display name */
  displayName: text('display_name').notNull(),

  /** Email (NULL for service principals) */
  email: text('email'),

  /** Avatar URL */
  avatarUrl: text('avatar_url'),

  /** User kind: human or service_principal */
  kind: text('kind').notNull().default('human'),

  /** Account status */
  status: text('status').notNull().default('active'),

  /** When the user was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the user was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the user was deactivated */
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),

  /** Custom metadata */
  metadata: jsonb('metadata'),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ============================================================================

/**
 * Links external IdP identities to internal users.
 * Supports multiple providers per user (Auth0, Clerk, API key, etc.).
 */
export const userIdentities = pgTable('user_identities', {
  /** Identity record ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Internal user reference */
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Provider name (auth0, clerk, api_key, etc.) */
  provider: text('provider').notNull(),

  /** IdP subject / unique ID */
  providerSub: text('provider_sub').notNull(),

  /** Provider-reported email */
  email: text('email'),

  /** Last-synced OIDC claims (non-secret) */
  rawClaims: jsonb('raw_claims'),

  /** When this identity was linked */
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),

  /** Last login timestamp */
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;

// ============================================================================

/**
 * Joins users to tenants with a role.
 * RBAC control-plane source of truth for tenant-level access.
 */
export const tenantMemberships = pgTable('tenant_memberships', {
  /** Membership record ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Tenant reference */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'cascade' }),

  /** User reference */
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Tenant role: owner, admin, member, viewer, billing */
  role: text('role').notNull().default('member'),

  /** Who invited this user */
  invitedBy: uuid('invited_by').references(() => users.id),

  /** When the user accepted the invite and joined */
  joinedAt: timestamp('joined_at', { withTimezone: true }),

  /** When the membership was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the membership was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** Membership status */
  status: text('status').notNull().default('pending'),
});

export type TenantMembershipRow = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;

// ============================================================================

/**
 * Fine-grained space-level access within a tenant.
 * Lives in public schema because it references public.users.
 * Space UUID references tenant-schema spaces table (FK enforced at app layer).
 */
export const spaceMemberships = pgTable('space_memberships', {
  /** Membership record ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Tenant reference */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'cascade' }),

  /** Space UUID (FK enforced at app layer — cross-schema) */
  spaceId: uuid('space_id').notNull(),

  /** User reference */
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Space role: admin, editor, viewer */
  role: text('role').notNull().default('editor'),

  /** When the membership was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the membership was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SpaceMembershipRow = typeof spaceMemberships.$inferSelect;
export type NewSpaceMembership = typeof spaceMemberships.$inferInsert;

// ============================================================================

/**
 * Pending invitations for invite-only onboarding.
 */
export const invites = pgTable('invites', {
  /** Invite record ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Tenant the invite is for */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'cascade' }),

  /** Email of the invitee */
  email: text('email').notNull(),

  /** Role the invitee will receive */
  role: text('role').notNull().default('member'),

  tokenHash: text('token_hash').notNull().unique(),

  /** Who sent the invite */
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id),

  /** When the invite expires */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  status: text('status').notNull().default('pending'),

  /** When the invite was accepted */
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),

  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),

  /** When the invite was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InviteRow = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

/**
 * Pending space-access grants — the share-by-email seam. Separate from
 * `invites` (one pending invite per tenant+email) so granting someone a
 * second space never clobbers their tenant invitation. Redeemed against the
 * verified authenticated email at admission, never against an invite token.
 */
export const spaceGrants = pgTable('space_grants', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'cascade' }),

  /** Space in the tenant schema — FK enforced at the application level */
  spaceId: uuid('space_id').notNull(),

  /** Lowercased recipient email */
  email: text('email').notNull(),

  /** Space role minted at redemption */
  spaceRole: text('space_role').notNull().default('viewer'),

  status: text('status').notNull().default('pending'),

  grantedBy: uuid('granted_by')
    .notNull()
    .references(() => users.id),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),

  redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id),
});

export type SpaceGrantRow = typeof spaceGrants.$inferSelect;
export type NewSpaceGrant = typeof spaceGrants.$inferInsert;

// ============================================================================

/**
 * Public request-access queue: visitors ask for an invite, tenant admins
 * approve (creating an invite) or dismiss.
 */
export const inviteRequests = pgTable(
  'invite_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Tenant the request targets */
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId, { onDelete: 'cascade' }),

    /** Lowercased requester email — the delivery address, never a key */
    email: text('email').notNull(),

    /**
     * Dedupe key: `canonicalizeEmail(email)`. Distinct from `email` because
     * Gmail dot/plus variants of one inbox must not each hold a pending row —
     * that gap was the observed abuse.
     */
    emailCanonical: text('email_canonical'),

    /** Requester's name */
    name: text('name'),

    /** A public link the requester gave to be looked up by */
    link: text('link'),

    /** One line on what the requester does */
    occupation: text('occupation'),

    /** What the requester would want to build or run */
    useCase: text('use_case'),

    /** How the requester heard about Aflow */
    referral: text('referral'),

    /** 'pending' | 'approved' | 'dismissed' */
    status: text('status').notNull().default('pending'),

    /** Admin who approved or dismissed the request */
    decidedBy: uuid('decided_by').references(() => users.id),

    decidedAt: timestamp('decided_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invite_requests_tenant_email_canonical_pending_unique')
      .on(table.tenantId, table.emailCanonical)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type InviteRequestRow = typeof inviteRequests.$inferSelect;
export type NewInviteRequest = typeof inviteRequests.$inferInsert;

// ============================================================================

/**
 * API keys for programmatic access. Stored as SHA-256 hashes.
 * The plaintext key is shown to the user exactly once at creation time.
 */
export const apiKeys = pgTable('api_keys', {
  /** API key record ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** SHA-256 hash of the full key */
  keyHash: text('key_hash').notNull().unique(),

  /** First 8 chars of the key for identification in UI */
  keyPrefix: text('key_prefix').notNull(),

  /** Owner user */
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Tenant this key is scoped to */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'cascade' }),

  /** Human-readable label */
  name: text('name').notNull(),

  /** Scopes: array of { resource, action, spaceId? } */
  scopes: jsonb('scopes').notNull(),

  /** Expiration (NULL = no expiry) */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  /** Last usage timestamp */
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

  /** When the key was revoked */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),

  /** When the key was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

// ============================================================================

/**
 * Transactional outbox for syncing authorization tuples to OpenFGA.
 * Entries are written in the same DB transaction as the resource mutation,
 * then processed by a background worker.
 */
export const authzOutbox = pgTable('authz_outbox', {
  /** Outbox entry ID */
  id: bigserial('id', { mode: 'number' }).primaryKey(),

  /** Operation: write or delete */
  operation: text('operation').notNull(),

  /** OpenFGA tuple key: { user, relation, object } */
  tupleKey: jsonb('tuple_key').notNull(),

  /** When the entry was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** Whether the entry has been processed */
  processed: boolean('processed').notNull().default(false),

  /** When the entry was processed */
  processedAt: timestamp('processed_at', { withTimezone: true }),

  /** Error message if processing failed */
  error: text('error'),
});

export type AuthzOutboxEntry = typeof authzOutbox.$inferSelect;
export type NewAuthzOutboxEntry = typeof authzOutbox.$inferInsert;

// ============================================================================
// Model Catalog
// ============================================================================

/**
 * AI model catalog - defines available models and their capabilities.
 */
export const modelCatalog = pgTable('model_catalog', {
  /** Unique model ID (e.g., 'gpt-4o', 'claude-3-opus') */
  modelId: text('model_id').primaryKey(),

  /** Provider (openai, anthropic, google, openrouter) */
  provider: text('provider').notNull(),

  /** Display name */
  displayName: text('display_name').notNull(),

  /** Model capabilities */
  capabilities: jsonb('capabilities').notNull().default('[]'),

  /** Context window size in tokens */
  contextWindow: integer('context_window'),

  /** Maximum output tokens */
  maxOutputTokens: integer('max_output_tokens'),

  /** Price per 1M input tokens (in cents) */
  inputPricePer1M: numeric('input_price_per_1m', { precision: 12, scale: 4 }),

  /** Price per 1M output tokens (in cents) */
  outputPricePer1M: numeric('output_price_per_1m', { precision: 12, scale: 4 }),

  /** Whether the model supports streaming */
  supportsStreaming: boolean('supports_streaming').default(true),

  /** Whether the model supports function/tool calling */
  supportsToolCalling: boolean('supports_tool_calling').default(false),

  /** Whether the model is currently available */
  isAvailable: boolean('is_available').default(true),

  /** Reliability tier (1 = most reliable) */
  reliabilityTier: integer('reliability_tier').default(2),

  /** Compliance flags (e.g., HIPAA, SOC2) */
  complianceFlags: jsonb('compliance_flags').default('[]'),

  /** Additional metadata */
  metadata: jsonb('metadata'),

  /** When the entry was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the entry was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ModelCatalogEntry = typeof modelCatalog.$inferSelect;
export type NewModelCatalogEntry = typeof modelCatalog.$inferInsert;

// ============================================================================
// Step Type Catalog
// ============================================================================

/**
 * Step type catalog - defines available step types.
 */
export const stepTypeCatalog = pgTable('step_type_catalog', {
  /** Step type ID (ai, api, memory, compute, search, flowControl, user, platform) */
  stepType: text('step_type').primaryKey(),

  /** Display name */
  displayName: text('display_name').notNull(),

  /** Description for documentation */
  description: text('description'),

  /** Whether this step type is enabled */
  isEnabled: boolean('is_enabled').default(true),

  /** Default configuration */
  defaultConfig: jsonb('default_config'),

  /** When the entry was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StepTypeCatalogEntry = typeof stepTypeCatalog.$inferSelect;
export type NewStepTypeCatalogEntry = typeof stepTypeCatalog.$inferInsert;

// ============================================================================
// Operation Catalog
// ============================================================================

/**
 * Operation catalog - defines available operations.
 */
export const operationCatalog = pgTable('operation_catalog', {
  /** Operation ID (e.g., 'ai.generate', 'memory.read') */
  operationId: text('operation_id').primaryKey(),

  /** Step type this operation belongs to */
  stepType: text('step_type')
    .notNull()
    .references(() => stepTypeCatalog.stepType),

  /** Display name */
  displayName: text('display_name').notNull(),

  /** Semantic description for agents */
  semanticDescription: text('semantic_description').notNull(),

  /** Input schema as JSON Schema */
  inputSchema: jsonb('input_schema').notNull(),

  /** Output schema as JSON Schema */
  outputSchema: jsonb('output_schema'),

  /** Side effects classification */
  sideEffects: jsonb('side_effects').notNull(),

  /** Required permissions */
  permissions: jsonb('permissions'),

  /** Whether this operation is enabled */
  isEnabled: boolean('is_enabled').default(true),

  /** Whether this operation is experimental */
  isExperimental: boolean('is_experimental').default(false),

  /** When the entry was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the entry was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OperationCatalogEntry = typeof operationCatalog.$inferSelect;
export type NewOperationCatalogEntry = typeof operationCatalog.$inferInsert;

// ============================================================================

/**
 * Durable discovery source for non-terminal runs.
 * Used for recovery after Redis loss, shard handoff, and orchestrator startup.
 *
 * Unlike `aflow:dirty:runs` (Redis-local), this survives total Redis loss.
 * Updated continuously from recovery events.
 *
 * @see docs/plans/aflow/completed/49-redis-durability-snapshots-and-replay.md §3.3
 */
export const recoverableRuns = pgTable('recoverable_runs', {
  /** Run ID (primary key — one entry per active run) */
  runId: uuid('run_id').primaryKey(),

  /** Tenant context */
  tenantId: text('tenant_id').notNull(),

  shardId: integer('shard_id').notNull(),

  /** Current run status (RUNNING, PAUSED, STALLED) */
  status: text('status').notNull(),

  /** Latest recovery event seq processed */
  lastRecoverySeq: integer('last_recovery_seq').notNull().default(0),

  /** PayloadRef to latest externalized snapshot (if any) */
  latestSnapshotRef: text('latest_snapshot_ref'),

  /** Recovery seq of the latest snapshot */
  latestSnapshotSeq: integer('latest_snapshot_seq'),

  /** When this entry was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RecoverableRunRow = typeof recoverableRuns.$inferSelect;
export type NewRecoverableRun = typeof recoverableRuns.$inferInsert;

// ============================================================================

/**
 * Structured error reports for platform operator diagnostics.
 * Created by the projection worker for FAILED runs with internal/transient errors.
 * Stored in public schema — platform-scoped, not tenant-scoped.
 */
export const errorReports = pgTable('error_reports', {
  /** Unique report ID */
  id: text('id').primaryKey(),

  /** When the error occurred */
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

  /** Tenant context */
  tenantId: text('tenant_id').notNull(),

  /** Run that failed */
  runId: text('run_id').notNull(),

  /** Step execution that failed (if applicable) */
  stepExecutionId: text('step_execution_id'),

  /** Step attempt number */
  attempt: integer('attempt'),

  /** Flow ID */
  flowId: text('flow_id'),

  /** Flow name */
  flowName: text('flow_name'),

  /** Step ID within the flow */
  stepId: text('step_id'),

  /** Step type (ai, api, memory, etc.) */
  stepType: text('step_type'),

  /** Operation ID */
  operationId: text('operation_id'),

  /** OpenTelemetry trace ID */
  traceId: text('trace_id'),

  /** OpenTelemetry span ID */
  spanId: text('span_id'),

  /** Provider request ID */
  providerRequestId: text('provider_request_id'),

  /** Error classification */
  classification: text('classification').notNull(),

  /** Error code (SCREAMING_SNAKE_CASE) */
  code: text('code').notNull(),

  /** Error message */
  message: text('message').notNull(),

  /** Platform stack trace */
  stack: text('stack'),

  /** Nested error cause chain (redacted) */
  cause: text('cause'),

  /** Intent metadata (operation ID + redacted input summary) */
  intent: jsonb('intent'),

  /** Provider details (name, error code, status code) */
  provider: jsonb('provider'),

  /** Severity: warning, error, critical */
  severity: text('severity').notNull(),

  /** Error fingerprint for grouping recurring errors (unique — upsert increments count) */
  fingerprint: text('fingerprint').notNull().unique(),

  /** Number of times this fingerprint has been seen */
  occurrenceCount: integer('occurrence_count').notNull().default(1),

  /** Resolution hints */
  suggestedAction: text('suggested_action'),

  /** When the report was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ErrorReportRow = typeof errorReports.$inferSelect;
export type NewErrorReportRow = typeof errorReports.$inferInsert;

// ============================================================================

/**
 * Pending/approved/rejected requests for additional compute egress hosts.
 * Agents or admins create requests; tenant admins approve or reject them.
 */
export const egressApprovalRequests = pgTable('egress_approval_requests', {
  requestId: uuid('request_id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  /** 'tenant' | 'space' for compute egress; 'integration' for integration-host requests. */
  scope: text('scope').notNull().default('tenant'),
  spaceId: uuid('space_id'),
  requestedHosts: text('requested_hosts').array().notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),
  status: text('status').notNull().default('pending_approval'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  /** 'api' | 'mcp' — set only on scope 'integration' rows. */
  integrationKind: text('integration_kind'),
  reviewNote: text('review_note'),
});

export type EgressApprovalRequestRow = typeof egressApprovalRequests.$inferSelect;
export type NewEgressApprovalRequestRow = typeof egressApprovalRequests.$inferInsert;

// ============================================================================

/**
 * Tenant-admin-granted hosts for custom (non-catalog) integrations.
 * Consulted only when the tenant's integration_policy_mode is 'allowlist'.
 */
export const tenantIntegrationAllowlist = pgTable(
  'tenant_integration_allowlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId, { onDelete: 'cascade' }),

    /** Integration kind the grant applies to: 'api' | 'mcp' (app-layer enum, open for future kinds). */
    kind: text('kind').notNull(),

    /** Egress-layer host grammar: bare hostname with optional `*.` wildcard prefix. */
    hostPattern: text('host_pattern').notNull(),

    note: text('note'),

    addedBy: uuid('added_by'),

    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_tenant_integration_allowlist').on(
      table.tenantId,
      table.kind,
      table.hostPattern,
    ),
  ],
);

export type TenantIntegrationAllowlistRow = typeof tenantIntegrationAllowlist.$inferSelect;
export type NewTenantIntegrationAllowlistRow = typeof tenantIntegrationAllowlist.$inferInsert;

// ============================================================================

/**
 * Per-listing availability overrides layered over tenants.store_default_availability.
 */
export const tenantStoreOverrides = pgTable(
  'tenant_store_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId, { onDelete: 'cascade' }),

    catalogId: text('catalog_id').notNull(),

    /** 'available' | 'hidden' — wins over the tenant default for this listing. */
    availability: text('availability').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.catalogId] })],
);

export type TenantStoreOverrideRow = typeof tenantStoreOverrides.$inferSelect;
export type NewTenantStoreOverrideRow = typeof tenantStoreOverrides.$inferInsert;

/**
 * Append-only record of Terms of Service acceptances. One row per user per
 * version, so the history survives a version bump — the evidence question is
 * "what did this person agree to, and when", which a single mutable column on
 * `users` cannot answer.
 */
export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** ISO date matching the version rendered on the Terms page. */
    version: text('version').notNull(),

    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),

    /** Recorded for evidentiary value; erased with the account. */
    ipAddress: text('ip_address'),
  },
  (table) => [uniqueIndex('terms_acceptances_user_version_unique').on(table.userId, table.version)],
);

export type TermsAcceptanceRow = typeof termsAcceptances.$inferSelect;
export type NewTermsAcceptanceRow = typeof termsAcceptances.$inferInsert;
