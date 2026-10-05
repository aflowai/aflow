import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * One node of a space's plan (Plan 322): a tree of intentions the Helmsman
 * works through. `revision` is the compare-and-set counter every update
 * names, so a second session's stale write is refused instead of lost.
 * `closed_at` is set while the node is `done` or `dropped`.
 */
export const planNodes = pgTable(
  'plan_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => planNodes.id, {
      onDelete: 'cascade',
    }),
    /** PlanNodeKind */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    criteria: text('criteria').notNull(),
    /** PlanNodeStatus */
    status: text('status').notNull().default('active'),
    outcome: text('outcome'),
    note: text('note'),
    revision: integer('revision').notNull().default(1),
    /** INTEGER: `PLAN_NODE_POSITION_MAX` in `@aflow/schemas` is its ceiling, held by validation. */
    position: integer('position').notNull().default(0),
    /** The user behind the session that created the node. */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('plan_nodes_space_status_idx').on(table.spaceId, table.status),
    index('plan_nodes_space_parent_idx').on(table.spaceId, table.parentId),
  ],
);

export type PlanNodeRow = typeof planNodes.$inferSelect;
export type NewPlanNodeRow = typeof planNodes.$inferInsert;
