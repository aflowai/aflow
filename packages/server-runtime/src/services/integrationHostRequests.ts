/**
 * Integration-host access requests ride `egress_approval_requests` under
 * `scope: 'integration'`. Resolution is shared between the tenant admin route
 * and the Action Center source so an approval always lands the allowlist row
 * in the same transaction that closes the request.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  egressApprovalRequests,
  tenantIntegrationAllowlist,
  type EgressApprovalRequestRow,
} from '@aflow/database';
import type { IntegrationAllowlistKind, IntegrationHostRequest } from '@aflow/schemas';

export const INTEGRATION_REQUEST_SCOPE = 'integration';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIntegrationKind(row: EgressApprovalRequestRow): IntegrationAllowlistKind {
  return row.integrationKind === 'mcp' ? 'mcp' : 'api';
}

export function mapIntegrationHostRequestRow(
  row: EgressApprovalRequestRow,
): IntegrationHostRequest {
  return {
    requestId: row.requestId,
    kind: requestIntegrationKind(row),
    hostPattern: row.requestedHosts[0] ?? '',
    ...(row.spaceId ? { spaceId: row.spaceId } : {}),
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    ...(row.reason ? { reason: row.reason } : {}),
    status: row.status as IntegrationHostRequest['status'],
    ...(row.reviewedBy ? { reviewedBy: row.reviewedBy } : {}),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
    ...(row.reviewNote ? { reviewNote: row.reviewNote } : {}),
  };
}

export type ResolveIntegrationHostRequestOutcome =
  | { outcome: 'resolved'; row: EgressApprovalRequestRow }
  | { outcome: 'not_found' }
  | { outcome: 'already_resolved'; row: EgressApprovalRequestRow };

/**
 * One event shape for both resolution surfaces (tenant admin route + Action
 * Center source) — each maps it onto its own audit recorder, so the two
 * paths cannot drift on what a resolve records.
 */
export interface IntegrationHostRequestAuditEvent {
  action: 'tenant.integration_host_request.resolve';
  resourceType: 'integration_host_request';
  resourceId: string;
  details: { resolution: 'approved' | 'rejected'; hostPattern: string };
}

export async function resolveIntegrationHostRequest(
  db: PostgresJsDatabase,
  opts: {
    tenantId: string;
    requestId: string;
    resolution: 'approved' | 'rejected';
    reviewedBy: string;
    reviewNote?: string;
    audit?: (event: IntegrationHostRequestAuditEvent) => void;
  },
): Promise<ResolveIntegrationHostRequestOutcome> {
  const result = await resolveInTransaction(db, opts);
  if (result.outcome === 'resolved') {
    opts.audit?.({
      action: 'tenant.integration_host_request.resolve',
      resourceType: 'integration_host_request',
      resourceId: opts.requestId,
      details: {
        resolution: opts.resolution,
        hostPattern: result.row.requestedHosts[0] ?? '',
      },
    });
  }
  return result;
}

async function resolveInTransaction(
  db: PostgresJsDatabase,
  opts: {
    tenantId: string;
    requestId: string;
    resolution: 'approved' | 'rejected';
    reviewedBy: string;
    reviewNote?: string;
  },
): Promise<ResolveIntegrationHostRequestOutcome> {
  return db.transaction(async (tx) => {
    // Conditional WHERE on (status, scope) is the CAS guard — a concurrent
    // resolver wins the race and this call updates 0 rows.
    const updated = await tx
      .update(egressApprovalRequests)
      .set({
        status: opts.resolution,
        reviewedBy: opts.reviewedBy,
        reviewedAt: new Date(),
        ...(opts.reviewNote !== undefined ? { reviewNote: opts.reviewNote } : {}),
      })
      .where(
        and(
          eq(egressApprovalRequests.requestId, opts.requestId),
          eq(egressApprovalRequests.tenantId, opts.tenantId),
          eq(egressApprovalRequests.scope, INTEGRATION_REQUEST_SCOPE),
          inArray(egressApprovalRequests.status, ['pending_approval']),
        ),
      )
      .returning();

    const row = updated[0];
    if (!row) {
      const existing = await tx
        .select()
        .from(egressApprovalRequests)
        .where(
          and(
            eq(egressApprovalRequests.requestId, opts.requestId),
            eq(egressApprovalRequests.tenantId, opts.tenantId),
            eq(egressApprovalRequests.scope, INTEGRATION_REQUEST_SCOPE),
          ),
        );
      const found = existing[0];
      if (!found) return { outcome: 'not_found' };
      return { outcome: 'already_resolved', row: found };
    }

    if (opts.resolution === 'approved') {
      const hostPattern = row.requestedHosts[0];
      if (hostPattern) {
        await tx
          .insert(tenantIntegrationAllowlist)
          .values({
            tenantId: opts.tenantId,
            kind: requestIntegrationKind(row),
            hostPattern,
            note: row.reason ?? null,
            addedBy: UUID_PATTERN.test(opts.reviewedBy) ? opts.reviewedBy : null,
          })
          .onConflictDoNothing();
      }
    }

    return { outcome: 'resolved', row };
  });
}
