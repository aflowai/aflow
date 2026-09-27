'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../components/providers.js';
import type { SessionEvent } from '../lib/types.js';
import {
  acquire,
  release,
  subscribe,
  subscribeLiveDeltas,
  subscribeStatus,
  getEventsSnapshot,
  getStatusSnapshot,
  reconnect as brokerReconnect,
  resume as brokerResume,
  type AcquireOptions,
  type BrokerContext,
  type ConnectionStatus,
  type LiveDeltaFrame,
} from './session-events-broker';
import { useResumeOnUnblock } from './use-resume-on-unblock';

interface UseSessionEventsReturn {
  events: SessionEvent[];
  isConnected: boolean;
  error: Error | null;
  reconnect: () => void;
}

export function useSessionEvents(
  sessionId: string | null,
  opts?: AcquireOptions,
): UseSessionEventsReturn {
  const { apiUrl, spaceId, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>({ isConnected: false, error: null });

  // Keep `sessionExpired` in a ref so the broker context closure doesn't go
  // stale and we don't re-acquire the broker every time the flag flips.
  const sessionExpiredRef = useRef(sessionExpired);
  sessionExpiredRef.current = sessionExpired;
  useResumeOnUnblock(brokerResume);

  const initialCursorRef = useRef(opts?.initialCursor ?? null);
  initialCursorRef.current = opts?.initialCursor ?? null;
  const skipCatchupRef = useRef(opts?.skipCatchup ?? false);
  skipCatchupRef.current = opts?.skipCatchup ?? false;
  const passiveRef = useRef(opts?.passive ?? false);
  passiveRef.current = opts?.passive ?? false;

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setStatus({ isConnected: false, error: null });
      return;
    }
    const ctx: BrokerContext = {
      apiUrl,
      spaceId,
      isSessionExpired: () => sessionExpiredRef.current,
    };
    acquire(sessionId, ctx, {
      initialCursor: initialCursorRef.current,
      skipCatchup: skipCatchupRef.current,
      passive: passiveRef.current,
    });
    setEvents(getEventsSnapshot(sessionId));
    setStatus(getStatusSnapshot(sessionId));

    const unsubEvents = subscribe(sessionId, () => {
      setEvents(getEventsSnapshot(sessionId));
    });
    const unsubStatus = subscribeStatus(sessionId, (s) => {
      setStatus(s);
    });

    return () => {
      unsubEvents();
      unsubStatus();
      release(sessionId);
    };
  }, [sessionId, apiUrl, spaceId]);

  const reconnect = useCallback(() => {
    if (!sessionId) return;
    brokerReconnect(sessionId);
  }, [sessionId]);

  return { events, isConnected: status.isConnected, error: status.error, reconnect };
}

/**
 * Subscribe to the in-flight step's live frames for a session.
 *
 * Acquires the broker passively — a live frame carries no cursor, so this hook
 * has no position to seed and must never become the acquire that decides where
 * the durable tail resumes from.
 *
 * The handler is read via ref, so it can change without resubscribing.
 */
export function useSessionLiveDeltas(
  sessionId: string | null,
  handler: (frame: LiveDeltaFrame) => void,
): void {
  const { apiUrl, spaceId, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const sessionExpiredRef = useRef(sessionExpired);
  sessionExpiredRef.current = sessionExpired;
  useResumeOnUnblock(brokerResume);

  useEffect(() => {
    if (!sessionId) return;
    const ctx: BrokerContext = {
      apiUrl,
      spaceId,
      isSessionExpired: () => sessionExpiredRef.current,
    };
    acquire(sessionId, ctx, { passive: true });
    const unsubscribe = subscribeLiveDeltas(sessionId, (frame) => {
      handlerRef.current(frame);
    });
    return () => {
      unsubscribe();
      release(sessionId);
    };
  }, [sessionId, apiUrl, spaceId]);
}

interface UseSessionEventListenerReturn {
  isConnected: boolean;
  error: Error | null;
  reconnect: () => void;
}

/**
 * Subscribe to a session's events incrementally. The broker fires `handler`
 * once per arriving event. With `replayHistory: true`, handler is also fired
 * synchronously for each event currently in the broker's buffer at subscribe
 * time — useful for reducers that need to backfill state on late mount.
 *
 * The handler is read via ref, so it can change without resubscribing.
 */
export function useSessionEventListener(
  sessionId: string | null,
  handler: (event: SessionEvent) => void,
  opts?: {
    replayHistory?: boolean;
    initialCursor?: string | null;
    skipCatchup?: boolean;
    passive?: boolean;
  },
): UseSessionEventListenerReturn {
  const { apiUrl, spaceId, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const [status, setStatus] = useState<ConnectionStatus>({ isConnected: false, error: null });

  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const sessionExpiredRef = useRef(sessionExpired);
  sessionExpiredRef.current = sessionExpired;
  useResumeOnUnblock(brokerResume);
  const replayHistory = opts?.replayHistory ?? false;
  const initialCursorRef = useRef(opts?.initialCursor ?? null);
  initialCursorRef.current = opts?.initialCursor ?? null;
  const skipCatchupRef = useRef(opts?.skipCatchup ?? false);
  skipCatchupRef.current = opts?.skipCatchup ?? false;
  const passiveRef = useRef(opts?.passive ?? false);
  passiveRef.current = opts?.passive ?? false;

  useEffect(() => {
    if (!sessionId) {
      setStatus({ isConnected: false, error: null });
      return;
    }
    const ctx: BrokerContext = {
      apiUrl,
      spaceId,
      isSessionExpired: () => sessionExpiredRef.current,
    };
    acquire(sessionId, ctx, {
      initialCursor: initialCursorRef.current,
      skipCatchup: skipCatchupRef.current,
      passive: passiveRef.current,
    });
    setStatus(getStatusSnapshot(sessionId));

    const unsubEvents = subscribe(
      sessionId,
      (event) => {
        handlerRef.current(event);
      },
      { replayHistory },
    );
    const unsubStatus = subscribeStatus(sessionId, (s) => {
      setStatus(s);
    });

    return () => {
      unsubEvents();
      unsubStatus();
      release(sessionId);
    };
  }, [sessionId, apiUrl, spaceId, replayHistory]);

  const reconnect = useCallback(() => {
    if (!sessionId) return;
    brokerReconnect(sessionId);
  }, [sessionId]);

  return { isConnected: status.isConnected, error: status.error, reconnect };
}
