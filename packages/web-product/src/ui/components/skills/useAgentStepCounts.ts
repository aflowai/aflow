'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { inferTaskType, type Workflow } from '@aflow/schemas';

import { useApi } from '../providers.js';
import { ApiError } from '../../lib/query-client.js';

interface AgentDetail {
  definition: { steps: unknown[] };
}

/** Resolve agent step counts for a workflow's agent tasks so designer nodes can
 *  show a "N steps" badge. Reuses the `['space', spaceId, 'agents', id]` cache. */
export function useAgentStepCounts(
  spaceId: string,
  workflow: Workflow | undefined,
): Map<string, number> {
  const { apiUrl, headers, authFetch } = useApi();

  const agentIds = useMemo<string[]>(() => {
    if (!workflow) return [];
    const ids = new Set<string>();
    for (const task of workflow.tasks) {
      if (inferTaskType(task) === 'agent') {
        ids.add(task.agent ?? workflow.assignedAgent ?? 'cybernetic-runner');
      }
    }
    return [...ids];
  }, [workflow]);

  const queries = useQueries({
    queries: agentIds.map((agentId) => ({
      queryKey: ['space', spaceId, 'agents', agentId] as const,
      enabled: !!spaceId,
      staleTime: 60_000,
      queryFn: async (): Promise<AgentDetail> => {
        const h = headers();
        h['X-Space-ID'] = spaceId;
        const res = await authFetch(`${apiUrl}/agents/${encodeURIComponent(agentId)}`, {
          headers: h,
        });
        if (!res.ok) {
          throw new ApiError({ status: res.status, message: `HTTP ${String(res.status)}` });
        }
        return (await res.json()) as AgentDetail;
      },
    })),
  });

  return useMemo(() => {
    const map = new Map<string, number>();
    agentIds.forEach((id, i) => {
      const d = queries[i]?.data;
      if (d) map.set(id, d.definition.steps.length);
    });
    return map;
  }, [agentIds, queries]);
}
