import { eq, and, desc, isNull, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { AgentDefinitionSchema } from '@aflow/schemas';
import type {
  AgentDefinition,
  AgentId,
  AgentSlug,
  PersistentAgentTarget,
  TenantId,
} from '@aflow/schemas';
import {
  getPlatformAgentBySystemRole,
  listPlatformAgents,
  type PlatformAgentEntry,
} from '@aflow/platform-artifacts';

import {
  agents,
  agentVersions,
  agentSlugHistory,
  type AgentRow,
  type AgentVersionRow,
} from '../schema/tenant.js';
import { withTenantSchema, createTenantContext } from '../tenant.js';

// ============================================================================
// Errors
// ============================================================================

export class UnknownPlatformRoleError extends Error {
  constructor(public readonly systemRole: string) {
    const available = listPlatformAgents()
      .map((e) => e.systemRole)
      .join(', ');
    super(`Unknown platform role "${systemRole}". Available roles: ${available || '(none)'}.`);
  }
}

export class UnknownCustomAgentError extends Error {
  constructor(public readonly agentId: string) {
    super(`Unknown custom agent (id: ${agentId})`);
  }
}

export class UnknownAgentSlugError extends Error {
  constructor(
    public readonly spaceSlug: string,
    public readonly agentSlug: string,
  ) {
    super(`No agent with slug "${agentSlug}" in space "${spaceSlug}"`);
  }
}

/** Custom agent exists but is archived. Distinct from "not found" so callers can recover. */
export class ArchivedAgentError extends Error {
  constructor(public readonly agentId: string) {
    super(`Custom agent (id: ${agentId}) is archived`);
  }
}

/** Requested explicit version is not present. Thrown only when caller asked for a specific version. */
export class VersionNotFoundError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly version: string,
  ) {
    super(`Version "${version}" not found for agent (id: ${agentId})`);
  }
}

// ============================================================================
// Resolved-target shape
// ============================================================================

/** Result of {@link loadAgentTargetDefinition}. */
export interface ResolvedAgentDefinition {
  target: PersistentAgentTarget;
  definition: AgentDefinition;
  /** `'1'` for platform roles (code-immutable); `agent_versions.version` for custom agents. */
  version: string;
  /** Convenience flag for downstream branching. */
  isPlatform: boolean;
}

// ============================================================================
// resolveAgentRef — slug pair → AgentTarget (custom-agent)
// ============================================================================

/**
 * Boundary helper: convert `{ spaceSlug, agentSlug }` (as a client sends it)
 * into a tagged custom-agent target. Looks up `agents` in the tenant schema
 * matching `(space_id, slug)`; falls through to `agent_slug_history` on a
 * direct miss so renamed slugs keep resolving.
 *
 * Rename chains resolve correctly. History rows carry `agent_id` (stable
 * UUID), and after a hit we read back the agent's CURRENT slug from the live
 * `agents` row — so `a → b → c` resolved with `a` returns `{ agentId,
 * redirect: { toSlug: 'c' } }`, never the intermediate `b`.
 *
 * Archived agents are excluded by default (treated as "doesn't exist for
 * resolution purposes"). Pass `includeArchived: true` on admin paths.
 *
 * Throws {@link UnknownAgentSlugError} if neither table matches, or
 * {@link ArchivedAgentError} if the resolved agent is archived and
 * `includeArchived` was not set.
 *
 * This resolver does not handle `{ systemRole }` input — that is a pure
 * registry lookup; callers construct the tagged target directly:
 * `{ kind: 'platform-role', systemRole }`.
 */
export async function resolveAgentRef(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; agentSlug: AgentSlug; includeArchived?: boolean },
): Promise<{
  target: Extract<PersistentAgentTarget, { kind: 'custom-agent' }>;
  redirect?: { fromSlug: AgentSlug; toSlug: AgentSlug };
}> {
  const tenantCtx = createTenantContext(tenantId);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Direct live lookup.
    const [live] = await tx
      .select({ id: agents.id, slug: agents.slug, archivedAt: agents.archivedAt })
      .from(agents)
      .where(and(eq(agents.spaceId, params.spaceId), eq(agents.slug, params.agentSlug)))
      .limit(1);

    if (live) {
      if (live.archivedAt !== null && !params.includeArchived) {
        throw new ArchivedAgentError(live.id);
      }
      return {
        target: { kind: 'custom-agent', agentId: live.id as AgentId },
      };
    }

    // 2. History fallback — the slug was renamed (possibly multiple times).
    //    The history row carries `agent_id` (stable). We then read the current
    //    canonical slug from `agents` so callers always redirect to the
    //    end-of-chain, never an intermediate hop.
    const [historyRow] = await tx
      .select({ agentId: agentSlugHistory.agentId })
      .from(agentSlugHistory)
      .where(
        and(
          eq(agentSlugHistory.spaceId, params.spaceId),
          eq(agentSlugHistory.oldSlug, params.agentSlug),
        ),
      )
      .orderBy(desc(agentSlugHistory.renamedAt))
      .limit(1);

    if (!historyRow) {
      throw new UnknownAgentSlugError(params.spaceId, params.agentSlug);
    }

    const [current] = await tx
      .select({ id: agents.id, slug: agents.slug, archivedAt: agents.archivedAt })
      .from(agents)
      .where(eq(agents.id, historyRow.agentId))
      .limit(1);

    if (!current) {
      // History points at an agent that was hard-deleted. Surface as not-found
      // rather than archived (the row is gone, not just hidden).
      throw new UnknownAgentSlugError(params.spaceId, params.agentSlug);
    }

    if (current.archivedAt !== null && !params.includeArchived) {
      throw new ArchivedAgentError(current.id);
    }

    return {
      target: { kind: 'custom-agent', agentId: current.id as AgentId },
      redirect: {
        fromSlug: params.agentSlug,
        toSlug: current.slug as AgentSlug,
      },
    };
  });
}

// ============================================================================
// loadAgentTargetDefinition — tagged target → AgentDefinition + version
// ============================================================================

/**
 * Load the AgentDefinition for a tagged target.
 *
 * - `platform-role`: returns from the registry. Version is always `'1'`
 *   (platform definitions are code-immutable; behavior changes per space
 *   through `SpaceContext`, not per-version).
 * - `custom-agent`: loads `agent_versions` by `(agent_id, version)`. If
 *   `requestedVersion` is `'latest'` or omitted, returns the most recent
 *   published version. Falls back to "latest of any status" if the requested
 *   exact version is missing (corrupt-version edge case).
 */
export async function loadAgentTargetDefinition(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  target: PersistentAgentTarget,
  requestedVersion = 'latest',
): Promise<ResolvedAgentDefinition> {
  if (target.kind === 'platform-role') {
    if (requestedVersion !== 'latest' && requestedVersion !== '1') {
      throw new Error(
        `Platform role "${target.systemRole}" only has version "1" (requested "${requestedVersion}").`,
      );
    }
    const entry = getPlatformAgentBySystemRole(target.systemRole);
    if (!entry) throw new UnknownPlatformRoleError(target.systemRole);
    const definition = AgentDefinitionSchema.parse({ ...entry.definition, version: '1' });
    return { target, definition, version: '1', isPlatform: true };
  }

  // custom-agent — `PersistentAgentTarget` excludes inline by construction,
  // so there's no inline branch here. Callers with inline targets dereference
  // `definitionRef` via PayloadStore directly (see fetchAgentDef in the
  // orchestrator).
  const tenantCtx = createTenantContext(tenantId);
  const explicitVersion = requestedVersion !== 'latest';

  const result = await withTenantSchema(db, tenantCtx, async (tx) => {
    // Archive guard — refuse to load an archived agent's definition.
    //    Callers that genuinely need archived definitions (admin, audit) can
    //    call the lower-level `getLatestVersionRow` / version repo directly.
    //    Also pulls the current slug so we can override the version JSON's
    //    `flowId` to match (slugs are mutable; renames must not surface as
    //    stale identity in loaded definitions).
    const [agentRow] = await tx
      .select({ archivedAt: agents.archivedAt, slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, target.agentId))
      .limit(1);

    if (!agentRow) return { kind: 'not-found' as const };
    if (agentRow.archivedAt !== null) return { kind: 'archived' as const };

    // Try exact version first if requested.
    if (explicitVersion) {
      const [exact] = await tx
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.agentId, target.agentId),
            eq(agentVersions.version, requestedVersion),
          ),
        )
        .limit(1);
      if (exact) return { kind: 'row' as const, row: exact, slug: agentRow.slug };
      return { kind: 'version-missing' as const };
    }

    // No explicit version → latest published, then latest of any status as a
    // last-ditch fallback. Falling back on a missing explicit version would
    // silently swap definitions on a replay/schedule, so we never do that.
    const [latestPublished] = await tx
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, target.agentId), eq(agentVersions.status, 'published')))
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);
    if (latestPublished) return { kind: 'row' as const, row: latestPublished, slug: agentRow.slug };

    const [latestAny] = await tx
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, target.agentId))
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);
    if (latestAny) return { kind: 'row' as const, row: latestAny, slug: agentRow.slug };

    return { kind: 'not-found' as const };
  });

  if (result.kind === 'not-found') {
    throw new UnknownCustomAgentError(target.agentId);
  }
  if (result.kind === 'archived') {
    throw new ArchivedAgentError(target.agentId);
  }
  if (result.kind === 'version-missing') {
    throw new VersionNotFoundError(target.agentId, requestedVersion);
  }

  const row = result.row;
  const defJson = row.definitionJson as Record<string, unknown>;
  // Always override flowId with the current slug — slug is mutable, the
  // version JSON was captured at publish time, so its `flowId` can be stale.
  defJson['flowId'] = result.slug;
  if (!defJson['version']) defJson['version'] = row.version;
  const definition = AgentDefinitionSchema.parse(defJson);

  return { target, definition, version: row.version, isPlatform: false };
}

// ============================================================================
// List helpers
// ============================================================================

/** List all platform roles known to the registry (catalog discovery). */
export function listPlatformRoles(): readonly PlatformAgentEntry[] {
  return listPlatformAgents();
}

/** List custom agents in a space (catalog discovery). */
export async function listCustomAgentsInSpace(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
): Promise<AgentRow[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions: SQL[] = [eq(agents.spaceId, spaceId)];
    if (!options.includeArchived) {
      conditions.push(isNull(agents.archivedAt));
    }

    let query = tx
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.createdAt));

    if (options.limit) query = query.limit(options.limit) as typeof query;
    if (options.offset) query = query.offset(options.offset) as typeof query;

    return query;
  });
}

const _UUID_SHAPE_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resolveAgentPathParam(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  agentParam: string,
): Promise<{
  target: Extract<PersistentAgentTarget, { kind: 'custom-agent' }>;
  redirect?: { fromSlug: AgentSlug; toSlug: AgentSlug };
}> {
  if (_UUID_SHAPE_PARAM.test(agentParam)) {
    const tenantCtx = createTenantContext(tenantId);
    const row = await withTenantSchema(db, tenantCtx, async (tx) => {
      const [r] = await tx
        .select({ id: agents.id, spaceId: agents.spaceId, archivedAt: agents.archivedAt })
        .from(agents)
        .where(eq(agents.id, agentParam))
        .limit(1);
      return r ?? null;
    });
    // Conflate "not found", "wrong space", and "archived" into the same
    //   not-found response so a probe can't distinguish "this UUID exists
    //   in another space I don't have access to" from "this UUID doesn't
    //   exist at all".
    if (row?.spaceId !== spaceId || row.archivedAt !== null) {
      throw new UnknownCustomAgentError(agentParam);
    }
    return { target: { kind: 'custom-agent', agentId: agentParam as AgentId } };
  }
  return resolveAgentRef(db, tenantId, {
    spaceId,
    agentSlug: agentParam as AgentSlug,
  });
}

/** Load the latest published version row for a custom agent — used by callers that need version metadata, not just the parsed definition. */
export async function getLatestVersionRow(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<AgentVersionRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.status, 'published')))
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);
    return row ?? null;
  });
}
