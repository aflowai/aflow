import { and, eq } from 'drizzle-orm';
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
import {
  INTEGRATION_REQUEST_SCOPE,
  requestIntegrationKind,
  resolveIntegrationHostRequest,
} from '../../integrationHostRequests.js';

const ITEM_ID_PREFIX = 'settings:integration-host-';
const RECORD_KIND = 'integration_host_request';

type Row = typeof egressApprovalRequests.$inferSelect;

/**
 * Integration-host access requests are tenant-wide grants, so pending ones
 * surface in every space's Action Center (only admins can resolve them) —
 * mirroring the tenant-scoped compute egress rows.
 */
export function createIntegrationHostRequestSource(
  deps: ActionCenterSourceDeps,
): ActionCenterSource {
  return {
    name: 'integrationHostRequest',
    rowScope: 'space',
    handlesOriginTypes: ['settings'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await deps.db
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.tenantId, scope.tenantId),
            eq(egressApprovalRequests.scope, INTEGRATION_REQUEST_SCOPE),
            eq(egressApprovalRequests.status, 'pending_approval'),
          ),
        );
      return rows.map((row) => toActionCenterItem(row, scope));
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
      const requestId = itemId.slice(ITEM_ID_PREFIX.length);
      const rows = await deps.db
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.tenantId, ctx.tenantId),
            eq(egressApprovalRequests.requestId, requestId),
            eq(egressApprovalRequests.scope, INTEGRATION_REQUEST_SCOPE),
          ),
        );
      const row = rows[0];
      if (!row) return null;
      return toActionCenterItem(row, ctx);
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      if (resolution.kind !== 'approve' && resolution.kind !== 'reject') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `integration host requests accept 'approve' or 'reject' only; got '${resolution.kind}'`,
        );
      }
      // Approving inserts a TENANT-wide allowlist row, so a space-level admin
      // role is not enough — fail closed on the tenant-admin flag.
      if (!ctx.actorIsTenantAdmin) {
        throw new ActionCenterResolveError(
          'FORBIDDEN',
          `Resolving an integration host request requires a tenant admin; user ${ctx.actorUserId} is not one.`,
        );
      }
      const requestId = item.id.slice(ITEM_ID_PREFIX.length);

      const result = await resolveIntegrationHostRequest(deps.db, {
        tenantId: ctx.tenantId,
        requestId,
        resolution: resolution.kind === 'approve' ? 'approved' : 'rejected',
        reviewedBy: ctx.actorUserId,
        audit: (event) => {
          deps.audit?.record({
            actor: {
              userId: ctx.actorUserId,
              kind: 'human',
              authMethod: ctx.actorAuthMethod ?? 'unknown',
              tenantId: ctx.tenantId,
            },
            category: 'admin',
            action: event.action,
            outcome: 'success',
            target: {
              resourceType: event.resourceType,
              resourceId: event.resourceId,
              tenantId: ctx.tenantId,
            },
            details: event.details,
          });
        },
      });
      if (result.outcome === 'not_found') {
        throw new ActionCenterResolveError(
          'NOT_FOUND',
          `integration host request ${requestId} not found`,
        );
      }
      if (result.outcome === 'already_resolved') {
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          `integration host request ${requestId} is no longer pending (status: ${result.row.status})`,
          'stale_target',
          undefined,
          toActionCenterItem(result.row, ctx),
        );
      }

      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: 'tenant.integration_host_requests.patch',
        reportedOperationId: 'tenant.integration_host_requests.patch',
      };
    },
  };
}

// ============================================================================
// Row → ActionCenterSourceItem
// ============================================================================

function toActionCenterItem(row: Row, scope: ActionCenterScope): ActionCenterSourceItem {
  const isTerminal = row.status !== 'pending_approval';
  const hostPattern = row.requestedHosts[0] ?? '';
  const kind = requestIntegrationKind(row);

  const origin: ActionCenterItemOrigin = {
    type: 'settings',
    recordKind: RECORD_KIND,
    recordId: row.requestId,
    recordVersion: isTerminal ? 1 : 0,
  };

  const requestedBy: ActionCenterRequester = {
    kind: row.requestedBy === 'unknown' ? 'system' : 'agent',
    label: row.requestedBy,
  };

  const summary =
    `Allow ${kind === 'mcp' ? 'MCP' : 'API'} integrations to reach ${hostPattern} ` +
    `(tenant-wide allowlist)` +
    (row.reason ? ` — ${truncate(row.reason, 200)}` : '');

  return {
    id: `${ITEM_ID_PREFIX}${row.requestId}`,
    spaceId: scope.spaceId,
    kind: 'human_approval',
    origin,
    title: `Integration host: ${hostPattern}`,
    summary,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy,
    priority: 'high',
    relatesTo: [],
    resolverPolicy: { minResolvers: 1, requireAll: false, candidateResolvers: ['admin'] },
    // The grant is tenant-wide, so the space role the policy above names is
    // not the role that may issue it. Everyone in the space still sees the
    // request; only a tenant admin is offered the buttons.
    resolverAuthority: { kind: 'tenant_admin' },
    status: isTerminal ? 'resolved' : 'open',
    ...(row.reviewedAt ? { resolvedAt: row.reviewedAt.toISOString() } : {}),
    ...(row.reviewedBy ? { resolvedBy: row.reviewedBy } : {}),
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
