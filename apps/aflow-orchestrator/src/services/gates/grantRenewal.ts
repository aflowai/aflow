import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { RunAccessGrant, TenantId } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { setRunAccessGrant } from '@aflow/redis';
import {
  readEstablishedAuthority,
  revalidatePrincipalSpaceAccess,
} from '../SessionOrchestrator/helpers/executionAuthority.js';

/** The principal a fresh grant is compiled for. */
export interface GrantRenewalSource {
  spaceId: string;
  spaceRole: string;
  userId: string;
  tenantRole: string;
}

/**
 * What to recompile a run's access grant from, or null if it needs no renewal
 * or offers nothing to renew from.
 *
 * A grant is recompiled against current policy, so renewing never widens
 * access — it only avoids destroying work whose authority still holds. The
 * alternative at this call site is pausing, which strands the run: the pause
 * happens before any step state exists and so carries no resume contract.
 *
 * An aged-out grant renews from itself. An absent one renews from the
 * authority the run was established under, which outlives it — recovery
 * rebuilds hot state from replayed events without the grant, and a grant is
 * only ever compiled where an actor context exists.
 */
export function resolveGrantRenewalSource(
  grant: RunAccessGrant | null,
  runState: SessionHotState | null | undefined,
  now: Date = new Date(),
): GrantRenewalSource | null {
  if (grant) {
    if (new Date(grant.expiresAt) > now) return null;
    return grantPrincipalSource(grant);
  }

  const authority = runState ? readEstablishedAuthority(runState) : undefined;
  if (!authority) return null;
  return {
    spaceId: authority.spaceId,
    spaceRole: authority.spaceRole,
    userId: authority.principalUserId,
    tenantRole: authority.tenantRole,
  };
}

/** The principal an existing grant was compiled for. */
export function grantPrincipalSource(grant: RunAccessGrant): GrantRenewalSource {
  return {
    spaceId: grant.spaceId,
    spaceRole: grant.spaceRole,
    userId: grant.grantedToUserId,
    tenantRole: grant.tenantRole,
  };
}

export class GrantRenewalRefused extends Error {}

/**
 * Recompile a run's grant for `source` and store it on the run's hot state.
 *
 * Renewal is a start/resume-grade authorization point: the principal's space
 * access is re-checked before compiling, so a revoked or narrowed principal
 * cannot keep renewing until hot state ages out. Recompiling against current
 * policy grants exactly what the compiler grants today — a stored copy can
 * be up to its TTL stale in either direction, which is why preflight
 * decisions renew instead of trusting it.
 */
export async function renewRunAccessGrant(
  db: PostgresJsDatabase,
  redis: Redis,
  opts: { tenantId: TenantId; runId: string; source: GrantRenewalSource },
): Promise<RunAccessGrant> {
  const access = await revalidatePrincipalSpaceAccess(db, redis, {
    tenantId: opts.tenantId,
    userId: opts.source.userId,
    spaceId: opts.source.spaceId,
    establishedSpaceRole: opts.source.spaceRole,
  });
  if (!access.ok) throw new GrantRenewalRefused(access.detail);
  const { compileRunAccessGrant } = await import('@aflow/authz');
  const grant = await compileRunAccessGrant(
    { tenantId: opts.tenantId, ...opts.source, grantReason: 'resume' },
    db,
  );
  await setRunAccessGrant(redis, opts.tenantId, opts.runId, grant);
  return grant;
}
