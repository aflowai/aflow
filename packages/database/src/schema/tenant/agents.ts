import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * Custom (operator-authored) agent identity. Stable UUID `id`, mutable
 * per-space-unique `slug`. Renames to `slug` write a row in
 * `agent_slug_history` so old URLs keep resolving via redirect.
 *
 * Platform roles (cybernetic-helmsman, -runner, -coach) are NOT stored here.
 * They live in `packages/platform-artifacts` as code-backed definitions and
 * are resolved by `(spaceId, systemRole)` at runtime. Runtime targets are a
 * tagged union (`AgentTargetSchema`) carrying either a `systemRole` or this
 * table's `id`.
 */
export const agents = pgTable(
  'agents',
  {
    /** Stable internal id */
    id: uuid('id').primaryKey().defaultRandom(),

    /** Owning space */
    spaceId: uuid('space_id').notNull(),

    /** Per-space-unique human handle */
    slug: text('slug').notNull(),

    /** Display name */
    name: text('name').notNull(),

    /** Optional description */
    description: text('description'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agents_space_slug_unique').on(table.spaceId, table.slug),
    index('agents_space_id_idx').on(table.spaceId),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;

export const agentVersions = pgTable(
  'agent_versions',
  {
    agentId: uuid('agent_id').notNull(),
    version: text('version').notNull(),
    definitionJson: jsonb('definition_json').notNull(),
    status: text('status').notNull().default('published'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.version] }),
    index('agent_versions_status_idx').on(table.status),
  ],
);

export type AgentVersionRow = typeof agentVersions.$inferSelect;
export type NewAgentVersionRow = typeof agentVersions.$inferInsert;

// ============================================================================

/**
 * Records a rename of `spaces.slug`. Tenant-scoped by virtue of living in
 * the per-tenant schema. `UNIQUE (old_slug)` is the slug-reuse block: a
 * retired slug can never resurface (live or in history) for a different
 * space until the row is removed via `ON DELETE CASCADE` when the space
 * itself is hard-deleted.
 */
export const spaceSlugHistory = pgTable(
  'space_slug_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    renamedAt: timestamp('renamed_at', { withTimezone: true }).notNull().defaultNow(),
    renamedBy: uuid('renamed_by'),
  },
  (table) => [uniqueIndex('space_slug_history_old_slug_unique').on(table.oldSlug)],
);

export type SpaceSlugHistoryRow = typeof spaceSlugHistory.$inferSelect;
export type NewSpaceSlugHistoryRow = typeof spaceSlugHistory.$inferInsert;

/**
 * Records a rename of `agents.slug`. Space-scoped — the same old slug can
 * exist in the history of two different spaces.
 */
export const agentSlugHistory = pgTable(
  'agent_slug_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    renamedAt: timestamp('renamed_at', { withTimezone: true }).notNull().defaultNow(),
    renamedBy: uuid('renamed_by'),
  },
  (table) => [uniqueIndex('agent_slug_history_space_old_unique').on(table.spaceId, table.oldSlug)],
);

export type AgentSlugHistoryRow = typeof agentSlugHistory.$inferSelect;
export type NewAgentSlugHistoryRow = typeof agentSlugHistory.$inferInsert;
