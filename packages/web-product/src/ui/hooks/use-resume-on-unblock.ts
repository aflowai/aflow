'use client';

/**
 * Run a broker's resume when the session stops being blocked.
 *
 * Each hook hands its broker a lazy `isSessionExpired` so the refusal to connect
 * always reads the current value — but nothing re-runs `connect` once that value
 * changes back. `acquire` is keyed on the id, not on the flag, so a session that
 * recovers leaves every stream idle until the route unmounts.
 *
 * Only the blocked-to-clear transition counts. Firing on mount would reconnect a
 * stream `acquire` had just established.
 */
'use client';

import { useApi } from '../components/providers.js';
import { useEffect, useRef } from 'react';

export function useResumeOnUnblock(resume: () => void): void {
  const { blockedSession } = useApi();
  const blocked = blockedSession !== null;
  const wasBlocked = useRef(blocked);
  const resumeRef = useRef(resume);
  resumeRef.current = resume;

  useEffect(() => {
    if (wasBlocked.current && !blocked) resumeRef.current();
    wasBlocked.current = blocked;
  }, [blocked]);
}
