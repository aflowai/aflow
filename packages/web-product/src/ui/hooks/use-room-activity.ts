'use client';

import { useMemo } from 'react';
import type { PresenceParticipant } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/**
 * Who is in a set of rooms, and what each has said that this person has not read.
 *
 * Looking at a list is not reading it, so this leaves the read markers alone —
 * they move only in the room itself. That is what lets the same answer be shown
 * on every index at once without the news vanishing before anyone opened it.
 */
export function useRoomActivity(spaceId: string, sessionIds: string[]) {
  const key = useMemo(() => [...sessionIds].sort().join(','), [sessionIds]);

  const query = useApiQuery<{
    rooms: Record<string, PresenceParticipant[]>;
    unread: Record<string, number>;
  }>({
    key: ['space', spaceId, 'sessions', 'presence', key],
    path: `/sessions/presence?sessionIds=${encodeURIComponent(key)}`,
    spaceId,
    enabled: Boolean(spaceId) && key.length > 0,
    staleTime: 10_000,
  });

  return {
    presenceIn: (sessionId: string): PresenceParticipant[] => query.data?.rooms[sessionId] ?? [],
    unreadIn: (sessionId: string | null | undefined): number =>
      sessionId ? (query.data?.unread[sessionId] ?? 0) : 0,
  };
}

/** Past a point the exact number stops saying anything the word "many" would not. */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count);
}
