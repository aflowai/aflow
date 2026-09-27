import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type {
  AppletActionEffects,
  AppletEffectDelivery,
  AppletInstanceStatus,
  AppletStatePatchOp,
} from '@aflow/schemas';
import { uiArtifactVersions } from './uiArtifacts.js';

// ============================================================================

/**
 * Applet instances — identity and lifecycle of a live stateful artifact.
 * The state body lives in a memory doc at `state_path`; this row is the
 * lock, the cascade target and the listing surface.
 */
export const appletInstances = pgTable(
  'applet_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    appletKey: text('applet_key').notNull(),
    /** Pinned at instantiation — hash over the canonical validated definition JSON. */
    definitionHash: text('definition_hash').notNull(),
    /** The pinned artifact version carrying view + definition as one unit. */
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => uiArtifactVersions.id),
    /** Memory doc path of the state snapshot. */
    statePath: text('state_path').notNull(),
    status: text('status').notNull().default('active').$type<AppletInstanceStatus>(),
    /** Re-bindable pointer to the room where this object is worked — never a lifecycle dependency. */
    boundSessionId: uuid('bound_session_id'),
    /** The version the last repin moved off — the rollback target. */
    upgradedFromVersionId: uuid('upgraded_from_version_id'),
    upgradedAt: timestamp('upgraded_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_applet_instances_space_status').on(table.spaceId, table.status)],
);

export type AppletInstanceRow = typeof appletInstances.$inferSelect;
export type NewAppletInstanceRow = typeof appletInstances.$inferInsert;

/**
 * Applet action events — the append-only journal of receipts, doubling as the
 * transactional outbox for post-commit effects (`delivered_effects` records
 * delivery progress). `(instance_id, action_id)` is the idempotency key:
 * replaying a command returns the original receipt.
 */
export const appletActionEvents = pgTable(
  'applet_action_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => appletInstances.id),
    /** Instance-scoped journal sequence — gap-free, ordered. */
    seq: integer('seq').notNull(),
    actionId: uuid('action_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorAgentRole: text('actor_agent_role'),
    actionName: text('action_name').notNull(),
    input: jsonb('input').notNull().default({}).$type<Record<string, unknown>>(),
    /** The applied patch — what actually happened. */
    patch: jsonb('patch').notNull().default([]).$type<AppletStatePatchOp[]>(),
    outcome: text('outcome'),
    effects: jsonb('effects').notNull().$type<AppletActionEffects>(),
    beforeVersion: integer('before_version').notNull(),
    afterVersion: integer('after_version').notNull(),
    /** Outbox progress — undelivered effects are retried after commit. */
    deliveredEffects: jsonb('delivered_effects')
      .notNull()
      .default([])
      .$type<AppletEffectDelivery[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('applet_action_events_seq_unique').on(table.instanceId, table.seq),
    uniqueIndex('applet_action_events_action_unique').on(table.instanceId, table.actionId),
  ],
);

export type AppletActionEventRow = typeof appletActionEvents.$inferSelect;
export type NewAppletActionEventRow = typeof appletActionEvents.$inferInsert;

/**
 * Applet role bindings — who participates and which applet role they hold, as
 * typed rows rather than JSON inside state, so membership is visible to the
 * erasure cascade.
 */
export const appletRoleBindings = pgTable(
  'applet_role_bindings',
  {
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => appletInstances.id),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.userId, table.role] })],
);

export type AppletRoleBindingRow = typeof appletRoleBindings.$inferSelect;
export type NewAppletRoleBindingRow = typeof appletRoleBindings.$inferInsert;
