import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  TenantId,
  SkillProjection,
  EntityDirectives,
  ActivationStatus,
  SkillCapabilityDependency,
  Workflow,
  TaskCapabilityGrant,
  RunAccessGrant,
} from '@aflow/schemas';
import {
  SkillProjectionSchema,
  getPlatformOperationPrefixes,
  getOperationsByStepType,
  grantDecisionForOperation,
  parseTenantCapabilityCeiling,
  SPACE_POLICY_OPERATION_PREFIXES,
  CODE_REPO_CAPABILITY_ID,
  CODE_MODEL_CAPABILITY_ID,
  LANE_CAPABILITY_PROVIDERS,
  laneCapabilityTokensForTask,
  subsumeLaneTokens,
  codeLaneComposed,
  hostLaneComposed,
  foldMissingCapabilitiesForAbsentCodeLane,
  type CodeLane,
} from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiDefinitions,
  capabilityProfiles,
  mcpServerBindings,
  providerCredentials,
  repoBindings,
  spaceCapabilityAssignments,
  spaces,
  tenants,
} from '@aflow/database';
import { collectOperationTaskApiRefs } from './operationTaskApiRefs.js';
import { listRecentRuns, getRunStatistics } from './ledger.js';
import {
  loadSkill,
  listSkillsForSpace,
  writeSkillProjection,
  type SkillLoadContext,
} from './skill.js';
import { ensureWorkflowDocValidity, hashWorkflowConfig } from './skillValidity/skillValidity.js';
import {
  clearPendingRepairFingerprints,
  shouldClearValidityRepairState,
  shouldFireValidityTransition,
} from './coachTriggerValidity.js';
import { maybeTriggerValidityRepairReview } from './coachTriggerValidityDispatch.js';
import {
  computeMaturityTransition,
  countConsecutiveSuccesses,
  deriveSkillMaturity,
  resolveSkillMaturityKnobs,
  type SkillMaturityTransition,
} from './skillMaturity.js';
import { loadBaseline } from './baselineManager.js';
import { listCampaigns, getCampaignScoreSeries } from './campaigns.js';
import { detectTrajectoryRegression } from './promotion.js';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ReconcilerContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  redis?: Redis;
  inTransaction?: boolean;
  directives?: EntityDirectives;
}

export interface RebuildSkillProjectionResult {
  projection: SkillProjection;
  maturityTransition?: SkillMaturityTransition;
}

// ============================================================================
// Capability resolution (104g read-path)
// ============================================================================

/**
 * Unconditionally available platform operation prefixes.
 *
 * Derived from the operation registry minus
 * `SPACE_POLICY_OPERATION_PREFIXES` so adding a new platform step type
 * (`ai`, `mcp`, `user`, …) auto-propagates here. Previously a
 * hand-written list that drifted out of sync — runners authored
 * `operations: ['ai.text.generate']` and the missing-from-list `'ai'`
 * was sent through `checkMissingCapabilities` and surfaced as
 * `references operation "ai"` even though `ai.*` is a built-in.
 */
const PLATFORM_PREFIXES = getPlatformOperationPrefixes();

/**
 * Check which required capabilities are missing from the space's registry.
 *
 * For each prefix in `requiredCapabilities`:
 * - Platform prefixes are always satisfied.
 * - For other prefixes (e.g., 'stripe', 'github'), checks if there's at
 *   least one credentialled API binding or bound MCP tool with that prefix.
 *
 * Returns the list of unsatisfied prefixes (empty = all satisfied).
 *
 * NOTE: This uses a simple heuristic — if ANY binding exists with a matching
 * apiId prefix, the capability is considered present. A more precise check
 * would verify individual operation IDs, but prefix-level is sufficient for
 * the activation guard (the full per-op check happens at validate-and-propose time).
 */
/**
 * Query the space's capability registry and return which required prefixes
 * are missing credentialled bindings (API or MCP).
 *
 * A prefix is "satisfied" if there exists at least one enabled credentialled
 * binding whose apiId/serverId matches. Scope filtering: bindings scoped to
 * a different space are excluded; tenant-wide (no spaceId) are included.
 */
/**
 * Space roles whose tenant default profile can start a run. `viewer` is
 * excluded: its default is read-only, so holding it to the same lane coverage
 * would withhold every lane from every unassigned space.
 */
const RUN_CAPABLE_DEFAULT_ROLES = ['admin', 'editor'] as const;

/**
 * The space-dependent half of activation readiness: every capability identifier
 * currently available in the space. Includes each enabled API/MCP binding's
 * definition id (apiId/serverId) and binding id (104n binding-level grants),
 * scope-filtered to this space, plus each `SPACE_POLICY_OPERATION_PREFIXES`
 * prefix whose space policy is switched on. This set changes when the operator
 * binds/unbinds a capability or flips a policy — independently of any skill
 * config — which is why activation must be recomputed against it at read time
 * rather than trusted from a cached projection.
 */
export interface AvailableCapabilities {
  available: Set<string>;
  /**
   * Whether this deployment composes a managed coding lane at all. Where it
   * does not, `code` is never available and the lane's tokens fold into
   * `code_lane_absent`, because no space setting, repo or key changes that.
   */
  codeLane: CodeLane;
  /**
   * Policy-prefix tokens (`compute`, `code`) whose write capability groups the
   * space's effective authority does not cover, keyed to the missing group ids.
   * Distinct from a switched-off space policy: an authority gap is closed by a
   * tenant admin, not by any space setting.
   */
  withheldByProfile: Map<string, string[]>;
  /**
   * The subset of `withheldByProfile` the TENANT CEILING excludes. Reassigning
   * the space's profile cannot close these — the ceiling ANDs over every
   * profile by design — so only lifting it or granting the group to the user
   * does.
   */
  withheldByCeiling: Map<string, string[]>;
  /**
   * The groups the space's own profile (or, unassigned, the role defaults)
   * fails to cover, computed WITHOUT reference to the ceiling. Kept apart from
   * `withheldByCeiling` because the two overlap: when both gates deny the same
   * group, lifting the ceiling alone still leaves the lane blocked, and a
   * caller that cannot see this distinction would name only one remedy.
   */
  withheldByProfileAlone: Map<string, string[]>;
}

export async function loadAvailableCapabilitySet(ctx: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<Set<string>> {
  return (await loadAvailableCapabilities(ctx)).available;
}

export async function loadAvailableCapabilities(ctx: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<AvailableCapabilities> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  const {
    apiRows,
    mcpRows,
    readyRepoCount,
    spaceRow,
    laneProviderIds,
    codeEnabled,
    profileRow,
    roleDefaultRows,
    ceilingExcludedGroups,
  } = await withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const apiRows = await tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        scopeJson: apiBindings.scopeJson,
      })
      .from(apiBindings)
      .where(eq(apiBindings.enabled, 1));
    const mcpRows = await tx
      .select({
        bindingId: mcpServerBindings.bindingId,
        serverId: mcpServerBindings.serverId,
        scopeJson: mcpServerBindings.scopeJson,
      })
      .from(mcpServerBindings)
      .where(eq(mcpServerBindings.enabled, 1));
    // A repo designation in 'ready' already encodes provisioning + a resolvable
    // credential (resolveRepoBinding), so a single ready row satisfies the
    // kind-level `code_repo` dependency — no separate credential join needed.
    const readyRepoRows = await tx
      .select({ coordinate: repoBindings.coordinate })
      .from(repoBindings)
      .where(and(eq(repoBindings.spaceId, ctx.spaceId), eq(repoBindings.status, 'ready')))
      .limit(1);
    const [spaceRow] = await tx
      .select({ computePolicy: spaces.computePolicy, ownerId: spaces.ownerId })
      .from(spaces)
      .where(eq(spaces.id, ctx.spaceId));
    // Lane credentials (`code_model`, `search_provider`): kind-level, so the
    // scope chain here is owner-user/space/tenant — the OWNER stands in for
    // "a user of this space" (exact for personal spaces; at run time the
    // resolver still resolves per session creator). Table-missing tolerated.
    const laneProviders = [...new Set(Object.values(LANE_CAPABILITY_PROVIDERS).flat())];
    const laneScopeIds = [
      ctx.spaceId,
      ctx.tenantId,
      ...(spaceRow?.ownerId ? [spaceRow.ownerId] : []),
    ];
    let laneProviderIds: string[] = [];
    try {
      const laneRows = await tx
        .select({ providerId: providerCredentials.providerId })
        .from(providerCredentials)
        .where(
          and(
            inArray(providerCredentials.providerId, laneProviders),
            inArray(providerCredentials.scopeId, laneScopeIds),
          ),
        );
      laneProviderIds = (laneRows as Array<{ providerId: string }>).map((r) => r.providerId);
    } catch {
      laneProviderIds = [];
    }
    // Kept last and guarded: an image can deploy ahead of the tenant migration
    // that adds the column, and a policy this space cannot read is OFF — the
    // coding lane's fail-closed default.
    let codeEnabled = false;
    try {
      const [codeRow] = await tx
        .select({ codePolicy: spaces.codePolicy })
        .from(spaces)
        .where(eq(spaces.id, ctx.spaceId));
      codeEnabled = codeRow?.codePolicy?.enabled === true;
    } catch {
      codeEnabled = false;
    }
    // Every column `enforceGrant` consults, not just the allowlist: a deny
    // entry or a withheld risk modifier refuses an operation the allowlist
    // covers, and reading only the allowlist reports those as ready.
    const profileColumns = {
      name: capabilityProfiles.name,
      allowedCapabilities: capabilityProfiles.allowedCapabilities,
      deniedCapabilities: capabilityProfiles.deniedCapabilities,
      allowedRiskModifiers: capabilityProfiles.allowedRiskModifiers,
      deniedRiskModifiers: capabilityProfiles.deniedRiskModifiers,
      allowPrivileged: capabilityProfiles.allowPrivileged,
    };
    const [profileRow] = await tx
      .select(profileColumns)
      .from(spaceCapabilityAssignments)
      .innerJoin(
        capabilityProfiles,
        eq(capabilityProfiles.id, spaceCapabilityAssignments.profileId),
      )
      .where(eq(spaceCapabilityAssignments.spaceId, ctx.spaceId))
      .limit(1);
    // Only reached when the space wears no explicit profile: the grant then
    // compiles against the caller's role default, and readiness cannot see
    // which role that is.
    const roleDefaultRows = profileRow
      ? []
      : await tx
          .select({ defaultForRole: capabilityProfiles.defaultForRole, ...profileColumns })
          .from(capabilityProfiles)
          .where(
            and(
              eq(capabilityProfiles.isDefault, true),
              inArray(capabilityProfiles.defaultForRole, [...RUN_CAPABLE_DEFAULT_ROLES]),
            ),
          );
    // `tenants` is a public-schema table reached through the transaction's
    // search_path. Guarded for the same reason as the code policy above: an
    // image can deploy ahead of the migration that adds the column, and a
    // throw here would brick every readiness surface in the space.
    let ceilingExcludedGroups: string[] = [];
    try {
      const [tenantRow] = await tx
        .select({ capabilityCeiling: tenants.capabilityCeiling })
        .from(tenants)
        .where(eq(tenants.tenantId, ctx.tenantId))
        .limit(1);
      ceilingExcludedGroups =
        parseTenantCapabilityCeiling(tenantRow?.capabilityCeiling)?.excludedGroups ?? [];
    } catch {
      ceilingExcludedGroups = [];
    }
    return {
      apiRows,
      mcpRows,
      readyRepoCount: readyRepoRows.length,
      spaceRow,
      laneProviderIds,
      codeEnabled,
      profileRow,
      roleDefaultRows,
      ceilingExcludedGroups,
    };
  });

  const available = new Set<string>();
  for (const row of apiRows) {
    const scope = row.scopeJson as Record<string, unknown> | null;
    const scopeSpaceId = scope?.['spaceId'] as string | undefined;
    if (!scopeSpaceId || scopeSpaceId === ctx.spaceId) {
      available.add(row.apiId);
      available.add(row.bindingId);
    }
  }
  for (const row of mcpRows) {
    const scope = row.scopeJson as Record<string, unknown> | null;
    const scopeSpaceId = scope?.['spaceId'] as string | undefined;
    if (!scopeSpaceId || scopeSpaceId === ctx.spaceId) {
      available.add(row.serverId);
      available.add(row.bindingId);
    }
  }

  // Plan 302: readiness must ask the same question enforcement answers. The
  // space policy flag and the capability profile are independent gates — a
  // lane can be switched on while the profile (e.g. Personal Safe) withholds
  // its capability groups, and enforcement dispatches against the profile.
  //
  // With no assignment row the grant compiles against the caller's ROLE
  // default, which readiness cannot resolve without the principal — and the
  // role defaults disagree (`Standard` carries the code lane read-only while
  // `Full Access` carries it read+write), so assuming coverage reports a lane
  // ready that enforcement then denies. A lane is therefore treated as covered
  // only when EVERY run-capable role default carries its write groups; a
  // missing role default reads as uncovered.
  //
  // The tenant ceiling SUBTRACTS: `applyCapabilityCeiling` drops an excluded
  // group from the allowlist and adds a deny, so a lane the profile allows can
  // still be denied at dispatch — it has to be checked here or readiness
  // reports a false ready. Only the per-user grant that pierces the ceiling is
  // additive, and ignoring it (readiness has no principal) leaves this in the
  // safe direction: a false `needsSetup`, never a false ready.
  const ceilingExcluded = new Set(ceilingExcludedGroups);
  const profileGrant = profileRow ? synthesizeProfileGrant(profileRow) : null;
  const roleDefaultGrants = roleDefaultRows.map((row) => synthesizeProfileGrant(row));

  const withheldByProfile = new Map<string, string[]>();
  const withheldByCeiling = new Map<string, string[]>();
  const withheldByProfileAlone = new Map<string, string[]>();
  const laneGaps = (
    prefix: string,
  ): { missing: string[]; ceiling: string[]; profileAlone: string[] } => {
    // Ask enforcement's own predicate per operation rather than reducing the
    // lane to write-mode group ids: `enforceGrant` matches group AND access
    // mode exactly, so a profile holding only `:write` covers no read
    // operation, and it also consults denies, risk modifiers and
    // `allowPrivileged` — none of which a group-id set can express.
    //
    // Judged as an `op_task` caller: `code.agent.run` and `code.repo.push` are
    // `opTaskOnly`, which an `agent` caller is refused outright, so judging as
    // an agent would report the code lane permanently unavailable. The lane
    // question is whether its operations can run at all, and they run as
    // operation tasks.
    const ops = laneOperations(prefix);
    const deniedGroupsFor = (grant: RunAccessGrant | null): string[] => {
      if (!grant) return [];
      const denied = new Set<string>();
      for (const op of ops) {
        if (!grantDecisionForOperation(grant, op.operationId, { kind: 'op_task' }).allowed) {
          denied.add(op.capabilityGroupId);
        }
      }
      return [...denied];
    };

    const groups = [...new Set(ops.map((op) => op.capabilityGroupId))];
    const ceiling = groups.filter((group) => ceilingExcluded.has(group));
    const profileMissing = profileRow
      ? deniedGroupsFor(profileGrant)
      : roleDefaultRows.length < RUN_CAPABLE_DEFAULT_ROLES.length
        ? groups
        : [...new Set(roleDefaultGrants.flatMap((grant) => deniedGroupsFor(grant)))];
    return {
      missing: [...new Set([...ceiling, ...profileMissing])],
      ceiling,
      profileAlone: profileMissing,
    };
  };

  const recordLane = (prefix: string, policyEnabled: boolean): void => {
    const { missing, ceiling, profileAlone } = laneGaps(prefix);
    if (missing.length > 0) withheldByProfile.set(prefix, missing);
    if (ceiling.length > 0) withheldByCeiling.set(prefix, ceiling);
    if (profileAlone.length > 0) withheldByProfileAlone.set(prefix, profileAlone);
    if (policyEnabled && missing.length === 0) available.add(prefix);
  };

  const policy = spaceRow?.computePolicy as { enabled?: boolean } | null | undefined;
  recordLane('compute', policy?.enabled === true);
  const codeLane = codeLaneComposed();
  recordLane('code', codeEnabled && codeLane === 'present');
  // The host lane has no space policy: its grant is the folder binding. It is
  // recorded only where a machine can pair, since a profile gap on a lane the
  // deployment does not compose sends the operator to a setting that changes
  // nothing.
  if (hostLaneComposed() === 'present') recordLane('host', true);

  if (readyRepoCount > 0) available.add(CODE_REPO_CAPABILITY_ID);

  const lanePresent = new Set(laneProviderIds);
  for (const [laneId, providers] of Object.entries(LANE_CAPABILITY_PROVIDERS)) {
    if (providers.some((p) => lanePresent.has(p))) available.add(laneId);
  }
  for (const p of LANE_CAPABILITY_PROVIDERS[CODE_MODEL_CAPABILITY_ID] ?? []) {
    if (lanePresent.has(p)) available.add(`${CODE_MODEL_CAPABILITY_ID}:${p}`);
  }

  return { available, codeLane, withheldByProfile, withheldByCeiling, withheldByProfileAlone };
}

/** The grant-relevant operations a policy-gated lane is made of. */
function laneOperations(prefix: string): Array<{ operationId: string; capabilityGroupId: string }> {
  const ops: Array<{ operationId: string; capabilityGroupId: string }> = [];
  for (const [operationId, desc] of getOperationsByStepType(prefix)) {
    if (desc.bypassGrant) continue;
    ops.push({ operationId, capabilityGroupId: desc.capabilityGroupId });
  }
  return ops;
}

function parseCapabilityEntries(raw: unknown): Array<{
  capabilityGroupId: string;
  accessMode: 'read' | 'write';
}> {
  if (!Array.isArray(raw)) return [];
  const entries: Array<{ capabilityGroupId: string; accessMode: 'read' | 'write' }> = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const groupId = (entry as Record<string, unknown>)['capabilityGroupId'];
    const accessMode = (entry as Record<string, unknown>)['accessMode'];
    if (typeof groupId !== 'string') continue;
    if (accessMode !== 'read' && accessMode !== 'write') continue;
    entries.push({ capabilityGroupId: groupId, accessMode });
  }
  return entries;
}

function parseStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * A profile shaped as the grant `enforceGrant` would compile from it, so
 * readiness can ask the real predicate instead of approximating it.
 *
 * The principal-scoped fields carry placeholders: readiness has no principal,
 * and none of them reach the capability decision. `accessLevel: 'write'` and a
 * future `expiresAt` keep the two run-scoped short-circuits out of the way, so
 * what remains is exactly the profile's own authority.
 */
function synthesizeProfileGrant(row: {
  name?: string | null;
  allowedCapabilities: unknown;
  deniedCapabilities: unknown;
  allowedRiskModifiers: unknown;
  deniedRiskModifiers: unknown;
  allowPrivileged: boolean | null;
}): RunAccessGrant {
  const epoch = new Date(0).toISOString();
  return {
    spaceId: '00000000-0000-0000-0000-000000000000',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000000',
    tenantRole: 'member',
    spaceRole: 'admin',
    grantedAt: epoch,
    expiresAt: new Date(8640000000000000).toISOString(),
    capabilities: {
      allowedCapabilities: parseCapabilityEntries(row.allowedCapabilities),
      deniedCapabilities: parseCapabilityEntries(row.deniedCapabilities),
      allowedRiskModifiers: parseStringArray(row.allowedRiskModifiers),
      deniedRiskModifiers: parseStringArray(row.deniedRiskModifiers),
      allowPrivileged: row.allowPrivileged === true,
    },
    ...(row.name ? { compiledProfileName: row.name } : {}),
  } as RunAccessGrant;
}

export async function checkMissingCapabilities(
  ctx: ReconcilerContext,
  requiredCapabilities: readonly string[],
): Promise<string[]> {
  if (requiredCapabilities.length === 0) return [];
  const externalPrefixes = requiredCapabilities.filter((p) => !PLATFORM_PREFIXES.has(p));
  if (externalPrefixes.length === 0) return [];
  const { available, codeLane } = await loadAvailableCapabilities(ctx);
  return foldMissingCapabilitiesForAbsentCodeLane(
    externalPrefixes.filter((prefix) => !available.has(prefix)),
    codeLane,
  );
}

export function computeActivationStatus(
  status: string,
  missingCapabilities: string[],
  capabilityDependencies: SkillCapabilityDependency[],
): ActivationStatus {
  if (status === 'archived') return 'archived';
  if (status === 'dormant') return 'dormant';
  if (missingCapabilities.length > 0) return 'needs_binding';
  if (capabilityDependencies.some((d) => d.status === 'missing_endpoint')) return 'degraded';
  return 'active';
}

export function applyCapabilityStatuses(
  deps: SkillCapabilityDependency[],
  missingCapabilityPrefixes: string[],
  endpointIdsByApiId: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const missingSet = new Set(missingCapabilityPrefixes);
  for (const dep of deps) {
    if (dep.capabilityType === 'api') {
      const defId = dep.definitionId;
      if (defId && missingSet.has(defId)) {
        dep.status = 'needs_binding';
        continue;
      }
      if (defId && dep.endpoints && dep.endpoints.length > 0) {
        const known = endpointIdsByApiId.get(defId);
        if (known) {
          const missing = dep.endpoints.map((ep) => ep.endpointId).filter((id) => !known.has(id));
          if (missing.length > 0) {
            dep.status = 'missing_endpoint';
            dep.missingEndpointIds = missing;
          }
        }
      }
    } else if (dep.capabilityType === 'mcp') {
      const defId = dep.definitionId;
      if (defId && missingSet.has(defId)) {
        dep.status = 'needs_binding';
      }
    } else if (dep.capabilityType === 'operation') {
      const prefix = dep.capabilityId.split('.')[0];
      if (prefix && missingSet.has(prefix)) {
        dep.status = 'needs_binding';
      }
    } else if (dep.capabilityType === 'repo' || dep.capabilityType === 'lane') {
      // Kind-level tokens (ready repo / lane credential) — unmet when the token
      // itself is missing from the space's capability set.
      if (missingSet.has(dep.capabilityId)) {
        dep.status = 'needs_binding';
      }
    }
  }
}

/**
 * Space-policy-gated step-type prefixes (`compute`, `code`) a workflow's tasks
 * reference. The operations exist in the registry for every space, so the
 * operator's policy is the only thing standing between the skill and a
 * mid-run permission failure.
 *
 * Reads the same three surfaces as `deriveRequiredCapabilities`: a task's own
 * operation and the grants on an agent task's tool surface. `compute.sandbox.exec`
 * reaches a workflow either way — only the `code.*` ops are `opTaskOnly`.
 */
export function deriveWorkflowPolicyPrefixes(
  tasks: ReadonlyArray<{ operation?: string | null | undefined; context?: unknown }>,
): string[] {
  const prefixes = new Set<string>();
  const addPrefixOf = (operationId: unknown): void => {
    if (typeof operationId !== 'string') return;
    const prefix = operationId.split('.')[0];
    if (prefix && SPACE_POLICY_OPERATION_PREFIXES.has(prefix)) prefixes.add(prefix);
  };

  for (const task of tasks) {
    addPrefixOf(task.operation);

    if (!task.context || typeof task.context !== 'object') continue;
    const ctx = task.context as Record<string, unknown>;

    const caps = ctx['capabilities'];
    if (caps && typeof caps === 'object') {
      const operations = (caps as Record<string, unknown>)['operations'];
      if (Array.isArray(operations)) {
        for (const op of operations) addPrefixOf(op);
      }
    }

    const tools = ctx['tools'];
    if (Array.isArray(tools)) {
      for (const tool of tools) addPrefixOf(tool);
    }
  }
  return [...prefixes];
}

/** Lane tokens required by a workflow's tasks (deduped). */
export function deriveWorkflowLaneTokens(
  tasks: ReadonlyArray<{ operation?: string | null | undefined; inputTemplate?: unknown }>,
): string[] {
  const tokens = new Set<string>();
  for (const task of tasks) {
    for (const token of laneCapabilityTokensForTask(task)) tokens.add(token);
  }
  return subsumeLaneTokens(tokens);
}

async function loadEndpointIdsByApiId(
  ctx: ReconcilerContext,
  deps: SkillCapabilityDependency[],
): Promise<Map<string, Set<string>>> {
  const apiIds = new Set<string>();
  for (const d of deps) {
    if (d.capabilityType === 'api' && d.definitionId) {
      apiIds.add(d.definitionId);
    }
  }
  if (apiIds.size === 0) return new Map();

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const rows = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
    tx
      .select({ apiId: apiDefinitions.apiId, definitionJson: apiDefinitions.definitionJson })
      .from(apiDefinitions)
      .where(eq(apiDefinitions.spaceId, ctx.spaceId)),
  );
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!apiIds.has(row.apiId)) continue;
    const def = row.definitionJson as { endpoints?: Array<{ endpointId?: string }> } | null;
    const ids = new Set<string>();
    for (const ep of def?.endpoints ?? []) {
      if (typeof ep.endpointId === 'string') ids.add(ep.endpointId);
    }
    result.set(row.apiId, ids);
  }
  return result;
}

// ============================================================================
// Capability dependency derivation (104n §4.2)
// ============================================================================

/**
 * Derive capability dependencies from a workflow's task-level grants.
 *
 * Scans each task's `context.capabilities` (structured grants) and
 * `context.tools` (legacy flat tools) to build a list of dependencies
 * the skill has on external capabilities.
 *
 * Status is set to 'ready' here — the caller should cross-reference
 * with the space's binding state and update status accordingly.
 */
export function deriveCapabilityDependencies(workflow: Workflow): SkillCapabilityDependency[] {
  // Key: capabilityType:capabilityId[:bindingId]
  const depMap = new Map<
    string,
    {
      dep: Omit<SkillCapabilityDependency, 'taskIds'>;
      taskIds: Set<string>;
    }
  >();

  function getOrCreate(
    key: string,
    factory: () => Omit<SkillCapabilityDependency, 'taskIds'>,
  ): Set<string> {
    let entry = depMap.get(key);
    if (!entry) {
      entry = { dep: factory(), taskIds: new Set() };
      depMap.set(key, entry);
    }
    return entry.taskIds;
  }

  for (const task of workflow.tasks) {
    // Operation-type tasks
    if (task.operation) {
      const prefix = task.operation.split('.')[0];
      if (prefix && !PLATFORM_PREFIXES.has(prefix)) {
        const key = `operation:${task.operation}`;
        getOrCreate(key, () => ({
          capabilityType: 'operation',
          capabilityId: task.operation!,
          status: 'ready',
        })).add(task.taskId);
      }
      // Plan 222 P2: a code.* op resolves a repo designation → a kind-level repo
      // dependency, satisfied space-wide by any ready repo (set in loadAvailableCapabilitySet).
      if (prefix === 'code') {
        getOrCreate(`repo:${CODE_REPO_CAPABILITY_ID}`, () => ({
          capabilityType: 'repo',
          capabilityId: CODE_REPO_CAPABILITY_ID,
          status: 'ready',
        })).add(task.taskId);
      }
      for (const token of laneCapabilityTokensForTask(task)) {
        getOrCreate(`lane:${token}`, () => ({
          capabilityType: 'lane',
          capabilityId: token,
          status: 'ready',
        })).add(task.taskId);
      }
    }

    if (!task.context || typeof task.context !== 'object') continue;

    const ctx = task.context as Record<string, unknown>;

    // Structured capability grants (104n)
    if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
      const caps = ctx['capabilities'] as TaskCapabilityGrant;

      if (Array.isArray(caps.integrations)) {
        for (const grant of caps.integrations) {
          if (grant.binding.kind === 'connection') {
            // A connection-deferred grant resolves at dispatch to the run's pinned
            // connection; emit a kind-level dep on the integration id (no fixed
            // bindingId) so it is satisfied-by-any-binding, never needs_binding
            // forever. Mirrors the kind-level repo dep above.
            getOrCreate(`${grant.sourceKind}:${grant.capabilityId}`, () => ({
              capabilityType: grant.sourceKind,
              capabilityId: grant.capabilityId,
              definitionId: grant.integrationId,
              status: 'ready',
            })).add(task.taskId);
            continue;
          }
          const grantBindingId = grant.binding.bindingId;
          if (grant.sourceKind === 'api') {
            const key = `api:${grant.capabilityId}:${grantBindingId}`;
            const taskIds = getOrCreate(key, () => ({
              capabilityType: 'api',
              capabilityId: grant.capabilityId,
              bindingId: grantBindingId,
              definitionId: grant.integrationId,
              endpoints: [],
              status: 'ready',
            }));
            taskIds.add(task.taskId);

            const entry = depMap.get(key)!;
            const existingEndpoints = (entry.dep.endpoints ?? []) as Array<{
              endpointId: string;
              revision?: string;
              schemaHash?: string;
            }>;
            for (const t of grant.toolNames) {
              if (!existingEndpoints.some((e) => e.endpointId === t.toolName)) {
                existingEndpoints.push({
                  endpointId: t.toolName,
                  ...(t.revision ? { revision: t.revision } : {}),
                  ...(t.schemaHash ? { schemaHash: t.schemaHash } : {}),
                });
              }
            }
            entry.dep = { ...entry.dep, endpoints: existingEndpoints };
          } else {
            const key = `mcp:${grant.capabilityId}:${grantBindingId}`;
            const taskIds = getOrCreate(key, () => ({
              capabilityType: 'mcp',
              capabilityId: grant.capabilityId,
              bindingId: grantBindingId,
              definitionId: grant.integrationId,
              tools: [],
              status: 'ready',
            }));
            taskIds.add(task.taskId);

            const entry = depMap.get(key)!;
            const existingTools = (entry.dep.tools ?? []) as Array<{
              toolName: string;
              schemaHash?: string;
            }>;
            for (const t of grant.toolNames) {
              if (!existingTools.some((e) => e.toolName === t.toolName)) {
                existingTools.push({
                  toolName: t.toolName,
                  ...(t.schemaHash ? { schemaHash: t.schemaHash } : {}),
                });
              }
            }
            entry.dep = { ...entry.dep, tools: existingTools };
          }
        }
      }

      // Structured operation grants
      if (Array.isArray(caps.operations)) {
        for (const op of caps.operations) {
          if (typeof op !== 'string') continue;
          const prefix = op.split('.')[0];
          if (prefix && !PLATFORM_PREFIXES.has(prefix)) {
            const key = `operation:${op}`;
            getOrCreate(key, () => ({
              capabilityType: 'operation',
              capabilityId: op,
              status: 'ready',
            })).add(task.taskId);
          }
        }
      }
    }

    // Legacy: context.tools flat array
    if ('tools' in ctx && Array.isArray(ctx['tools'])) {
      for (const tool of ctx['tools'] as unknown[]) {
        if (typeof tool !== 'string') continue;
        const prefix = tool.split('.')[0];
        if (prefix && !PLATFORM_PREFIXES.has(prefix)) {
          const key = `operation:${tool}`;
          getOrCreate(key, () => ({
            capabilityType: 'operation',
            capabilityId: tool,
            status: 'ready',
          })).add(task.taskId);
        }
      }
    }
  }

  // api.http.call operation tasks reference a binding via inputTemplate, not a
  // context grant — register them as api dependencies so the projection's
  // readiness (missingCapabilities / activation status) sees the binding
  // instead of reporting "ready" while it is unbound.
  for (const ref of collectOperationTaskApiRefs(workflow.tasks)) {
    const key = `api:${ref.apiId}:${ref.bindingId ?? ''}`;
    const taskIds = getOrCreate(key, () => ({
      capabilityType: 'api',
      capabilityId: ref.apiId,
      ...(ref.bindingId ? { bindingId: ref.bindingId } : {}),
      definitionId: ref.apiId,
      endpoints: [],
      status: 'ready',
    }));
    taskIds.add(ref.taskId);
    if (ref.endpointId) {
      const entry = depMap.get(key)!;
      const existingEndpoints = (entry.dep.endpoints ?? []) as Array<{ endpointId: string }>;
      if (!existingEndpoints.some((e) => e.endpointId === ref.endpointId)) {
        existingEndpoints.push({ endpointId: ref.endpointId });
      }
      entry.dep = { ...entry.dep, endpoints: existingEndpoints };
    }
  }

  return [...depMap.values()].map((entry) => ({
    ...entry.dep,
    taskIds: [...entry.taskIds],
  })) as SkillCapabilityDependency[];
}

// ============================================================================
// Core reconciler
// ============================================================================

/**
 * Rebuild the projection for a single skill from source-of-truth SQL data.
 * Idempotent — safe to call multiple times.
 */
export async function rebuildSkillProjection(
  ctx: ReconcilerContext,
  skillId: string,
): Promise<RebuildSkillProjectionResult | null> {
  const skillCtx: SkillLoadContext = {
    db: ctx.db,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    ...(ctx.inTransaction ? { inTransaction: true } : {}),
  };
  const resolved = await loadSkill(skillCtx, skillId);
  if (!resolved) {
    getCyberneticLogger().debug('reconciler: no manifest for skill, skipping', { skillId });
    return null;
  }

  const { manifest } = resolved;

  const stats = await getRunStatistics(ctx.db, ctx.tenantId, ctx.spaceId, manifest.workflowSlug, {
    windowDays: 365,
  });
  const maturityKnobs = resolveSkillMaturityKnobs(ctx.directives?.learningPolicy);
  const recentRuns = await listRecentRuns(
    ctx.db,
    ctx.tenantId,
    ctx.spaceId,
    manifest.workflowSlug,
    { limit: Math.max(1, maturityKnobs.masteredConsecutiveSuccesses * 2) },
  );

  const lastRun = recentRuns[0];

  let recentRegression = false;
  try {
    const baseline = await loadBaseline(ctx.db, ctx.tenantId, ctx.spaceId, manifest.workflowSlug);
    if (baseline && baseline.currentBreachCount >= baseline.consecutiveBreachesRequired) {
      recentRegression = true;
    }
  } catch {
    /* best-effort */
  }
  if (!recentRegression && manifest.goal.type === 'numeric') {
    try {
      const activeCampaigns = await listCampaigns(ctx.db, ctx.tenantId, {
        spaceId: ctx.spaceId,
        workflowSlug: manifest.workflowSlug,
        status: 'active',
      });
      const policy = ctx.directives?.learningPolicy;
      for (const campaign of activeCampaigns) {
        const series = await getCampaignScoreSeries(ctx.db, ctx.tenantId, campaign.campaignId);
        const regression = detectTrajectoryRegression(
          series.map((p) => p.score),
          campaign.direction,
          {
            k: policy?.coachTrajectoryRegressionK ?? 2,
            minRuns: policy?.coachTrajectoryMinRuns ?? 6,
            recentWindow: policy?.coachTrajectoryRecentWindow ?? 3,
          },
        );
        if (regression?.regressed) {
          recentRegression = true;
          break;
        }
      }
    } catch {
      /* best-effort */
    }
  }

  const derivedMaturity = deriveSkillMaturity(
    {
      completedRuns: stats.completedRuns,
      consecutiveSuccesses: countConsecutiveSuccesses(recentRuns.map((r) => r.status)),
      recentRegression,
    },
    maturityKnobs,
  );
  const maturityTransition = computeMaturityTransition(
    resolved.projection?.maturity,
    derivedMaturity,
  );

  // 104g: check capability satisfaction. Lane tokens and space-policy prefixes
  // are re-derived from the live workflow (not trusted from the manifest's
  // frozen requiredCapabilities) so skills installed before a gate existed
  // still gain the check.
  const laneTokens = resolved.workflow ? deriveWorkflowLaneTokens(resolved.workflow.tasks) : [];
  const policyPrefixes = resolved.workflow
    ? deriveWorkflowPolicyPrefixes(resolved.workflow.tasks)
    : [];
  const requiredCaps = [
    ...new Set([...manifest.requiredCapabilities, ...laneTokens, ...policyPrefixes]),
  ];
  const missingCaps = await checkMissingCapabilities(ctx, requiredCaps);
  const existingStatus = resolved.projection?.status ?? 'active';

  // 104n: derive capability dependencies from task-level grants
  const capabilityDependencies = resolved.workflow
    ? deriveCapabilityDependencies(resolved.workflow)
    : [];

  const endpointIdsByApiId = await loadEndpointIdsByApiId(ctx, capabilityDependencies);
  applyCapabilityStatuses(capabilityDependencies, missingCaps, endpointIdsByApiId);

  const contractValidity = ensureWorkflowDocValidity(resolved.workflow);
  const priorContractStatus = resolved.projection?.contractValidity?.status;

  const contractValidityHash = resolved.workflow
    ? hashWorkflowConfig(resolved.workflow.tasks, resolved.workflow.stateVariables)
    : undefined;

  const projection: SkillProjection = {
    schemaVersion: 1,
    skillId: manifest.skillId,
    status: existingStatus,
    activationStatus: computeActivationStatus(existingStatus, missingCaps, capabilityDependencies),
    missingCapabilities: missingCaps,
    capabilityDependencies,
    contractValidity,
    ...(contractValidityHash !== undefined ? { contractValidityHash } : {}),
    lastUsedAt: lastRun?.startedAt.toISOString(),
    usageCount: stats.completedRuns,
    maturity: derivedMaturity,
    projectedAt: new Date().toISOString(),
  };

  SkillProjectionSchema.parse(projection);

  await writeSkillProjection(skillCtx, projection);

  if (maturityTransition && ctx.redis) {
    try {
      await appendEntityEvent(ctx.redis, {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        event: {
          eventId: randomUUID(),
          eventType: 'entity.skill.maturity_transition',
          spaceId: ctx.spaceId,
          tenantId: ctx.tenantId,
          timestamp: Date.now(),
          workflowSlug: manifest.workflowSlug,
          operatingMode: 'supervisory',
          payload: {
            skillId: manifest.skillId,
            from: maturityTransition.from,
            to: maturityTransition.to,
            completedRuns: stats.completedRuns,
            recentRegression,
          },
          summary: `Skill "${manifest.skillId}" maturity ${maturityTransition.from} → ${maturityTransition.to}`,
        },
      });
    } catch (err) {
      getCyberneticLogger().warn('reconciler: maturity-transition event emit failed', {
        skillId,
        error: String(err),
      });
    }
  }

  if (ctx.redis) {
    if (shouldFireValidityTransition(priorContractStatus, contractValidity.status)) {
      try {
        await maybeTriggerValidityRepairReview({
          db: ctx.db,
          redis: ctx.redis,
          tenantId: ctx.tenantId,
          spaceId: ctx.spaceId,
          workflowSlug: manifest.workflowSlug,
          diagnostics: contractValidity.diagnostics,
          anchorRunId: lastRun?.runId ?? randomUUID(),
        });
      } catch (err) {
        getCyberneticLogger().warn('reconciler: validity repair trigger failed', {
          skillId,
          error: String(err),
        });
      }
    } else if (shouldClearValidityRepairState(priorContractStatus, contractValidity.status)) {
      try {
        await clearPendingRepairFingerprints(ctx.redis, ctx.spaceId, manifest.workflowSlug);
      } catch (err) {
        getCyberneticLogger().warn('reconciler: pending-repair clear failed', {
          skillId,
          error: String(err),
        });
      }
    }
  }

  getCyberneticLogger().debug('reconciler: rebuilt projection', {
    skillId,
    usageCount: projection.usageCount,
    maturity: projection.maturity,
    activationStatus: projection.activationStatus,
    missingCapabilities: projection.missingCapabilities,
    contractValidity: projection.contractValidity?.status,
  });

  return { projection, ...(maturityTransition ? { maturityTransition } : {}) };
}

/**
 * Rebuild projections for all skills in a space.
 * Used by scarcity-sweep (104c §4.8).
 */
export async function rebuildAllSkillProjections(ctx: ReconcilerContext): Promise<void> {
  const skillCtx: SkillLoadContext = {
    db: ctx.db,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
    ...(ctx.inTransaction ? { inTransaction: true } : {}),
  };
  const skills = await listSkillsForSpace(skillCtx);

  for (const skill of skills) {
    try {
      await rebuildSkillProjection(ctx, skill.manifest.skillId);
    } catch (err) {
      getCyberneticLogger().warn('reconciler: failed to rebuild skill', {
        skillId: skill.manifest.skillId,
        error: String(err),
      });
    }
  }

  getCyberneticLogger().debug('reconciler: rebuildAll complete', {
    spaceId: ctx.spaceId,
    count: skills.length,
  });
}

export async function onSkillRunCompleted(
  ctx: ReconcilerContext,
  workflowSlug: string,
): Promise<{ maturityTransition?: SkillMaturityTransition }> {
  // The skillId equals the workflowSlug by convention (104b backfill mapping)
  const result = await rebuildSkillProjection(ctx, workflowSlug);
  return result?.maturityTransition ? { maturityTransition: result.maturityTransition } : {};
}
