'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { SESSION_LIST_LIMIT, sessionListKey } from '../../lib/session-list-query.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import type { Flow, Session, SessionSeed } from '../../lib/types.js';

export function useChatSessionRuns(
  selectedFlow: Flow | null,
  spaceId: string,
  initialSessionId?: string | null,
  opts?: {
    /**
     * Auto-resume the agent's most recent session on first load. Cybernetic
     * spaces pass `false` so `/chat` lands on a fresh conversation + Workbench
     * (Plan 228 §5.4); an explicit `?session=` still resumes.
     */
    autoResumeLatest?: boolean;
    /**
     * Called when a `?session=` URL change is adopted over the loaded
     * session — the page clears conversation state that belonged to the
     * previous session.
     */
    onUrlSessionAdopted?: () => void;
  },
) {
  const autoResumeLatest = opts?.autoResumeLatest ?? true;
  const [currentRun, setCurrentRun] = useState<SessionSeed | null>(null);
  const onUrlSessionAdoptedRef = useRef(opts?.onUrlSessionAdopted);
  onUrlSessionAdoptedRef.current = opts?.onUrlSessionAdopted;
  // Agent slug we've already auto-resumed-latest for. Cleared when the
  // operator switches agents; protects against re-seeding the freshly-
  // cleared currentRun on the post-clear effect re-run.
  const autoResumedForAgentRef = useRef<string | null>(null);

  // URL-canonical session switching: a *change* of `initialSessionId` is a
  // navigation intent (deep link, back/forward, Workbench "recent
  // conversations") and must win over the loaded session. The intent stays
  // pending — and the page holds off syncing state back into the URL — until
  // the target resolves and is adopted, fails to resolve, or the URL moves
  // again. State moving away from the URL (agent switch, new chat) does NOT
  // arm adoption: those paths own the URL and clean it up themselves.
  const urlSessionFromProps = initialSessionId ?? null;
  const lastUrlSessionRef = useRef<string | null | undefined>(undefined);
  const pendingUrlSessionRef = useRef<{ target: string | null } | null>(null);
  if (lastUrlSessionRef.current !== urlSessionFromProps) {
    lastUrlSessionRef.current = urlSessionFromProps;
    pendingUrlSessionRef.current = { target: urlSessionFromProps };
  }
  if ((currentRun?.sessionId ?? null) === pendingUrlSessionRef.current?.target) {
    pendingUrlSessionRef.current = null;
  }

  const target = selectedFlow
    ? selectedFlow.systemRole
      ? ({ kind: 'platform-role', value: selectedFlow.systemRole } as const)
      : ({ kind: 'custom-agent', value: selectedFlow.agentId } as const)
    : null;

  const listParams = new URLSearchParams({ limit: String(SESSION_LIST_LIMIT) });
  if (target?.kind === 'platform-role') {
    listParams.set('targetKind', 'platform-role');
    listParams.set('targetSystemRole', target.value);
  } else if (target) {
    listParams.set('targetKind', 'custom-agent');
    listParams.set('targetAgentId', target.value);
  }

  const listQuery = useApiQuery<{ sessions?: Session[] }>({
    key: sessionListKey(spaceId, target?.kind ?? '', target?.value ?? ''),
    path: `/sessions?${listParams.toString()}`,
    enabled: target != null && spaceId.length > 0,
  });
  const listedSessions = selectedFlow ? listQuery.data?.sessions : undefined;
  const recentRuns = useMemo(() => listedSessions ?? [], [listedSessions]);

  // `?session=<id>` deep links (e.g., WorkflowRunSurface's "open runner"
  // affordance) must resolve to the requested session even when it's
  // older than the recent-10 window. Fetch it directly before
  // considering the latest-run fallback.
  const fromUrlRow =
    initialSessionId && listedSessions
      ? listedSessions.find((r) => r.sessionId === initialSessionId)
      : undefined;
  const needsDirectFetch =
    initialSessionId != null && listedSessions !== undefined && fromUrlRow === undefined;
  const directQuery = useApiQuery<Session>({
    key: ['session', initialSessionId ?? 'none', 'detail'],
    path: `/sessions/${initialSessionId ?? ''}`,
    enabled: needsDirectFetch,
  });

  const directData = directQuery.data;
  const directErrored = directQuery.isError;

  // The URL's session failed to resolve: drop the navigation intent so the
  // page's URL sync can fall back to the loaded session — or, on a cold
  // mount with nothing loaded, delete the dead param.
  const urlSessionFailed = urlSessionFromProps != null && fromUrlRow === undefined && directErrored;
  if (urlSessionFailed && pendingUrlSessionRef.current?.target === urlSessionFromProps) {
    pendingUrlSessionRef.current = null;
  }

  const currentSessionId = currentRun?.sessionId ?? null;

  useEffect(() => {
    if (!selectedFlow || !listedSessions) return;
    const agentKey = selectedFlow.systemRole ?? selectedFlow.agentId;
    const pendingTarget = pendingUrlSessionRef.current?.target;
    if (pendingTarget === null && currentSessionId !== null) {
      onUrlSessionAdoptedRef.current?.();
      setCurrentRun(null);
      return;
    }
    const fromUrl = initialSessionId
      ? listedSessions.find((r) => r.sessionId === initialSessionId)
      : undefined;
    // Deep link not in the recent window: wait for the direct fetch to
    // settle before deciding (a premature latest-run fallback would seed
    // the wrong session; on direct-fetch error we fall through, matching
    // the pre-query behavior).
    if (initialSessionId && !fromUrl && directData === undefined && !directErrored) return;
    const urlRow = fromUrl ?? (initialSessionId ? directData : undefined);
    if (urlRow && pendingTarget === urlRow.sessionId && currentSessionId !== urlRow.sessionId) {
      onUrlSessionAdoptedRef.current?.();
      setCurrentRun(urlRow);
      return;
    }
    const isFirstFetchForAgent = autoResumedForAgentRef.current !== agentKey;
    const seed =
      urlRow ?? (autoResumeLatest && isFirstFetchForAgent ? listedSessions[0] : undefined);
    autoResumedForAgentRef.current = agentKey;
    if (!seed) return;
    setCurrentRun((prev) => prev ?? seed);
  }, [
    selectedFlow,
    listedSessions,
    initialSessionId,
    directData,
    directErrored,
    autoResumeLatest,
    currentSessionId,
  ]);

  return {
    currentRun,
    setCurrentRun,
    recentRuns,
    /** True while a `?session=` navigation is waiting to be adopted. */
    urlSessionPending: pendingUrlSessionRef.current !== null,
    /** True when the URL's `?session=` is known-unresolvable (lookup errored). */
    urlSessionFailed,
  };
}
