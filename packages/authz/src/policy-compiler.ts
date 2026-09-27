import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  type TenantId,
  type RunAccessGrant,
  type CapabilitySnapshot,
  type CapabilityEntry,
  type GrantReason,
  RUN_ACCESS_GRANT_TTL_SECONDS,
  parseTenantCapabilityCeiling,
} from '@aflow/schemas';
import {
  withTenantSchema,
  createTenantContext,
  capabilityProfiles,
  spaceCapabilityAssignments,
  tenants,
  tenantCapabilityGrants,
  type CapabilityProfileRow,
} from '@aflow/database';

// ============================================================================
// Compiler Context
// ============================================================================

export interface CompileGrantContext {
  tenantId: TenantId;
  spaceId: string;
  spaceRole: string;
  userId: string;
  tenantRole: string;
  grantReason: GrantReason;
}

// ============================================================================
// Compiler
// ============================================================================

/**
 * Compile a RunAccessGrant from tenant-managed capability profiles.
 *
 * Resolution order:
 * 1. Space-specific profile (space_capability_assignments)
 * 2. Tenant default profile for the user's spaceRole
 *
 * Seed profiles (migration 20) guarantee at least one default per role.
 */
export async function compileRunAccessGrant(
  ctx: CompileGrantContext,
  db: PostgresJsDatabase,
): Promise<RunAccessGrant> {
  const tenantCtx = createTenantContext(ctx.tenantId);

  const profile = await withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Check for space-specific assignment
    const assignments = await tx
      .select({ profileId: spaceCapabilityAssignments.profileId })
      .from(spaceCapabilityAssignments)
      .where(eq(spaceCapabilityAssignments.spaceId, ctx.spaceId))
      .limit(1);

    const assignment = assignments[0];
    if (assignment) {
      const profiles = await tx
        .select()
        .from(capabilityProfiles)
        .where(eq(capabilityProfiles.id, assignment.profileId))
        .limit(1);
      if (profiles[0]) return profiles[0];
    }

    // 2. Fall back to tenant default for the user's space role
    const defaults = await tx
      .select()
      .from(capabilityProfiles)
      .where(
        and(
          eq(capabilityProfiles.isDefault, true),
          eq(capabilityProfiles.defaultForRole, ctx.spaceRole),
        ),
      )
      .limit(1);

    return defaults[0] ?? null;
  });

  if (!profile) {
    throw new Error(
      `No capability profile found for spaceRole '${ctx.spaceRole}' in tenant ${ctx.tenantId}. ` +
        `Run migration 20 to seed default profiles.`,
    );
  }

  const grant = buildGrantFromProfile(profile, ctx);
  const excluded = await loadEffectiveCeilingExclusions(db, ctx.tenantId, ctx.userId);
  const bounded = excluded ? applyCapabilityCeiling(grant, excluded) : grant;

  const granted = await loadUserCapabilityGrants(db, ctx.tenantId, ctx.userId);
  return granted.length > 0 ? applyUserCapabilityGrants(bounded, granted) : bounded;
}

/**
 * The capability groups a tenant admin has granted this user directly.
 *
 * Read separately from the ceiling because the two compose differently: the
 * ceiling subtracts from whatever the space's profile allowed, while a grant
 * adds. A tenant admin manages people, not spaces — so "give this user the
 * sandbox" has to hold in whichever space they work in, including a personal
 * space whose profile deliberately omits it.
 */
async function loadUserCapabilityGrants(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  userId: string,
): Promise<string[]> {
  try {
    const [row] = await db
      .select({ capabilityGroupIds: tenantCapabilityGrants.capabilityGroupIds })
      .from(tenantCapabilityGrants)
      .where(
        and(
          eq(tenantCapabilityGrants.tenantId, tenantId),
          eq(tenantCapabilityGrants.userId, userId),
        ),
      )
      .limit(1);
    return Array.isArray(row?.capabilityGroupIds) ? (row.capabilityGroupIds as string[]) : [];
  } catch {
    // A grant that cannot be read is simply not applied — failing to ADD a
    // capability is the safe direction, unlike failing to subtract one.
    return [];
  }
}

/**
 * Union granted groups into the allowlist and lift any matching denial.
 *
 * Deliberately narrow: a grant conveys capability groups only. It does not
 * touch risk modifiers or `allowPrivileged`, so it can never turn a bounded
 * profile into a privileged one.
 */
export function applyUserCapabilityGrants(
  grant: RunAccessGrant,
  grantedGroups: readonly string[],
): RunAccessGrant {
  if (grantedGroups.length === 0) return grant;
  const granted = new Set(grantedGroups);
  const caps = grant.capabilities;

  const additions: CapabilityEntry[] = [...granted].flatMap((capabilityGroupId) =>
    (['read', 'write'] as const)
      .filter(
        (accessMode) =>
          !caps.allowedCapabilities.some(
            (c) => c.capabilityGroupId === capabilityGroupId && c.accessMode === accessMode,
          ),
      )
      .map((accessMode) => ({ capabilityGroupId, accessMode })),
  );

  return {
    ...grant,
    // An explicit grant outranks the profile's omission, so a granted group
    // must also leave the denylist — otherwise the ceiling's denial entries
    // would still refuse it at enforcement time.
    capabilities: {
      ...caps,
      allowedCapabilities: [...caps.allowedCapabilities, ...additions],
      deniedCapabilities: caps.deniedCapabilities.filter((c) => !granted.has(c.capabilityGroupId)),
    },
  };
}

/**
 * Short-TTL in-process cache of the per-tenant ceiling. The ceiling reads on
 * EVERY grant compilation (every session start / resume / retry / delegated
 * sub-run / TTL renewal), but it only changes via an admin write, so a static
 * value is re-read needlessly. Caching the NULL (no-ceiling) result — the
 * common case — removes the read from the hot path for most tenants entirely.
 *
 * TTL-only invalidation (no cross-process pub/sub): a ceiling change takes up
 * to `CEILING_CACHE_TTL_MS` to apply to newly-compiled grants. That is
 * consistent with the existing model — grants already carry their own TTL and
 * are cached in Redis, so ceiling changes are already eventually-consistent.
 */
const CEILING_CACHE_TTL_MS = 30_000;
const ceilingCache = new Map<
  string,
  { value: ReturnType<typeof parseTenantCapabilityCeiling>; expiresAt: number }
>();

/** Test hook — drop the cache between cases. */
export function clearCeilingCache(): void {
  ceilingCache.clear();
}

/**
 * The tenant's ceiling, cached. Tolerates the column/table being absent — a
 * code deploy can land before its migration, and a throw here would abort
 * grant compilation and pause every session.
 *
 * Error handling is asymmetric on purpose: ONLY a successful read is cached.
 * On a DB error we return the last-known-good value if we have one (so a
 * TRANSIENT failure never silently drops a real ceiling — the backstop must
 * not fail open) and never cache the failure (so the next compile retries).
 * With no prior value (cold start / the migration window where the column
 * doesn't exist yet) we return null uncached — that is the correct fail-open:
 * the ceiling feature is simply not in effect, and the base profile grant
 * still applies.
 */
async function loadTenantCeiling(
  db: PostgresJsDatabase,
  tenantId: TenantId,
): Promise<ReturnType<typeof parseTenantCapabilityCeiling>> {
  const hit = ceilingCache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const [tenantRow] = await db
      .select({ capabilityCeiling: tenants.capabilityCeiling })
      .from(tenants)
      .where(eq(tenants.tenantId, tenantId))
      .limit(1);
    const value = parseTenantCapabilityCeiling(tenantRow?.capabilityCeiling);
    ceilingCache.set(tenantId, { value, expiresAt: Date.now() + CEILING_CACHE_TTL_MS });
    return value;
  } catch {
    // Keep the last-known-good ceiling over fail-open; don't cache the error.
    return hit ? hit.value : null;
  }
}

/**
 * The tenant ceiling minus this user's grant. Returns null when nothing is
 * effectively excluded. Runs on every grant compilation — the ceiling read is
 * cached; the per-user grant read only happens when a ceiling is actually set
 * (uncommon), so no-ceiling tenants pay nothing beyond a cache hit.
 */
export async function loadEffectiveCeilingExclusions(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  userId: string,
): Promise<string[] | null> {
  const ceiling = await loadTenantCeiling(db, tenantId);
  if (!ceiling) return null;

  let granted = new Set<string>();
  try {
    const [grantRow] = await db
      .select({ capabilityGroupIds: tenantCapabilityGrants.capabilityGroupIds })
      .from(tenantCapabilityGrants)
      .where(
        and(
          eq(tenantCapabilityGrants.tenantId, tenantId),
          eq(tenantCapabilityGrants.userId, userId),
        ),
      )
      .limit(1);
    granted = new Set(
      Array.isArray(grantRow?.capabilityGroupIds) ? (grantRow.capabilityGroupIds as string[]) : [],
    );
  } catch {
    granted = new Set();
  }
  const effective = ceiling.excludedGroups.filter((g) => !granted.has(g));
  return effective.length > 0 ? effective : null;
}

/**
 * AND the ceiling over an already-compiled grant: excluded groups leave the
 * allowlist AND enter the denylist, so the exclusion holds regardless of
 * which profile produced the grant.
 */
export function applyCapabilityCeiling(
  grant: RunAccessGrant,
  excludedGroups: readonly string[],
): RunAccessGrant {
  if (excludedGroups.length === 0) return grant;
  const excluded = new Set(excludedGroups);
  const caps = grant.capabilities;
  const ceilingDenies: CapabilityEntry[] = [...excludedGroups].flatMap((capabilityGroupId) => [
    { capabilityGroupId, accessMode: 'read' as const },
    { capabilityGroupId, accessMode: 'write' as const },
  ]);
  return {
    ...grant,
    capabilities: {
      ...caps,
      allowedCapabilities: caps.allowedCapabilities.filter(
        (c) => !excluded.has(c.capabilityGroupId),
      ),
      deniedCapabilities: [...caps.deniedCapabilities, ...ceilingDenies],
    },
  };
}

// ============================================================================
// Grant Builder
// ============================================================================

function buildGrantFromProfile(
  profile: CapabilityProfileRow,
  ctx: CompileGrantContext,
): RunAccessGrant {
  const accessLevel = deriveAccessLevel(profile);

  // JSONB columns from Drizzle (typed as unknown in schema)
  const rawAllowed = profile.allowedCapabilities;
  const rawDenied = profile.deniedCapabilities;
  const rawAllowedMods = profile.allowedRiskModifiers;
  const rawDeniedMods = profile.deniedRiskModifiers;

  const capabilities: CapabilitySnapshot = {
    allowedCapabilities: (Array.isArray(rawAllowed) ? rawAllowed : []) as CapabilityEntry[],
    deniedCapabilities: (Array.isArray(rawDenied) ? rawDenied : []) as CapabilityEntry[],
    allowedRiskModifiers: (Array.isArray(rawAllowedMods) ? rawAllowedMods : []) as string[],
    deniedRiskModifiers: (Array.isArray(rawDeniedMods) ? rawDeniedMods : []) as string[],
    allowPrivileged: profile.allowPrivileged,
  };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + RUN_ACCESS_GRANT_TTL_SECONDS * 1000);

  return {
    spaceId: ctx.spaceId,
    accessLevel,
    grantedToUserId: ctx.userId,
    tenantRole: ctx.tenantRole,
    spaceRole: ctx.spaceRole,
    grantedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    capabilities,
    grantReason: ctx.grantReason,
    compiledProfileId: profile.id,
    compiledProfileName: profile.name,
    compilerVersion: '2.1.0',
    resourceScopes: [],
  };
}

/**
 * Derive access level from profile capabilities.
 */
export function deriveAccessLevel(profile: CapabilityProfileRow): 'read' | 'write' {
  const allowed = (profile.allowedCapabilities ?? []) as CapabilityEntry[];
  const hasWrite = allowed.some((c) => c.accessMode === 'write');
  return hasWrite ? 'write' : 'read';
}
