'use client';

import { useMemo } from 'react';
import { Column, Text } from '@aflow/design-system';
import type { ActiveSurfaceRunLifecycle } from '@aflow/schemas';
import { useSessionEvents } from '../hooks/use-session-events.js';
import { useApiBackwardQuery } from '../hooks/useApiQuery.js';
import { RunTimeline } from './run-timeline.js';
import { TruncatedHistoryEdge } from './truncated-history-edge.js';
import type { SessionEvent } from '../lib/types.js';

const TERMINAL_LIFECYCLES: ReadonlySet<ActiveSurfaceRunLifecycle> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const HISTORY_PAGE_SIZE = 1000;

interface Props {
  sessionId: string;
  /**
   * Optional lifecycle hint. When the session is in a terminal lifecycle, the
   * timeline fetches historical events via REST polling. When omitted (e.g.
   * the root session in the chat inspector), the live broker is used.
   */
  lifecycle?: ActiveSurfaceRunLifecycle | undefined;
}

export function CascadeSessionTimeline({
  sessionId,
  lifecycle,
  passive = false,
}: Props & { passive?: boolean }) {
  const isTerminal = lifecycle !== undefined && TERMINAL_LIFECYCLES.has(lifecycle);
  return isTerminal ? (
    <HistoricalTimeline sessionId={sessionId} />
  ) : (
    <LiveTimeline sessionId={sessionId} passive={passive} />
  );
}

function LiveTimeline({ sessionId, passive }: { sessionId: string; passive: boolean }) {
  // Passive when a positioned consumer (chat
  // `useRunReducer`) already drives the broker with the snapshot cursor.
  // Standalone use leaves `passive=false` so this timeline opens the
  // subscription itself.
  const { events: liveEvents, isConnected } = useSessionEvents(sessionId, { passive });

  // Seed historical events via polling when the live
  // broker only tails past the snapshot cursor, then layer the live tail
  // on top (deduped by eventId).
  const history = useApiBackwardQuery<SessionEvent>({
    key: ['session', sessionId, 'events', 'history'],
    path: (cursor) =>
      `/sessions/${sessionId}/events?limit=${String(HISTORY_PAGE_SIZE)}` +
      (cursor === undefined ? '' : `&before=${encodeURIComponent(cursor)}`),
  });
  // `null` while the first page is outstanding, so the merge below can tell
  // "history not loaded yet" from "session has no history".
  const historicalEvents = history.isPending ? null : history.items;

  const events = useMemo(() => {
    if (!historicalEvents) return liveEvents;
    if (liveEvents.length === 0) return historicalEvents;
    const seen = new Set<string>();
    const merged: SessionEvent[] = [];
    for (const e of historicalEvents) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      merged.push(e);
    }
    for (const e of liveEvents) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      merged.push(e);
    }
    return merged;
  }, [historicalEvents, liveEvents]);

  return (
    <Column gap="sm">
      {!isConnected && historicalEvents === null && (
        <Text size="xs" variant="muted">
          Connecting to session stream…
        </Text>
      )}
      <RunTimeline
        events={events}
        withTabs={false}
        loading={history.isPending}
        historyEdge={
          /* A live session is truncated by the same page as a finished one. */
          history.hasOlder ? (
            <TruncatedHistoryEdge
              onLoadOlder={() => void history.fetchNextPage()}
              loading={history.isFetchingNextPage}
            />
          ) : undefined
        }
      />
    </Column>
  );
}

function HistoricalTimeline({ sessionId }: { sessionId: string }) {
  const query = useApiBackwardQuery<SessionEvent>({
    key: ['session', sessionId, 'events', 'history'],
    path: (cursor) =>
      `/sessions/${sessionId}/events?limit=${String(HISTORY_PAGE_SIZE)}` +
      (cursor === undefined ? '' : `&before=${encodeURIComponent(cursor)}`),
  });

  if (query.error) {
    return (
      <Text size="xs" variant="muted">
        Failed to load events: {query.error.message}
      </Text>
    );
  }
  if (query.isPending) {
    return (
      <Text size="xs" variant="muted">
        Loading events…
      </Text>
    );
  }

  return (
    <RunTimeline
      events={query.items}
      withTabs={false}
      historyEdge={
        query.hasOlder ? (
          <TruncatedHistoryEdge
            onLoadOlder={() => void query.fetchNextPage()}
            loading={query.isFetchingNextPage}
          />
        ) : undefined
      }
    />
  );
}
