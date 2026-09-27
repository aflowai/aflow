'use client';

import type { CyberneticEvalSuite } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';

interface EvalsBundle {
  suite?: CyberneticEvalSuite | null | undefined;
}

/** The Coach-authored eval suite for a skill (read-only). Shares the
 *  `…/evals` query cache with `useTasksWithEval`, so it adds no extra fetch. */
export function useSkillEvalSuite(spaceId: string, slug: string): CyberneticEvalSuite | null {
  const q = useApiQuery<EvalsBundle>({
    key: ['space', spaceId, 'workflow', slug, 'evals'],
    path: `/spaces/${spaceId}/workflows/${slug}/evals`,
    spaceId,
    staleTime: 60_000,
    enabled: !!slug,
  });
  return q.data?.suite ?? null;
}
