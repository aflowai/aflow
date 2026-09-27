'use client';

import { useMemo } from 'react';
import { useApiQuery } from '../../hooks/useApiQuery.js';

interface ModelEntry {
  modelId: string;
  displayName?: string | undefined;
  provider?: string | undefined;
  deprecated?: boolean | undefined;
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Agent-allowlisted chat models for the task `model` selector. Public,
 *  space-independent catalog endpoint (no spaceId — the model list is
 *  global), cached long. */
export function useModelOptions(): SelectOption[] {
  const q = useApiQuery<{ models: ModelEntry[] }>({
    key: ['catalog', 'models', 'chat', 'agent'],
    path: '/catalog/models?capability=chat&set=agent',
    staleTime: 300_000,
  });
  return useMemo(
    () =>
      (q.data?.models ?? [])
        .filter((m) => !m.deprecated)
        .map((m) => ({ value: m.modelId, label: m.displayName ?? m.modelId })),
    [q.data],
  );
}
