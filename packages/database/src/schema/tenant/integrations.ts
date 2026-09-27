import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ============================================================================
// API Definitions (catalog entries — no secrets)
// ============================================================================

export const apiDefinitions = pgTable(
  'api_definitions',
  {
    /** Stable API identifier (e.g. "github", "polygon", "my-internal-api") */
    apiId: text('api_id').notNull(),

    /** Human-readable name */
    name: text('name').notNull(),

    /** Description */
    description: text('description'),

    /** Base URL for all endpoints. Null for baseUrlTemplate-only definitions
     *  (the template + variables live in definition_json, the source of truth). */
    baseUrl: text('base_url'),

    /** Version of this definition */
    version: text('version').notNull().default('1'),

    /** Full definition as validated JSON (endpoints, params, schemas) */
    definitionJson: jsonb('definition_json').notNull(),

    /** Tags for categorization */
    tags: jsonb('tags').notNull().default([]).$type<string[]>(),

    /** Enabled flag */
    enabled: integer('enabled').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /** Owning space — each space gets its own independent API definitions */
    spaceId: uuid('space_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.apiId, table.spaceId] })],
);

export type ApiDefinitionRow = typeof apiDefinitions.$inferSelect;
export type NewApiDefinitionRow = typeof apiDefinitions.$inferInsert;

// ============================================================================
// API Bindings (credentials + governance — outside flows)
// ============================================================================

export const apiBindings = pgTable(
  'api_bindings',
  {
    /** Stable binding identifier (unique per spaceId; identical across spaces is fine) */
    bindingId: text('binding_id').notNull(),

    /** References api_definitions.api_id */
    apiId: text('api_id').notNull(),

    /** Human-readable name */
    name: text('name').notNull(),

    /** Description */
    description: text('description'),

    /** Scope (JSON: tenantId, spaceId?, flowId?) */
    scopeJson: jsonb('scope_json').notNull(),

    /** Auth profile (JSON: type, credentialKey, etc.). MUST NOT contain secrets. */
    authJson: jsonb('auth_json').notNull(),

    /** Egress policy (JSON: allowedHosts, allowedMethods, limits, retry) */
    egressPolicyJson: jsonb('egress_policy_json').notNull(),

    /** NON-SECRET per-binding (space-scoped) config substituted into the definition's
     *  baseUrlTemplate (e.g. { domain: "acme" }). NEVER secrets — those live in
     *  api_credentials referenced by auth.*credentialKey. */
    variableValuesJson: jsonb('variable_values_json'),

    /**
     * How calls through this binding are answered: 'live' or 'simulated'.
     * A declaration, never a fallback — a live binding must not degrade to
     * simulated when the host is unreachable, because an agent quietly
     * inventing data during an outage fails invisibly.
     *
     * First-class alongside `simulation_id` rather than folded into a JSONB
     * corner: six read paths branch on it and one of them is the egress
     * boundary. A CHECK constraint ties the two columns together in both
     * directions so they cannot disagree.
     */
    fulfillmentMode: text('fulfillment_mode')
      .$type<'live' | 'simulated'>()
      .notNull()
      .default('live'),

    /** References simulations.simulation_id in the same space. Set iff simulated. */
    simulationId: text('simulation_id'),

    /** Enabled flag */
    enabled: integer('enabled').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /** Owning space — part of the composite PK. Mirrors api_definitions.space_id. */
    spaceId: uuid('space_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.bindingId, table.spaceId] })],
);

export type ApiBindingRow = typeof apiBindings.$inferSelect;
export type NewApiBindingRow = typeof apiBindings.$inferInsert;

// ============================================================================

/**
 * API credentials — stores encrypted credential values keyed by
 * `(credentialKey, spaceId)`. These are the actual secrets (API keys, tokens,
 * passwords) that bindings reference via their credentialKey field. A
 * credential stored in space A is valid ONLY inside space A — never read or
 * referenced from another space.
 *
 * Shared by API bindings and MCP server static-auth bindings; the loader for
 * each executor scopes reads to its caller's space.
 *
 * Encrypted at rest using AES-256-GCM (see lib/credentials.ts).
 * Values are NEVER returned in API responses — only metadata is exposed.
 */
export const apiCredentials = pgTable(
  'api_credentials',
  {
    /** Credential key name (matches AuthProfile.credentialKey in bindings) */
    credentialKey: text('credential_key').notNull(),

    /** Human-readable label shown in the UI */
    label: text('label').notNull(),

    /** Optional description */
    description: text('description'),

    /** AES-256-GCM encrypted value: base64(iv || authTag || ciphertext) */
    encryptedValue: text('encrypted_value').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /** Owning space — part of the composite PK. */
    spaceId: uuid('space_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.credentialKey, table.spaceId] }),
    index('idx_api_credentials_space').on(table.spaceId),
  ],
);

export type ApiCredentialRow = typeof apiCredentials.$inferSelect;
export type NewApiCredentialRow = typeof apiCredentials.$inferInsert;

// ============================================================================

/**
 * First-class provider credential bundles — one row per (provider, scope, scopeId).
 *
 * Secret fields are envelope-encrypted (AES-256-GCM) in `encrypted_secrets`.
 * Config fields are plaintext JSONB in `config_json` (editable without re-entering secrets).
 * Values are NEVER returned in API responses — only metadata is exposed.
 *
 * Resolution order: user → space → tenant (no platform/env-var fallback).
 */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Provider ID from registry (e.g. 'openai', 'anthropic', 'brave') */
    providerId: text('provider_id').notNull(),

    /** Scope level: 'user', 'space', or 'tenant' */
    scope: text('scope').notNull(),

    /** The scoped entity UUID: userId, spaceId, or tenantId */
    scopeId: uuid('scope_id').notNull(),

    /** Envelope-encrypted JSON: { "api_key": "sk-...", ... } — secret fields only */
    encryptedSecrets: text('encrypted_secrets').notNull(),

    /** Non-secret config fields: { "org_id": "org-xxx", "voice_id": "abc" } */
    configJson: jsonb('config_json').notNull().default({}),

    /** Optional user note (e.g. "My personal key") */
    label: text('label'),

    /** Who stored this credential — always a human */
    createdBy: uuid('created_by').notNull(),

    /** Health status: 'active' or 'error' (reactive, from provider auth responses) */
    status: text('status').notNull().default('active'),

    /** When the credential was last successfully used */
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),

    /** When the credential last returned an auth error */
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),

    /** Error code from last auth failure (e.g. '401', 'invalid_api_key') */
    lastErrorCode: text('last_error_code'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_provider_credentials_scope').on(table.providerId, table.scope, table.scopeId),
    index('idx_provider_credentials_lookup').on(table.providerId, table.scope, table.scopeId),
    index('idx_provider_credentials_scope_id').on(table.scopeId),
  ],
);

export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type NewProviderCredentialRow = typeof providerCredentials.$inferInsert;
