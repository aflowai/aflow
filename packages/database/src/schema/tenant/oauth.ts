import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * Registered OAuth applications (the client / app ownership dimension).
 * The platform-default CIMD client is NOT a row — it is the `/.well-known/cimd`
 * doc, resolved directly for `clientScope='platform'`. Rows here are the
 * tenant- or space-provided apps (`clientScope='tenant'|'space'`) — e.g. a
 * multi-org tenant where each org-space registers its own app.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Client ownership scope: 'tenant' | 'space' (platform is the implicit CIMD client, never a row). */
    scope: text('scope').notNull(),

    /** The owning tenant id or space id (UUID), matching `scope`. */
    scopeId: uuid('scope_id').notNull(),

    /** Stable per-issuer key disambiguating multiple apps registered by one tenant. */
    issuerKey: text('issuer_key').notNull(),

    clientId: text('client_id').notNull(),

    /** AES-256-GCM encrypted client secret (null for public clients). */
    encryptedClientSecret: text('encrypted_client_secret'),

    authorizationServer: text('authorization_server'),

    defaultScopesJson: jsonb('default_scopes_json').notNull().default([]).$type<string[]>(),

    label: text('label').notNull(),

    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_clients_scope_issuer_unique').on(
      table.scope,
      table.scopeId,
      table.issuerKey,
    ),
  ],
);

export type OauthClientRow = typeof oauthClients.$inferSelect;
export type NewOauthClientRow = typeof oauthClients.$inferInsert;

// ============================================================================

/**
 * Access/refresh tokens (the identity / token ownership dimension).
 * Keyed by the logical resource + owner — NOT the binding — so a user who
 * connects a provider once uses it from every binding/space they own
 * (the connect-once property).
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    /** 'mcp' | 'api' — which integration surface this token serves. */
    integrationKind: text('integration_kind').notNull(),

    /** The logical provider key: serverId (MCP) | apiId (API), NOT the binding. */
    resourceKey: text('resource_key').notNull(),

    /** 'user' | 'space' | 'tenant'. */
    ownerScope: text('owner_scope').notNull(),

    /** userId | spaceId | tenantId, matching ownerScope. */
    ownerId: text('owner_id').notNull(),

    /** AES-256-GCM encrypted access token. */
    accessTokenEnc: text('access_token_enc').notNull(),

    /** AES-256-GCM encrypted refresh token (may be null). */
    refreshTokenEnc: text('refresh_token_enc'),

    tokenType: text('token_type').notNull().default('Bearer'),

    scopesJson: jsonb('scopes_json').notNull().default([]).$type<string[]>(),

    /** RFC 8707 audience the token is bound to. */
    audience: text('audience'),

    /** The client_id that minted this token. Recorded so a future read path can
     *  detect client rotation and force re-consent; no reader compares it yet. */
    clientIdUsed: text('client_id_used'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    obtainedAt: timestamp('obtained_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.integrationKind, table.resourceKey, table.ownerScope, table.ownerId],
    }),
  ],
);

export type OauthTokenRow = typeof oauthTokens.$inferSelect;
export type NewOauthTokenRow = typeof oauthTokens.$inferInsert;

// ============================================================================

/**
 * Transient state for in-flight OAuth 2.1 PKCE consent flows. Short-lived
 * (~10 min TTL). The opaque `state` doubles as CSRF token and retains the
 * tenant-routing base64url prefix (load-bearing for the unauthenticated
 * callback).
 */
export const oauthState = pgTable('oauth_state', {
  /** Opaque state token; primary key + CSRF binding. */
  state: text('state').primaryKey(),

  integrationKind: text('integration_kind').notNull(),

  resourceKey: text('resource_key').notNull(),

  bindingId: text('binding_id').notNull(),

  /** Owning space — disambiguates cross-space duplicates of bindingId. */
  spaceId: uuid('space_id').notNull(),

  ownerScope: text('owner_scope').notNull(),

  /** Real userId for `user` scope; spaceId/tenantId otherwise. */
  ownerId: text('owner_id').notNull(),

  clientScope: text('client_scope').notNull(),

  /** PKCE S256 code verifier. */
  codeVerifier: text('code_verifier').notNull(),

  redirectUri: text('redirect_uri').notNull(),

  /** RFC 8707 audience parameter. */
  resource: text('resource'),

  scopesJson: jsonb('scopes_json').notNull().default([]).$type<string[]>(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OauthStateRow = typeof oauthState.$inferSelect;
export type NewOauthStateRow = typeof oauthState.$inferInsert;
