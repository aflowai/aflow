'use client';

import { useApiQuery } from './useApiQuery.js';
import type { OfferedBundle } from '../components/cybernetic/CapabilityBundleEditor.js';

interface BundleCatalogResponse {
  role: 'helmsman';
  outputReadFloorTokens: number;
  bundles: OfferedBundle[];
}

/**
 * The capability bundles a platform role can reach, with the measured per-turn
 * cost of the tools each pins.
 *
 * Scoped to the space and draft discovery ceiling so previews include unsaved
 * changes and reset-to-default before the directives are persisted.
 */
export function useCapabilityBundles(
  spaceId: string,
  enabled: boolean,
  helmsmanOperations?: string[],
) {
  const query = useApiQuery<BundleCatalogResponse>({
    key: ['space', spaceId, 'helmsman', 'bundles', helmsmanOperations ?? null],
    init: { method: 'POST', body: JSON.stringify({ helmsmanOperations }) },
    headers: { 'Content-Type': 'application/json' },
    path: `/catalog/agents/helmsman/bundles?spaceId=${encodeURIComponent(spaceId)}`,
    spaceId,
    enabled,
    staleTime: 60 * 60 * 1000,
  });

  return {
    bundles: query.data?.bundles ?? [],
    outputReadFloorTokens: query.data?.outputReadFloorTokens ?? 0,
    loading: query.isLoading,
    // An unreadable catalog means "unknown", never "no capability" — rendering
    // an empty panel would read as an agent with nothing switched on.
    unavailable: query.isError,
  };
}
