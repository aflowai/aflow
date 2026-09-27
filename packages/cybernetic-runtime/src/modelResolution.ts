import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  type EntityDirectives,
  type DirectiveModelDefaults,
  type DirectiveReasoningDefaults,
  type DirectiveReasoningEffort,
  type SpaceContext,
  type TenantId,
  resolveRoleModel,
  resolveRoleReasoning,
  SPACE_CONTEXT_TTL_MS,
} from '@aflow/schemas';
import { createTenantContext, withTenantSchema, spaces } from '@aflow/database';

/**
 * Read the `EntityDirectives` block for a space. Returns `null` for non-
 * cybernetic spaces (directives column is null).
 */
export async function loadSpaceDirectives(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<EntityDirectives | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const rows = (await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ directives: spaces.directives })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1),
  )) as Array<{ directives: EntityDirectives | null }>;
  return rows[0]?.directives ?? null;
}

/**
 * Resolve the Runner model for a workflow task.
 *
 * @param taskModel  Per-task override from `WorkflowTask.model`, if any.
 * @param defaults   `EntityDirectives.modelDefaults` from the space.
 */
export function resolveRunnerModel(
  taskModel: string | undefined,
  defaults: DirectiveModelDefaults | undefined,
): string {
  return taskModel ?? resolveRoleModel(defaults, 'runner');
}

/**
 * Convenience: load directives and resolve role model in one call.
 * Returns `DEFAULT_CYBERNETIC_MODEL` for non-cybernetic spaces (no directives).
 */
export async function loadRoleModel(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  role: 'helmsman' | 'runner' | 'coach' | 'judge',
): Promise<string> {
  const directives = await loadSpaceDirectives(db, tenantId, spaceId);
  return resolveRoleModel(directives?.modelDefaults, role);
}

/**
 * Resolve the Runner's reasoning effort: per-task → directives → undefined.
 * Returns undefined when no override is set — caller falls through to the
 * catalog model's default.
 *
 * @param taskReasoning  Per-task override from `WorkflowTask.reasoning`, if any.
 * @param defaults       `EntityDirectives.reasoningDefaults` from the space.
 */
export function resolveRunnerReasoning(
  taskReasoning: DirectiveReasoningEffort | undefined,
  defaults: DirectiveReasoningDefaults | undefined,
): DirectiveReasoningEffort | undefined {
  return taskReasoning ?? resolveRoleReasoning(defaults, 'runner');
}

/**
 * Convenience: load directives and resolve role reasoning in one call.
 * Returns undefined for non-cybernetic spaces or when no override is set.
 */
export async function loadRoleReasoning(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  role: 'helmsman' | 'runner' | 'coach' | 'judge',
): Promise<DirectiveReasoningEffort | undefined> {
  const directives = await loadSpaceDirectives(db, tenantId, spaceId);
  return resolveRoleReasoning(directives?.reasoningDefaults, role);
}

// ============================================================================

/** The SessionHotState fields a cached SpaceContext is read from. */
export interface CachedSpaceContextState {
  spaceContextJson?: string | undefined;
  spaceContextBuiltAt?: number | undefined;
  spaceContextGen?: number | undefined;
}

/**
 * The cached SpaceContext in a session's hot state, or undefined when it may
 * not be reused.
 *
 * Two things can retire it, and both must be checked. The 1-hour TTL bounds how
 * long a build stays trustworthy, and the per-space generation records that
 * someone changed the space since — an operator repointing a role at another
 * model is exactly that, and the TTL alone would serve the old assignment for
 * an hour after the change meant to correct it.
 *
 * Mirrors `readCachedSpaceContext` in the orchestrator helpers but kept here so
 * the cybernetic runtime owns the model-resolution chain end-to-end.
 */
function readCachedContext(
  sessionState: CachedSpaceContextState | undefined,
  currentGen: number | undefined,
): SpaceContext | undefined {
  if (!sessionState?.spaceContextJson || !sessionState.spaceContextBuiltAt) return undefined;
  const age = Date.now() - sessionState.spaceContextBuiltAt;
  if (age > SPACE_CONTEXT_TTL_MS) return undefined;
  if (currentGen !== undefined && (sessionState.spaceContextGen ?? 0) !== currentGen) {
    return undefined;
  }

  try {
    return JSON.parse(sessionState.spaceContextJson) as SpaceContext;
  } catch {
    return undefined;
  }
}

/**
 * Hot-path read of `modelDefaults` from the cached SpaceContext. Returns
 * `undefined` when the cache may not be reused or when the space is
 * non-cybernetic (no `directives` in the cached context); callers fall back to
 * `loadSpaceDirectives` only on `undefined`.
 */
export function getCachedModelDefaults(
  sessionState: CachedSpaceContextState | undefined,
  currentGen?: number,
): DirectiveModelDefaults | undefined {
  const ctx = readCachedContext(sessionState, currentGen);
  if (!ctx) return undefined;
  const directives = ctx.space.directives as
    { modelDefaults?: DirectiveModelDefaults } | undefined | null;
  return directives?.modelDefaults ?? undefined;
}

/**
 * Hot-path read of `reasoningDefaults` from the cached SpaceContext. Mirrors
 * `getCachedModelDefaults` exactly — same freshness rules, same fall-back.
 */
export function getCachedReasoningDefaults(
  sessionState: CachedSpaceContextState | undefined,
  currentGen?: number,
): DirectiveReasoningDefaults | undefined {
  const ctx = readCachedContext(sessionState, currentGen);
  if (!ctx) return undefined;
  const directives = ctx.space.directives as
    { reasoningDefaults?: DirectiveReasoningDefaults } | undefined | null;
  return directives?.reasoningDefaults ?? undefined;
}

export async function resolveRunnerModelHot(params: {
  taskModel: string | undefined;
  sessionState: CachedSpaceContextState | undefined;
  /** Live space generation; omit only where no Redis handle is reachable. */
  currentGen?: number;
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<string> {
  const cached = getCachedModelDefaults(params.sessionState, params.currentGen);
  if (cached) {
    return resolveRunnerModel(params.taskModel, cached);
  }
  const directives = await loadSpaceDirectives(params.db, params.tenantId, params.spaceId);
  return resolveRunnerModel(params.taskModel, directives?.modelDefaults);
}

/**
 * Hot-path Runner reasoning resolution. Mirrors `resolveRunnerModelHot`:
 * cache-first, then DB fallback, returning undefined when no override is set.
 */
export async function resolveRunnerReasoningHot(params: {
  taskReasoning: DirectiveReasoningEffort | undefined;
  sessionState: CachedSpaceContextState | undefined;
  /** Live space generation; omit only where no Redis handle is reachable. */
  currentGen?: number;
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<DirectiveReasoningEffort | undefined> {
  const cached = getCachedReasoningDefaults(params.sessionState, params.currentGen);
  if (cached) {
    return resolveRunnerReasoning(params.taskReasoning, cached);
  }
  const directives = await loadSpaceDirectives(params.db, params.tenantId, params.spaceId);
  return resolveRunnerReasoning(params.taskReasoning, directives?.reasoningDefaults);
}
