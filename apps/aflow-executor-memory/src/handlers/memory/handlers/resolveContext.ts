import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PathResolveContext, ToolOutputIndex } from '@aflow/memory-paths';
import type { MemoryHandlerDeps } from './types.js';

/** Redis hot state key pattern for runtime state */
const RUN_STATE_KEY = (tenantId: string, runId: string) =>
  `aflow:session:${tenantId}:${runId}:state`;

/**
 * Build a PathResolveContext for the shared resolver.
 *
 * The memoryDocReader is left as a stub here — for virtual paths, the resolver
 * doesn't need it. For persistent path resolution via the resolver (as in
 * compute's inputPaths), the caller should provide the real repo.
 */
export function buildResolveContext(
  ctx: ExecutorContext,
  deps: MemoryHandlerDeps,
): PathResolveContext {
  return {
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    spaceId: ctx.job.spaceId ?? '',
    payloadStore: deps.payloadStore,
    memoryDocReader: {
      // For virtual paths, this is never called. For persistent paths,
      // the memory executor uses its own repo directly (not through the resolver).
      getByPath: () => Promise.resolve(null),
    },
    toolOutputIndexReader: {
      readToolOutputIndex: async (
        tenantId: string,
        runId: string,
      ): Promise<ToolOutputIndex | null> => {
        const stateKey = RUN_STATE_KEY(tenantId, runId);
        const raw = await deps.redis.hget(stateKey, 'runtimeState');
        if (!raw) return null;
        try {
          const state = JSON.parse(raw) as {
            variables?: Record<string, { ref?: { kind: string; value?: unknown } } | undefined>;
          };
          const entry = state.variables?.['_tool_outputs'];
          if (entry?.ref?.kind === 'inline' && typeof entry.ref.value === 'object') {
            return entry.ref.value as ToolOutputIndex;
          }
          return null;
        } catch {
          return null;
        }
      },
    },
  };
}
