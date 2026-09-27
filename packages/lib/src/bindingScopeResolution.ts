/** Minimal binding shape required for scope resolution. */
export interface ScopedBinding {
  scope: {
    tenantId: string;
    spaceId?: string | undefined;
    flowId?: string | undefined;
  };
  enabled?: boolean | undefined;
}

/** Context for scope resolution — the current job's identifiers. */
export interface ScopeContext {
  tenantId: string;
  spaceId?: string | undefined;
  flowId?: string | undefined;
}

/**
 * Resolve the best binding from a list of candidates using scope scoring.
 *
 * Priority (highest to lowest):
 * 1. Flow-scoped binding matching the job's flowId (score 3)
 * 2. Space-scoped binding matching the job's spaceId (score 2)
 * 3. Tenant-scoped binding with no space/flow restriction (score 1)
 *
 * Bindings that don't match any scope are skipped. Disabled bindings are
 * included in scoring (caller should check `.enabled` separately for
 * better error messages).
 *
 * @param candidates - Pre-filtered bindings for the target entity (apiId or serverId)
 * @param ctx - Current job's scope context
 * @returns The highest-scoring binding, or undefined if none match
 */
export function resolveBindingByScope<T extends ScopedBinding>(
  candidates: T[],
  ctx: ScopeContext,
): T | undefined {
  if (candidates.length === 0) return undefined;

  let best: T | undefined;
  let bestScore = -1;

  for (const binding of candidates) {
    let score = 0;

    if (binding.scope.flowId && ctx.flowId && binding.scope.flowId === ctx.flowId) {
      score = 3;
    } else if (binding.scope.spaceId && ctx.spaceId && binding.scope.spaceId === ctx.spaceId) {
      score = 2;
    } else if (!binding.scope.spaceId && !binding.scope.flowId) {
      score = 1;
    } else {
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      best = binding;
    }
  }

  return best;
}
