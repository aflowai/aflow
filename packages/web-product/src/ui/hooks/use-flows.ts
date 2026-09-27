'use client';

import { useMemo } from 'react';
import type { Flow } from '../lib/types.js';
import { useApiQuery } from './useApiQuery.js';

interface UseFlowsReturn {
  flows: Flow[];
  isLoading: boolean;
  error: string | null;
}

export function useFlows(spaceId: string): UseFlowsReturn {
  const { data, isLoading, error } = useApiQuery<{ agents?: Flow[] }>({
    key: ['space', spaceId, 'agents'],
    path: '/agents',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 60_000,
  });

  const flows = useMemo(() => data?.agents ?? [], [data]);

  return {
    flows,
    isLoading,
    error: error ? error.message : null,
  };
}
