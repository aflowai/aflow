'use client';

import { useApiQuery } from './useApiQuery.js';
import type { SpaceConnection } from '../components/cybernetic/ConnectionPlacementEditor.js';

interface SpaceConnectionsResponse {
  connections: SpaceConnection[];
}

/**
 * The connections this space has bound, with the measured per-turn cost of
 * pinning each one.
 *
 * Space-scoped, unlike the capability bundles: what a space has connected is
 * its own state, so the key nests under `['space', spaceId]` and a space switch
 * invalidates it. The window matches the turn assembler's binding cache, since
 * that is how long a freshly bound connection takes to reach a run anyway.
 */
export function useSpaceConnections(spaceId: string, enabled: boolean) {
  const query = useApiQuery<SpaceConnectionsResponse>({
    key: ['space', spaceId, 'connections'],
    path: `/spaces/${spaceId}/connections`,
    enabled,
    staleTime: 60 * 1000,
  });

  return {
    connections: query.data?.connections ?? [],
    loading: query.isLoading,
    // An unreadable list means "unknown", never "nothing connected" — the
    // section would otherwise claim the space has no connections to place.
    unavailable: query.isError,
  };
}
