'use client';

import { useMemo } from 'react';
import { useApiQuery } from './useApiQuery.js';

export interface BlockedOperation {
  operationId: string;
  /** The `capabilityGroupId:accessMode` pair the op needs but the profile lacks. */
  requires: string;
  reason: string;
}

interface GrantabilityResponse {
  spaceRole: string;
  profileId?: string;
  blocked: BlockedOperation[];
}

export interface SpaceOperationGrants {
  /** Ops the space's capability profile would deny at run time, keyed by id. */
  blockedById: Map<string, BlockedOperation>;
  spaceRole?: string;
  loaded: boolean;
}

/**
 * Which operations the space's capability profile would deny for this operator's
 * role, computed server-side by running the real grant gate over the registry.
 * Selection surfaces warn when they pick one of these — a denial that would
 * otherwise only surface once a run starts.
 */
export function useSpaceOperationGrants(spaceId: string): SpaceOperationGrants {
  const q = useApiQuery<GrantabilityResponse>({
    key: ['space', spaceId, 'capabilities', 'operations'],
    path: `/spaces/${spaceId}/capabilities/operations`,
    spaceId,
    staleTime: 120_000,
  });

  return useMemo(() => {
    const blockedById = new Map<string, BlockedOperation>();
    for (const b of q.data?.blocked ?? []) blockedById.set(b.operationId, b);
    return {
      blockedById,
      ...(q.data?.spaceRole ? { spaceRole: q.data.spaceRole } : {}),
      loaded: q.data !== undefined,
    };
  }, [q.data]);
}
