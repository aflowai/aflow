import { eq, and, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  actionItemAssignments,
  createTenantContext,
  notificationOutbox,
  spaceMemberships,
  withTenantSchema,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

/**
 * Where the decision plane keeps its two facts: who a request is currently
 * being asked of, and who has been told about what.
 *
 * A port rather than direct queries in the aggregator, so the routing logic
 * can be exercised without a database — the aggregator's behaviour is the
 * thing worth testing, not Drizzle.
 */
export interface DecisionPlaneStore {
  /** itemId → assignee, for the items currently in view. */
  loadAssignments(
    tenantId: TenantId,
    spaceId: string,
    itemIds: string[],
  ): Promise<Map<string, string>>;
  saveAssignment(
    tenantId: TenantId,
    args: {
      spaceId: string;
      itemId: string;
      assigneeUserId: string;
      assignedBy: string;
      reason?: string;
    },
  ): Promise<void>;
  /**
   * True when this person can be asked: a member of the space who is able to
   * act in it. Handing a request to a viewer would park it — they can neither
   * answer it nor pass it on — so routing stops short of that.
   */
  canBeAsked(tenantId: TenantId, spaceId: string, userId: string): Promise<boolean>;
  /**
   * Tell someone something, at most once: the (kind, subject, recipient)
   * tuple is the idempotency, so retries and re-flushes are silent.
   */
  notify(
    tenantId: TenantId,
    args: {
      spaceId: string;
      recipientUserId: string;
      kind: string;
      subjectKind: string;
      subjectId: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export function createDecisionPlaneStore(db: PostgresJsDatabase): DecisionPlaneStore {
  return {
    async loadAssignments(tenantId, spaceId, itemIds) {
      const tenantCtx = createTenantContext(tenantId);
      if (itemIds.length === 0) return new Map();
      const rows = await withTenantSchema(db, tenantCtx, (tx) =>
        tx
          .select({
            itemId: actionItemAssignments.itemId,
            assigneeUserId: actionItemAssignments.assigneeUserId,
          })
          .from(actionItemAssignments)
          .where(
            and(
              eq(actionItemAssignments.spaceId, spaceId),
              inArray(actionItemAssignments.itemId, itemIds),
            ),
          ),
      );
      return new Map(rows.map((r) => [r.itemId, r.assigneeUserId]));
    },

    async saveAssignment(tenantId, args) {
      const tenantCtx = createTenantContext(tenantId);
      await withTenantSchema(db, tenantCtx, (tx) =>
        tx
          .insert(actionItemAssignments)
          .values({
            itemId: args.itemId,
            spaceId: args.spaceId,
            assigneeUserId: args.assigneeUserId,
            assignedBy: args.assignedBy,
            reason: args.reason ?? null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: actionItemAssignments.itemId,
            set: {
              assigneeUserId: args.assigneeUserId,
              assignedBy: args.assignedBy,
              reason: args.reason ?? null,
              updatedAt: new Date(),
            },
          }),
      );
    },

    async canBeAsked(tenantId, spaceId, userId) {
      const rows = await db
        .select({ role: spaceMemberships.role })
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.tenantId, tenantId),
            eq(spaceMemberships.spaceId, spaceId),
            eq(spaceMemberships.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] !== undefined && rows[0].role !== 'viewer';
    },

    async notify(tenantId, args) {
      const tenantCtx = createTenantContext(tenantId);
      await withTenantSchema(db, tenantCtx, (tx) =>
        tx
          .insert(notificationOutbox)
          .values({
            spaceId: args.spaceId,
            recipientUserId: args.recipientUserId,
            kind: args.kind,
            subjectKind: args.subjectKind,
            subjectId: args.subjectId,
            payload: args.payload ?? {},
          })
          .onConflictDoNothing(),
      );
    },
  };
}
