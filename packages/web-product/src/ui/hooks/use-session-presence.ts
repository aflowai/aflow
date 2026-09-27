'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PRESENCE_HEARTBEAT_SECONDS,
  PresenceRosterSchema,
  type PresenceActivity,
  type PresenceParticipant,
} from '@aflow/schemas';
import { getRealtimeClient } from '../lib/realtimeClient.js';
import type { TopicSubscriptionHandle } from '../lib/realtimeClient.js';

/** How long after the last keystroke someone stops counting as typing. */
const TYPING_IDLE_MS = 4_000;

export interface SessionPresence {
  participants: PresenceParticipant[];
  /** Report a keystroke. Typing decays on its own; there is nothing to clear. */
  reportTyping: () => void;
}

/**
 * Who else is in this room.
 *
 * Presence is a claim about the present moment, so it is never cached or
 * persisted: the roster arrives from the server, is replaced wholesale on
 * each change, and empties when the subscription ends.
 */
export function useSessionPresence(sessionId: string | null): SessionPresence {
  const [participants, setParticipants] = useState<PresenceParticipant[]>([]);
  const subscriptionRef = useRef<TopicSubscriptionHandle | null>(null);
  const activityRef = useRef<PresenceActivity>('viewing');
  const typingUntilRef = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setParticipants([]);
      return;
    }

    const subscription = getRealtimeClient().subscribe(
      { kind: 'session.presence', sessionId },
      {
        onSnapshot: (data) => {
          const parsed = PresenceRosterSchema.safeParse(data);
          if (parsed.success) setParticipants(parsed.data.participants);
        },
        onError: (code, message) => {
          // A room you may read but whose presence is unavailable should show
          // no roster rather than a stale one.
          setParticipants([]);
          if (code !== 'subscribe_denied') {
            console.warn(`[session-presence] ${code}: ${message}`);
          }
        },
      },
    );
    subscriptionRef.current = subscription;

    // The heartbeat is what keeps the entry alive; it also carries whether
    // this tab is still typing, so typing decays without a second timer.
    const heartbeat = setInterval(() => {
      const stillTyping = Date.now() < typingUntilRef.current;
      const next: PresenceActivity = stillTyping ? 'typing' : 'viewing';
      activityRef.current = next;
      subscription.updatePresence(next);
    }, PRESENCE_HEARTBEAT_SECONDS * 1000);

    return () => {
      clearInterval(heartbeat);
      subscriptionRef.current = null;
      subscription.unsubscribe();
      setParticipants([]);
    };
  }, [sessionId]);

  const reportTyping = useCallback(() => {
    typingUntilRef.current = Date.now() + TYPING_IDLE_MS;
    // Announce the transition immediately; staying typing is the heartbeat's
    // job, so a fast typist sends one message, not one per keystroke.
    if (activityRef.current !== 'typing') {
      activityRef.current = 'typing';
      subscriptionRef.current?.updatePresence('typing');
    }
  }, []);

  return { participants, reportTyping };
}
