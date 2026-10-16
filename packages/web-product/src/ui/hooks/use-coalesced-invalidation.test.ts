/**
 * @vitest-environment jsdom
 */
/**
 * A burst of space events is one refetch per query, not one per event —
 * rendered through the two hooks that refresh on the space channel, with the
 * channel itself replaced by a hand that delivers events.
 */
import { randomUUID } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import type { EntityEventEnvelope } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const channel = vi.hoisted(() => ({
  handlers: new Set<(event: EntityEventEnvelope) => void>(),
}));

vi.mock('./use-space-entity-events.js', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useSpaceEntityEventListener: (
      spaceId: string | null,
      handler: (event: EntityEventEnvelope) => void,
    ) => {
      const handlerRef = useRef(handler);
      handlerRef.current = handler;
      useEffect(() => {
        if (!spaceId) return;
        const listener = (event: EntityEventEnvelope) => handlerRef.current(event);
        channel.handlers.add(listener);
        return () => {
          channel.handlers.delete(listener);
        };
      }, [spaceId]);
    },
  };
});

vi.mock('./useApiQuery.js', () => ({
  useApiQuery: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useApiMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { ENTITY_EVENT_REFETCH_WINDOW_MS } = await import('./use-coalesced-invalidation.js');
const { useSpaceWorkflowRuns, spaceWorkflowRunsKey } = await import('./use-space-workflow-runs.js');
const { useSessionMetadataRefresh } = await import('./use-session-metadata.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE_ID = '00000000-0000-0000-0000-0000000000a1';
const BURST = 100;

function Workbench(): null {
  useSpaceWorkflowRuns(SPACE_ID);
  useSessionMetadataRefresh(SPACE_ID);
  return null;
}

function event(eventType: string, extra: Partial<EntityEventEnvelope> = {}): EntityEventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    spaceId: SPACE_ID,
    tenantId: '00000000-0000-0000-0000-000000000001',
    timestamp: Date.now(),
    payload: {},
    ...extra,
  } as EntityEventEnvelope;
}

function deliver(events: EntityEventEnvelope[]): void {
  for (const e of events) for (const handler of channel.handlers) handler(e);
}

let container: HTMLDivElement;
let root: Root;
let invalidated: QueryKey[];

beforeEach(async () => {
  vi.useFakeTimers();
  invalidated = [];
  const queryClient = new QueryClient();
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
    if (filters?.queryKey) invalidated.push(filters.queryKey);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Workbench)),
    );
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  channel.handlers.clear();
  vi.useRealTimers();
});

function invalidationsOf(key: QueryKey): number {
  const wanted = JSON.stringify(key);
  return invalidated.filter((k) => JSON.stringify(k) === wanted).length;
}

describe('refreshing on the space channel', () => {
  it('refetches the active runs once for a hundred run events in one tick', async () => {
    deliver(Array.from({ length: BURST }, () => event('entity.run.updated')));
    expect(invalidated).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTITY_EVENT_REFETCH_WINDOW_MS);
    });

    expect(invalidationsOf(spaceWorkflowRunsKey(SPACE_ID))).toBe(1);
  });

  it('refetches the conversation list once for a hundred described conversations in one tick', async () => {
    deliver(Array.from({ length: BURST }, () => event('entity.session.described')));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTITY_EVENT_REFETCH_WINDOW_MS);
    });

    expect(invalidationsOf(['space', SPACE_ID, 'sessions'])).toBe(1);
    expect(invalidationsOf(spaceWorkflowRunsKey(SPACE_ID))).toBe(0);
  });

  it('still refreshes each skill a burst touched, once each', async () => {
    deliver([
      ...Array.from({ length: BURST }, () => event('entity.run.updated', { workflowSlug: 'a' })),
      event('entity.run.updated', { workflowSlug: 'b' }),
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTITY_EVENT_REFETCH_WINDOW_MS);
    });

    expect(invalidationsOf(spaceWorkflowRunsKey(SPACE_ID))).toBe(1);
    expect(invalidationsOf(['space', SPACE_ID, 'workflow', 'a', 'runs'])).toBe(1);
    expect(invalidationsOf(['space', SPACE_ID, 'workflow', 'b', 'runs'])).toBe(1);
  });

  it('refetches again for an event after the burst has been answered', async () => {
    deliver([event('entity.run.updated')]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTITY_EVENT_REFETCH_WINDOW_MS);
    });
    deliver([event('entity.run.updated')]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTITY_EVENT_REFETCH_WINDOW_MS);
    });

    expect(invalidationsOf(spaceWorkflowRunsKey(SPACE_ID))).toBe(2);
  });
});
