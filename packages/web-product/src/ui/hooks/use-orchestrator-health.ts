'use client';

/**
 * Whether an orchestrator is consuming, as the API reads it from the
 * orchestrators' leases (`GET /v1/health/orchestrator`).
 *
 * Polled, because nothing that is gone can announce it: the event stream is
 * served by the API, which keeps answering while no orchestrator runs, so a
 * conversation whose messages are accepted and never processed looks, from the
 * stream, exactly like one that is thinking.
 */

import { useApiQuery } from './useApiQuery.js';

/** Half the orchestrator's 30-second lease: a lapse takes a whole lease to appear, so polling faster shows it no sooner. */
export const ORCHESTRATOR_HEALTH_POLL_MS = 15_000;

interface OrchestratorHealth {
  alive: boolean;
  notice: string | null;
}

/** The API's notice while no orchestrator is alive; undefined while one is, or before the first answer. */
export function useOrchestratorNotice(): string | undefined {
  const query = useApiQuery<OrchestratorHealth>({
    key: ['health', 'orchestrator'],
    path: '/health/orchestrator',
    refetchInterval: ORCHESTRATOR_HEALTH_POLL_MS,
  });
  return query.data?.notice ?? undefined;
}
