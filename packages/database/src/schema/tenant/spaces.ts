import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type {
  ActiveMemoryRegister,
  EntityDirectives,
  SpaceWriteApprovalPolicy,
} from '@aflow/schemas';

// ============================================================================

/**
 * Spaces are tenant-scoped organizational units.
 * Referenced by memory_docs.space_id, flows, and future space-scoped resources.
 * Space memberships live in public.space_memberships (cross-schema, references public.users).
 */
export const spaces = pgTable('spaces', {
  /** Space ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Space name */
  name: text('name').notNull(),

  /** URL-safe slug (unique within tenant) */
  slug: text('slug').notNull().unique(),

  /** Description */
  description: text('description'),

  /** Who created this space (internal UserId) */
  createdBy: uuid('created_by'),

  /** When the space was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the space was last updated */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the space was archived (soft delete) */
  archivedAt: timestamp('archived_at', { withTimezone: true }),

  /**
   * Hard expiry for ephemeral spaces (eval-batch trial fixtures). NULL for
   * every ordinary space. An expired space is cascade-DELETED (not archived)
   * by the eval-batch worker's reaper — set it only on spaces whose entire
   * content is disposable by construction.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  /** Custom metadata */
  metadata: jsonb('metadata'),

  /** Owning user — always set; holds an irremovable admin membership row */
  ownerId: uuid('owner_id'),

  defaultTargetKind: text('default_target_kind').$type<'platform-role' | 'custom-agent'>(),
  defaultTargetSystemRole: text('default_target_system_role'),
  defaultTargetAgentId: uuid('default_target_agent_id'),

  rules: jsonb('rules').notNull().default([]).$type<Array<{ text: string }>>(),

  computePolicy: jsonb('compute_policy').$type<{
    enabled: boolean;
    networkEgress: { mode: 'blocked' | 'allowlist'; allowedHosts?: string[] | undefined };
    resources?: { maxCpus: number; maxMemoryMb: number; maxExecutionSeconds: number } | undefined;
    maxConcurrentContainers: number;
  }>(),

  codePolicy: jsonb('code_policy').$type<{ enabled: boolean } | null>(),

  writePolicy: jsonb('write_policy').$type<SpaceWriteApprovalPolicy | null>(),

  directives: jsonb('directives').$type<EntityDirectives | null>(),

  activeMemory: jsonb('active_memory').$type<ActiveMemoryRegister | null>(),
});

export type SpaceRow = typeof spaces.$inferSelect;
export type NewSpaceRow = typeof spaces.$inferInsert;
