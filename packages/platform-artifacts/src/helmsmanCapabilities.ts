import {
  applyBundlePlacements,
  buildCoreToolSpec,
  bundleForOperation,
  bundlesForSurface,
  estimateToolSchemaTokens,
  isOperationComposed,
  withGuaranteedReadOps,
  type ComposedLanes,
  type DirectiveCapabilityDiscovery,
} from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from './cyberneticAgents.js';
import { composeHelmsmanSurface, type HelmsmanSurface } from './helmsmanSurface.js';

export function resolveHelmsmanBaseSurface(
  lanes: ComposedLanes,
  discovery?: DirectiveCapabilityDiscovery,
  authored?: HelmsmanSurface,
): HelmsmanSurface {
  const config = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman')?.steps.find(
    (s) => s['operation'] === 'ai.agent.turn',
  )?.['config'] as
    | { catalog?: { coreOperations?: string[]; discovery?: { allowedOperationIds?: string[] } } }
    | undefined;
  const composed = composeHelmsmanSurface(
    authored ?? {
      coreOperations: config?.catalog?.coreOperations ?? [],
      promotableOperations: config?.catalog?.discovery?.allowedOperationIds ?? [],
    },
    lanes,
  );
  return {
    coreOperations: [...new Set(composed.coreOperations)],
    promotableOperations: [
      ...new Set(discovery?.helmsmanOperations ?? composed.promotableOperations),
    ].filter((id) => isOperationComposed(id, lanes)),
  };
}

export function estimateOperationTokens(operationId: string): number {
  const spec = buildCoreToolSpec(operationId);
  return spec ? estimateToolSchemaTokens(spec) : 0;
}

export function resolveHelmsmanCapabilities(
  lanes: ComposedLanes,
  discovery?: DirectiveCapabilityDiscovery,
) {
  const authored = resolveHelmsmanBaseSurface(lanes, discovery);
  const placed = applyBundlePlacements(
    authored.coreOperations,
    authored.promotableOperations,
    discovery?.bundlePlacements,
    discovery?.operationPlacements,
  );
  const coreOperations = withGuaranteedReadOps({
    coreOperations: placed.coreOperations,
  }).coreOperations;
  const authority = [...new Set([...authored.coreOperations, ...authored.promotableOperations])];
  const bundles = bundlesForSurface(authority).map((bundle) => {
    const operations = authority
      .filter((id) => bundleForOperation(id)?.id === bundle.id)
      .map((operationId) => ({
        operationId,
        tokens: estimateOperationTokens(operationId),
        defaultPinned: authored.coreOperations.includes(operationId),
      }));
    const pinned = operations.filter((op) => op.defaultPinned);
    const defaultPlacement =
      pinned.length === 0
        ? ('on_demand' as const)
        : pinned.length === operations.length
          ? ('always_on' as const)
          : ('mixed' as const);
    return {
      ...bundle,
      defaultPlacement,
      operations,
      operationCount: operations.length,
      alwaysOnTokens: operations.reduce((n, op) => n + op.tokens, 0),
      authoredPinnedCount: pinned.length,
      authoredPinnedTokens: pinned.reduce((n, op) => n + op.tokens, 0),
      ...(bundle.locked ? { lockedReason: bundle.locked.reason } : {}),
    };
  });
  return {
    ...placed,
    coreOperations,
    bundles,
    pinnedCount: coreOperations.length,
    pinnedTokens: coreOperations.reduce((n, id) => n + estimateOperationTokens(id), 0),
  };
}
