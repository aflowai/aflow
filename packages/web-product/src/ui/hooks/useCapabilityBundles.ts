'use client';

import { useApiQuery } from './useApiQuery.js';
import type { OfferedBundle } from '../components/cybernetic/CapabilityBundleEditor.js';

interface BundleCatalogResponse {
  role: 'helmsman';
  bundles: OfferedBundle[];
}

/**
 * The capability bundles a platform role can reach, with the measured per-turn
 * cost of the tools each pins.
 *
 * Tenant-scoped rather than space-scoped: this is the platform's catalog, the
 * same for every space. What a space overrides lives in its directives.
 */
export function useCapabilityBundles(enabled: boolean) {
  const query = useApiQuery<BundleCatalogResponse>({
    key: ['catalog', 'agents', 'helmsman', 'bundles'],
    path: '/catalog/agents/helmsman/bundles',
    enabled,
    staleTime: 60 * 60 * 1000,
  });

  return {
    bundles: query.data?.bundles ?? [],
    loading: query.isLoading,
    // An unreadable catalog means "unknown", never "no capability" — rendering
    // an empty panel would read as an agent with nothing switched on.
    unavailable: query.isError,
  };
}
