import { and, eq, inArray, or } from 'drizzle-orm';
import { egressApprovalRequests } from '@aflow/database';
import { type ActionCenterItemOrigin, type ActionCenterRequester } from '@aflow/schemas';
import {
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';

const EGRESS_ITEM_ID_PREFIX = 'settings:egress-';
const EGRESS_RECORD_KIND = 'egress_request';

type Row = typeof egressApprovalRequests.$inferSelect;

export function createComputeEgressSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'computeEgress',
    rowScope: 'space',
    handlesOriginTypes: ['settings'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      // Tenant-wide + this space's space-scoped requests. The OR on
      // `(scope, space_id)` is the visibility rule documented above.
      const rows = await deps.db
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.tenantId, scope.tenantId),
            eq(egressApprovalRequests.status, 'pending_approval'),
            or(
              eq(egressApprovalRequests.scope, 'tenant'),
              and(
                eq(egressApprovalRequests.scope, 'space'),
                eq(egressApprovalRequests.spaceId, scope.spaceId),
              ),
            ),
          ),
        );
      return rows.map((row) => toActionCenterItem(row, scope));
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(EGRESS_ITEM_ID_PREFIX)) return null;
      const requestId = itemId.slice(EGRESS_ITEM_ID_PREFIX.length);
      const rows = await deps.db
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.tenantId, ctx.tenantId),
            eq(egressApprovalRequests.requestId, requestId),
          ),
        );
      const row = rows[0];
      if (!row) return null;
      // Integration-host requests share the table but belong to their own
      // source — resolving one here would skip the allowlist insert.
      if (row.scope !== 'tenant' && row.scope !== 'space') return null;
      // Cross-space visibility check: a `scope: 'space'` request for a
      // different space MUST NOT be readable by id from outside its space
      // (otherwise the per-space AC leaks data).
      if (row.scope === 'space' && row.spaceId !== ctx.spaceId) return null;
      return toActionCenterItem(row, ctx);
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      if (resolution.kind !== 'approve' && resolution.kind !== 'reject') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `egress requests accept 'approve' or 'reject' only; got '${resolution.kind}'`,
        );
      }
      const requestId = item.id.slice(EGRESS_ITEM_ID_PREFIX.length);

      // Re-read to verify CAS — `recordVersion` on the origin must
      // still match. (Translation: the row must still be
      // pending_approval. Any other status means an admin elsewhere
      // already resolved it.)
      const rows = await deps.db
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.tenantId, ctx.tenantId),
            eq(egressApprovalRequests.requestId, requestId),
          ),
        );
      const row = rows[0];
      if (!row) {
        throw new ActionCenterResolveError('NOT_FOUND', `egress request ${requestId} not found`);
      }
      if (row.status !== 'pending_approval') {
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          `egress request ${requestId} is no longer pending (status: ${row.status})`,
          'stale_target',
          undefined,
          toActionCenterItem(row, ctx),
        );
      }

      // Apply the resolution. Conditional WHERE on (status, requestId) is
      // a second-line CAS guard in case two admins resolve concurrently
      // between the SELECT and the UPDATE — the loser updates 0 rows.
      const updated = await deps.db
        .update(egressApprovalRequests)
        .set({
          status: resolution.kind === 'approve' ? 'approved' : 'rejected',
          reviewedBy: ctx.actorUserId,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(egressApprovalRequests.requestId, requestId),
            inArray(egressApprovalRequests.status, ['pending_approval']),
          ),
        )
        .returning();
      if (updated.length === 0) {
        // Lost the race — surface as STALE so the client refetches.
        const reread = await deps.db
          .select()
          .from(egressApprovalRequests)
          .where(eq(egressApprovalRequests.requestId, requestId));
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          `egress request ${requestId} was resolved concurrently`,
          'stale_target',
          undefined,
          reread[0] ? toActionCenterItem(reread[0], ctx) : undefined,
        );
      }

      return {
        resolvedAt: new Date().toISOString(),
        // The "operation" the standalone settings route exposes — keep
        // the audit trail symmetric whether the admin clicked from AC
        // or from the settings page link.
        dispatchedOperationId: 'tenant.egress_requests.patch',
        reportedOperationId: 'tenant.egress_requests.patch',
      };
    },
  };
}

// ============================================================================
// Row → ActionCenterSourceItem
// ============================================================================

function toActionCenterItem(row: Row, scope: ActionCenterScope): ActionCenterSourceItem {
  const isTenantScope = row.scope === 'tenant';
  const isTerminal = row.status !== 'pending_approval';
  const recordVersion = isTerminal ? 1 : 0;

  const origin: ActionCenterItemOrigin = {
    type: 'settings',
    recordKind: EGRESS_RECORD_KIND,
    recordId: row.requestId,
    recordVersion,
  };

  const requestedBy: ActionCenterRequester = {
    kind: row.requestedBy === 'unknown' ? 'system' : 'agent',
    label: row.requestedBy,
  };

  const hostList = row.requestedHosts.join(', ');
  const scopeLabel = isTenantScope ? 'tenant-wide' : 'space-scoped';
  const summary =
    `Approve compute egress to ${String(row.requestedHosts.length)} host(s) ` +
    `(${scopeLabel}): ${truncate(hostList, 200)}` +
    (row.reason ? ` — ${truncate(row.reason, 200)}` : '');

  const item: ActionCenterSourceItem = {
    id: `${EGRESS_ITEM_ID_PREFIX}${row.requestId}`,
    // Tenant-scoped requests are surfaced into every space's AC; we
    // stamp the *viewing* spaceId on the item so the projection
    spaceId: scope.spaceId,
    kind: 'human_approval',
    origin,
    title: isTenantScope
      ? `Compute egress (tenant): ${String(row.requestedHosts.length)} host(s)`
      : `Compute egress: ${String(row.requestedHosts.length)} host(s)`,
    summary,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy,
    priority: isTenantScope ? 'high' : 'normal',
    relatesTo: [],
    resolverPolicy: { minResolvers: 1, requireAll: false, candidateResolvers: ['admin'] },
    resolverAuthority: { kind: 'space' },
    status: isTerminal ? 'resolved' : 'open',
    ...(row.reviewedAt ? { resolvedAt: row.reviewedAt.toISOString() } : {}),
    ...(row.reviewedBy ? { resolvedBy: row.reviewedBy } : {}),
  };
  return item;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
