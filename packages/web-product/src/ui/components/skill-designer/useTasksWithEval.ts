'use client';

import { useMemo } from 'react';
import { useApiQuery } from '../../hooks/useApiQuery.js';

interface EvalsBundle {
  suite?: { taskCriteria?: Record<string, unknown[]> } | null | undefined;
}

/** Task ids that have eval criteria in the skill's eval suite. Per-task criteria
 *  live in `/evals/{slug}`, not the workflow doc, so the node eval badge needs
 *  this companion fetch. */
export function useTasksWithEval(spaceId: string, slug: string): Set<string> {
  const q = useApiQuery<EvalsBundle>({
    key: ['space', spaceId, 'workflow', slug, 'evals'],
    path: `/spaces/${spaceId}/workflows/${slug}/evals`,
    spaceId,
    staleTime: 60_000,
    enabled: !!slug,
  });
  return useMemo(() => {
    const tc = q.data?.suite?.taskCriteria ?? {};
    return new Set(Object.keys(tc).filter((k) => (tc[k]?.length ?? 0) > 0));
  }, [q.data]);
}
