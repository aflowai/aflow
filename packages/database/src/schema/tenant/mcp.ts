import { pgTable, uuid, text, timestamp, jsonb, integer, primaryKey } from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * MCP server definitions — tenant-scoped external MCP server configurations.
 * Contains server URL, transport, tool filter. NO credentials or cached tools.
 */
export const mcpServerDefinitions = pgTable(
  'mcp_server_definitions',
  {
    /** Stable server identifier (e.g., "kaggle", "github-mcp") */
    serverId: text('server_id').notNull(),

    /** Human-readable name */
    name: text('name').notNull(),

    /** Description */
    description: text('description'),

    /** MCP server URL */
    serverUrl: text('server_url').notNull(),

    /** Transport protocol: streamable_http (only supported transport per spec rev 2025-11-25) */
    transport: text('transport').notNull().default('streamable_http'),

    /** Full definition as validated JSON */
    definitionJson: jsonb('definition_json').notNull(),

    /** Tags for categorization */
    tags: jsonb('tags').notNull().default([]).$type<string[]>(),

    /** Source type: platform template, custom, or discovered */
    source: text('source').notNull().default('custom'),

    /** Enabled flag */
    enabled: integer('enabled').notNull().default(1),

    /** Owning space — each space gets its own independent MCP server definitions */
    spaceId: uuid('space_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.spaceId] })],
);

export type McpServerDefinitionRow = typeof mcpServerDefinitions.$inferSelect;
export type NewMcpServerDefinitionRow = typeof mcpServerDefinitions.$inferInsert;

// ============================================================================

export const mcpServerBindings = pgTable(
  'mcp_server_bindings',
  {
    /** Stable binding identifier — unique within (binding_id, space_id). */
    bindingId: text('binding_id').notNull(),

    /** References mcp_server_definitions.server_id */
    serverId: text('server_id').notNull(),

    /** Human-readable name */
    name: text('name').notNull(),

    /** Description */
    description: text('description'),

    /**
     * Owning space — first-class column, the authoritative space filter on
     * every CRUD route. `scope_json.spaceId` mirrors this value for backwards
     * compatibility with the legacy JSONB-based readers; the column is the
     * source of truth.
     */
    spaceId: uuid('space_id').notNull(),

    /** Scope (JSON: tenantId, spaceId?, flowId?) — kept in sync with space_id column. */
    scopeJson: jsonb('scope_json').notNull(),

    /** Auth profile (JSON: type, credentialKey, etc.). MUST NOT contain secrets. */
    authJson: jsonb('auth_json').notNull(),

    /** Connection policy (JSON: timeoutMs, maxResponseBytes) */
    connectionPolicyJson: jsonb('connection_policy_json').notNull().default({}),

    /** Pinned server URL origin — validated at execution time to prevent credential hijacking */
    pinnedOrigin: text('pinned_origin'),

    /** Cached tool schemas from tools/list (binding-scoped) */
    cachedTools: jsonb('cached_tools'),

    /** When cached tools were last refreshed */
    cachedToolsAt: timestamp('cached_tools_at', { withTimezone: true }),

    /**
     * Subscribe to notifications/tools/list_changed on the warm session.
     * Integer 0/1 to match `enabled`. Default 1 (on) for streamable_http.
     */
    subscribeListChanged: integer('subscribe_list_changed').notNull().default(1),

    /**
     * Sampling policy for server-initiated sampling/createMessage:
     * 'off' | 'no_tools' | 'full'. Default 'off'.
     */
    samplingPolicy: text('sampling_policy').notNull().default('off'),

    /** Identity ownership scope for OAuth tokens: 'user' | 'space' | 'tenant'. */
    ownerScope: text('owner_scope').notNull().default('tenant'),

    /** Client (app) ownership scope: 'platform' | 'tenant' | 'space'. */
    clientScope: text('client_scope').notNull().default('platform'),

    /**
     * Negotiated session metadata from last successful connect
     * (protocolVersion, serverInfo, capabilities). JSON shape of McpSessionMetadata.
     */
    sessionMetadataJson: jsonb('session_metadata_json'),

    /** Enabled flag */
    enabled: integer('enabled').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.bindingId, table.spaceId] })],
);

export type McpServerBindingRow = typeof mcpServerBindings.$inferSelect;
export type NewMcpServerBindingRow = typeof mcpServerBindings.$inferInsert;
