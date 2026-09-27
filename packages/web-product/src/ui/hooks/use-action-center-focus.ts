'use client';

import { useEffect, useRef } from 'react';
import { useApi } from '../components/providers.js';
import * as broker from './action-center-broker.js';
import { useResumeOnUnblock } from './use-resume-on-unblock.js';
import type { ActionCenterFocusEvent } from './use-action-center-types.js';

export type ActionCenterFocusMessage = ActionCenterFocusEvent;
export type ActionCenterFocusListener = (msg: ActionCenterFocusMessage) => void;

export function useActionCenterFocus(
  spaceId: string | null,
  onFocus: ActionCenterFocusListener | undefined,
): void {
  const api = useApi();
  // Hold the listener + api in refs so callers can pass fresh objects
  // every render without forcing an acquire/release on the broker. The
  // broker is keyed by spaceId; remount-on-callback-change would
  // unnecessarily ref-count down→up and burn the teardown grace.
  const listenerRef = useRef<ActionCenterFocusListener | undefined>(onFocus);
  const apiRef = useRef(api);
  useEffect(() => {
    listenerRef.current = onFocus;
  }, [onFocus]);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  useResumeOnUnblock(broker.resume);

  useEffect(() => {
    if (!spaceId || !listenerRef.current) return;

    const ctx: broker.BrokerContext = {
      apiUrl: apiRef.current.apiUrl,
      headers: () => apiRef.current.headers(),
      authFetch: (input, init) => apiRef.current.authFetch(input, init),
      isSessionExpired: () => apiRef.current.blockedSession !== null,
    };

    broker.acquire(spaceId, ctx);
    const unsubscribe = broker.subscribeFocus(spaceId, (evt) => {
      listenerRef.current?.(evt);
    });

    return () => {
      unsubscribe();
      broker.release(spaceId);
    };
  }, [spaceId]);
}
