import { randomUUID } from 'crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, hitlActionAudit, withTenantSchema } from '@aflow/database';
import { recordActionCenterResolved, recordHitlGateLatency } from '@aflow/observability';
import type { ActionCenterItem, ActionCenterResolution, PostInstallTask } from '@aflow/schemas';
import type { DecisionPlaneStore } from './decisionPlane.js';
import {
  type ActionCenterContext,
  type ActionCenterPooledItem,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  ActionCenterResolveError,
} from './types.js';
import {
  ActionCenterAuthzError,
  projectActionCenterItem,
  assertResolutionAllowed,
} from './authz.js';

export interface ActionCenterAggregator {
  list(ctx: ActionCenterContext): Promise<ActionCenterItem[]>;
  /**
   * Every item in the space that is the same for everyone watching it, with
   * assignments joined and no reader applied. One call serves N subscribers.
   */
  listSpaceScoped(scope: ActionCenterScope): Promise<ActionCenterPooledItem[]>;
  /** The items whose row set is this reader's own — invitations, today. */
  listActorScoped(ctx: ActionCenterContext): Promise<ActionCenterPooledItem[]>;
  get(ctx: ActionCenterContext, itemId: string): Promise<ActionCenterItem | null>;
  resolve(
    ctx: ActionCenterContext,
    itemId: string,
    resolution: ActionCenterResolution,
  ): Promise<ResolveResult>;
}

export interface ResolveResult {
  item: ActionCenterItem;
  /** Op id reported in the audit row + UI (e.g. mcp.tool.call for a gated MCP step). */
  reportedOperationId: string;
  resolvedAt: string;
  /** Post-install setup tasks (store_install ratification) — surfaced to the resolving operator. */
  setupChecklist?: PostInstallTask[];
}

export interface BuildAggregatorOptions {
  db: PostgresJsDatabase;
  sources: ActionCenterSource[];
  decisionPlane: DecisionPlaneStore;
}

export function buildAggregator(opts: BuildAggregatorOptions): ActionCenterAggregator {
  const { db, sources, decisionPlane } = opts;
  const spaceScoped = sources.filter((s) => s.rowScope === 'space');
  const actorScoped = sources.filter((s) => s.rowScope === 'actor');

  async function recordAudit(
    ctx: ActionCenterContext,
    itemId: string,
    item: ActionCenterSourceItem,
    resolution: ActionCenterResolution,
    operationId: string,
  ): Promise<void> {
    try {
      const tenantCtx = createTenantContext(ctx.tenantId);
      const requestedAtMs = new Date(item.requestedAt).getTime();
      const latencyMs = Number.isFinite(requestedAtMs)
        ? Math.max(0, Date.now() - requestedAtMs)
        : null;
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx.insert(hitlActionAudit).values({
          id: randomUUID(),
          spaceId: ctx.spaceId,
          originKind: item.origin.type,
          originId: itemId,
          operationId,
          kind: item.kind,
          resolverUserId: ctx.actorUserId,
          resolutionKind: resolution.kind,
          ...(latencyMs !== null ? { latencyMs } : {}),
          ...(item.gateContext
            ? { gateContext: item.gateContext as unknown as Record<string, unknown> }
            : {}),
        });
      });
    } catch (err) {
      // Audit failures must NOT abort the resolution — log and continue.
      // Operators can reconcile from source-of-truth state later.
      // (Use console.warn for now — the route's logger isn't in scope here.)
      console.warn('[ActionCenter] audit write failed', err);
    }
  }

  async function withAssignments(
    scope: ActionCenterScope,
    items: ActionCenterSourceItem[],
  ): Promise<ActionCenterPooledItem[]> {
    const assignments = await decisionPlane.loadAssignments(
      scope.tenantId,
      scope.spaceId,
      items.map((i) => i.id),
    );
    return items.map((item) => {
      const assignee = assignments.get(item.id);
      return assignee ? { ...item, assignee } : item;
    });
  }

  async function findItem(
    ctx: ActionCenterContext,
    itemId: string,
  ): Promise<{ item: ActionCenterSourceItem; source: ActionCenterSource } | null> {
    for (const src of sources) {
      const item = await src.getById(ctx, itemId);
      if (item) return { item, source: src };
    }
    return null;
  }

  return {
    async listSpaceScoped(scope) {
      // Promise.all, not allSettled: one source failing must reject the whole
      // read. A source that degraded to [] would look identical to "its items
      // are gone" and clear every one of them from every operator's screen.
      const arrays = await Promise.all(spaceScoped.map((s) => s.listOpen(scope)));
      const merged = arrays.flat();
      merged.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
      return withAssignments(scope, merged);
    },

    async listActorScoped(ctx) {
      const arrays = await Promise.all(actorScoped.map((s) => s.listOpen(ctx)));
      const merged = arrays.flat();
      merged.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
      return withAssignments(ctx, merged);
    },

    async list(ctx) {
      const [shared, personal] = await Promise.all([
        this.listSpaceScoped(ctx),
        this.listActorScoped(ctx),
      ]);
      const merged = [...shared, ...personal];
      merged.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
      return merged.map((item) => projectActionCenterItem(ctx, item));
    },

    async get(ctx, itemId) {
      const hit = await findItem(ctx, itemId);
      if (!hit) return null;
      const [pooled] = await withAssignments(ctx, [hit.item]);
      return projectActionCenterItem(ctx, pooled!);
    },

    async resolve(ctx, itemId, resolution) {
      const hit = await findItem(ctx, itemId);
      if (!hit) {
        throw new ActionCenterResolveError(
          'NOT_FOUND',
          `Action Center item ${itemId} not found in space ${ctx.spaceId}.`,
          'permanent',
        );
      }
      const { item, source } = hit;

      assertResolutionAllowed(item, resolution.kind, ctx);

      // Routing attention, not closing the request: the assignment is written,
      // the new assignee is told, and the item stays open on their desk. The
      // source never hears about it — nothing about the underlying pause
      // changed.
      if (resolution.kind === 'reassign') {
        if (item.status !== 'open') {
          throw new ActionCenterResolveError(
            'STALE_ACTION_CENTER_ITEM',
            'This request has already been answered — reload before routing it.',
            'stale_target',
          );
        }
        if (
          !(await decisionPlane.canBeAsked(ctx.tenantId, ctx.spaceId, resolution.assigneeUserId))
        ) {
          throw new ActionCenterResolveError(
            'INVALID_RESOLUTION',
            'A request can only be routed to someone who can act in its space.',
            'permanent',
          );
        }
        await decisionPlane.saveAssignment(ctx.tenantId, {
          spaceId: ctx.spaceId,
          itemId,
          assigneeUserId: resolution.assigneeUserId,
          assignedBy: ctx.actorUserId,
          ...(resolution.reason ? { reason: resolution.reason } : {}),
        });
        await decisionPlane.notify(ctx.tenantId, {
          spaceId: ctx.spaceId,
          recipientUserId: resolution.assigneeUserId,
          kind: 'reassign',
          subjectKind: 'action_item',
          subjectId: itemId,
          payload: {
            title: item.title,
            assignedBy: ctx.actorUserId,
            ...(resolution.reason ? { reason: resolution.reason } : {}),
          },
        });
        await recordAudit(ctx, itemId, item, resolution, 'action_center.reassign');
        return {
          item: projectActionCenterItem(ctx, { ...item, assignee: resolution.assigneeUserId }),
          reportedOperationId: 'action_center.reassign',
          resolvedAt: new Date().toISOString(),
        };
      }

      let outcome;
      try {
        outcome = await source.resolve(ctx, item, resolution);
      } catch (err) {
        // Propagate structured errors; the route maps codes to HTTP statuses.
        if (err instanceof ActionCenterResolveError) throw err;
        throw new ActionCenterResolveError(
          'DISPATCH_FAILED',
          err instanceof Error ? err.message : String(err),
          'transient',
        );
      }

      await recordAudit(
        ctx,
        itemId,
        item,
        resolution,
        outcome.reportedOperationId ?? outcome.dispatchedOperationId,
      );

      try {
        const requestedAtMs = new Date(item.requestedAt).getTime();
        const latencyMs = Number.isFinite(requestedAtMs)
          ? Math.max(0, Date.now() - requestedAtMs)
          : null;
        const labels: Record<string, string> = {
          tenant_id: ctx.tenantId,
          space_id: ctx.spaceId,
          origin_kind: item.origin.type,
          item_kind: item.kind,
          resolution_kind: resolution.kind,
          operation_id: outcome.reportedOperationId ?? outcome.dispatchedOperationId,
        };
        if (item.gateContext) {
          labels['gate_reason'] = item.gateContext.reason;
        }
        recordActionCenterResolved(labels);
        if (latencyMs !== null) {
          recordHitlGateLatency(latencyMs, labels);
        }
      } catch (err) {
        console.warn('[ActionCenter] metrics emit failed', err);
      }

      return {
        item: projectActionCenterItem(ctx, {
          ...item,
          status: 'resolved',
          resolvedAt: outcome.resolvedAt,
          resolvedBy: ctx.actorUserId,
          resolution,
        }),
        reportedOperationId: outcome.reportedOperationId ?? outcome.dispatchedOperationId,
        resolvedAt: outcome.resolvedAt,
        ...(outcome.setupChecklist !== undefined ? { setupChecklist: outcome.setupChecklist } : {}),
      };
    },
  };
}

// Re-export for routes that need to discriminate error types.
export { ActionCenterResolveError, ActionCenterAuthzError };
