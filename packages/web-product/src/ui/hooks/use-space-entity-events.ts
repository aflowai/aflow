'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { EntityEventEnvelope } from '@aflow/schemas';
import { useApi } from '../components/providers.js';
import * as broker from './entity-events-broker.js';
import { useResumeOnUnblock } from './use-resume-on-unblock.js';

const EMPTY: EntityEventEnvelope[] = [];

export interface UseSpaceEntityEventsResult {
  events: EntityEventEnvelope[];
  isConnected: boolean;
}

export function useSpaceEntityEvents(spaceId: string | null): UseSpaceEntityEventsResult {
  const { blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const sessionExpiredRef = useRef(sessionExpired);
  sessionExpiredRef.current = sessionExpired;
  useResumeOnUnblock(broker.resume);

  const brokerContext = useCallback(
    (): broker.BrokerContext => ({
      isSessionExpired: () => sessionExpiredRef.current,
    }),
    [],
  );

  const subscribeEvents = useCallback(
    (notify: () => void) => {
      if (!spaceId) return () => undefined;
      broker.acquire(spaceId, brokerContext());
      const unsub = broker.subscribeSnapshotChange(spaceId, notify);
      return () => {
        unsub();
        broker.release(spaceId);
      };
    },
    [spaceId, brokerContext],
  );

  const subscribeStatus = useCallback(
    (notify: () => void) => {
      if (!spaceId) return () => undefined;
      broker.acquire(spaceId, brokerContext());
      const unsub = broker.subscribeStatus(spaceId, notify);
      return () => {
        unsub();
        broker.release(spaceId);
      };
    },
    [spaceId, brokerContext],
  );

  const events = useSyncExternalStore(
    subscribeEvents,
    () => (spaceId ? broker.getEventsSnapshot(spaceId) : EMPTY),
    () => EMPTY,
  );

  const status = useSyncExternalStore(
    subscribeStatus,
    () => (spaceId ? broker.getStatusSnapshot(spaceId) : broker.STATUS_FALLBACK),
    () => broker.STATUS_FALLBACK,
  );

  return { events, isConnected: status.isConnected };
}

/**
 * Fire `handler` once per arriving entity event. Prefer this over scanning
 * `useSpaceEntityEvents().events` for side effects: the snapshot array can
 * advance by several events per render (catch-up drains, pump batches), so
 * last-element checks silently drop events. The handler is read via ref, so
 * it can change without resubscribing.
 */
export function useSpaceEntityEventListener(
  spaceId: string | null,
  handler: (event: EntityEventEnvelope) => void,
): void {
  const { blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const sessionExpiredRef = useRef(sessionExpired);
  sessionExpiredRef.current = sessionExpired;
  useResumeOnUnblock(broker.resume);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!spaceId) return;
    broker.acquire(spaceId, { isSessionExpired: () => sessionExpiredRef.current });
    const unsub = broker.subscribe(spaceId, (event) => {
      handlerRef.current(event);
    });
    return () => {
      unsub();
      broker.release(spaceId);
    };
  }, [spaceId]);
}
