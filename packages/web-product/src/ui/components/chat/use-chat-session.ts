'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { SESSION_LIST_LIMIT, sessionListKey } from '../../lib/session-list-query.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import type { Flow, Session, SessionSeed } from '../../lib/types.js';
import { pickLandingConversation } from '../../lib/chat-landing.js';

export function useChatSessionRuns(
  selectedFlow: Flow | null,
  spaceId: string,
  initialSessionId?: string | null,
  opts?: {
    /**
     * Land on the reader's last conversation when the URL names none (Plan 338
     * D4), by `pickLandingConversation` over the list this hook already reads.
     * It applies once per mount, to the first agent the chat selects. The page
     * passes it only for a bare arrival (`isBareChatArrival`), and a session
     * the URL names later still ends it. A list that fails to read lands on a
     * new chat. Omitted, the chat always lands new.
     */
    landing?: {
      /** The reader. Only a conversation they opened is resumed. */
      readerId: string | null;
      /** The reader's read has settled, so `readerId: null` means nobody, not "not yet". */
      readerSettled: boolean;
    };
    /**
     * Called when a `?session=` URL change is adopted over the loaded
     * session — the page clears conversation state that belonged to the
     * previous session.
     */
    onUrlSessionAdopted?: () => void;
  },
) {
  const landingOn = opts?.landing !== undefined;
  const readerId = opts?.landing?.readerId ?? null;
  const readerSettled = opts?.landing?.readerSettled ?? false;
  const [currentRun, setCurrentRun] = useState<SessionSeed | null>(null);
  // The landing decides once per mount, and only for a mount whose URL named
  // no session. State, not a ref, because the page holds its empty-chat
  // states back until it has decided.
  const [arrivedWithoutSession] = useState(initialSessionId == null);
  const [landingSpent, setLandingSpent] = useState(false);
  const landingLive = landingOn && arrivedWithoutSession && !landingSpent;
  const onUrlSessionAdoptedRef = useRef(opts?.onUrlSessionAdopted);
  onUrlSessionAdoptedRef.current = opts?.onUrlSessionAdopted;
  // Agent slug the first list has been seen for. Cleared when the
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

  // A list that failed to read has nothing to land on, so the chat lands new
  // rather than hold its greeting and the Workbench back for ever.
  const listErrored = selectedFlow !== null && listQuery.isError;
  useEffect(() => {
    if (landingLive && listErrored) setLandingSpent(true);
  }, [landingLive, listErrored]);

  useEffect(() => {
    if (!selectedFlow || !listedSessions) return;
    // A URL that names a session, now or on a later navigation, ends the
    // landing: New chat after it must stay new.
    if (landingLive && initialSessionId) setLandingSpent(true);
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
    let seed: SessionSeed | undefined = urlRow;
    if (!seed && isFirstFetchForAgent && landingLive && !initialSessionId) {
      // Without the reader nothing can be called theirs, so wait for the read.
      if (!readerSettled) return;
      seed = pickLandingConversation(listedSessions, readerId, Date.now()) ?? undefined;
    }
    autoResumedForAgentRef.current = agentKey;
    if (landingLive) setLandingSpent(true);
    if (!seed) return;
    const resumed = seed;
    setCurrentRun((prev) => prev ?? resumed);
  }, [
    selectedFlow,
    listedSessions,
    initialSessionId,
    directData,
    directErrored,
    readerId,
    readerSettled,
    landingLive,
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
    /** True until the landing has chosen between the last conversation and a new chat. */
    landingPending: landingLive,
  };
}
