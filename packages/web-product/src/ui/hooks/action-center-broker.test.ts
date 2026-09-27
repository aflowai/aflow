import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetForTests,
  acquire,
  getStatusSnapshot,
  release,
  subscribeFocus,
  subscribeItemsUpdate,
  subscribeResolve,
  subscribeSnapshot,
  subscribeStatus,
  resume,
  type BrokerContext,
} from './action-center-broker';
import type { ActionCenterFocusEvent, ActionCenterItem } from './use-action-center-types';

interface CapturedSubscription {
  topic: Record<string, unknown>;
  listeners: {
    onSnapshot?: (data: unknown) => void;
    onEvent?: (raw: unknown) => void;
    onError?: (code: string, message: string) => void;
  };
}

const captured: CapturedSubscription[] = [];
const statusListeners: Array<(s: { isConnected: boolean; lastError: Error | null }) => void> = [];
let transportConnected = false;

vi.mock('../lib/realtimeClient.js', () => ({
  getRealtimeClient: () => ({
    getStatus: () => ({
      isConnected: transportConnected,
      lastError: null,
      failedConnectAttempts: 0,
    }),
    subscribeStatus: (fn: (s: { isConnected: boolean; lastError: Error | null }) => void) => {
      statusListeners.push(fn);
      fn({ isConnected: transportConnected, lastError: null });
      return () => undefined;
    },
    subscribe: (topic: Record<string, unknown>, listeners: CapturedSubscription['listeners']) => {
      captured.push({ topic, listeners });
      return { unsubscribe: vi.fn() };
    },
  }),
}));

const ctx: BrokerContext = {
  apiUrl: 'http://api.test',
  headers: () => ({ 'X-Tenant-ID': 't' }),
  authFetch: vi.fn(),
  isSessionExpired: () => false,
};

function makeItem(overrides: Partial<ActionCenterItem> = {}): ActionCenterItem {
  return {
    id: 'item-1',
    spaceId: 'space-A',
    kind: 'human_input',
    origin: {
      type: 'step',
      runId: 'r1',
      stepExecutionId: 'sx1',
      sessionId: 'sess1',
      pauseVersion: 1,
      operationId: 'op',
    },
    title: 'Pick a model',
    summary: '',
    requestedAt: '2026-05-23T10:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'helmsman' },
    priority: 'normal',
    relatesTo: [],
    allowedActions: ['submit'],
    audience: 'anyone',
    status: 'open',
    ...overrides,
  };
}

function lastSub(): CapturedSubscription | undefined {
  return captured[captured.length - 1];
}

beforeEach(() => {
  captured.length = 0;
  statusListeners.length = 0;
  transportConnected = false;
});

afterEach(() => {
  __resetForTests();
});

describe('acquire / release — one subscription per spaceId', () => {
  it('N concurrent acquires open exactly one subscribe', () => {
    acquire('space-A', ctx);
    acquire('space-A', ctx);
    acquire('space-A', ctx);
    expect(captured).toHaveLength(1);
    expect(lastSub()?.topic['kind']).toBe('space.action_center');
    expect(lastSub()?.topic['spaceId']).toBe('space-A');
  });

  it('different spaceIds open separate subscribes', () => {
    acquire('space-A', ctx);
    acquire('space-B', ctx);
    expect(captured).toHaveLength(2);
  });

  it('release below zero is harmless', () => {
    acquire('space-A', ctx);
    release('space-A');
    expect(() => release('space-A')).not.toThrow();
  });

  it('release after teardown grace clears the subscription', async () => {
    acquire('space-A', ctx);
    release('space-A');
    await new Promise((r) => setTimeout(r, 320));
    acquire('space-A', ctx);
    expect(captured).toHaveLength(2);
  });
});

describe('event fanout', () => {
  it('onSnapshot → fires snapshot listeners with items[]', () => {
    acquire('space-A', ctx);
    const snapshotCalls: ActionCenterItem[][] = [];
    subscribeSnapshot('space-A', (items) => snapshotCalls.push(items));

    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    lastSub()?.listeners.onSnapshot?.({ items });

    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toHaveLength(2);
  });

  it('insert and update events share the items-update listeners', () => {
    acquire('space-A', ctx);
    const updates: ActionCenterItem[][] = [];
    subscribeItemsUpdate('space-A', (items) => updates.push(items));

    lastSub()?.listeners.onEvent?.({ kind: 'insert', items: [makeItem({ id: 'a' })] });
    lastSub()?.listeners.onEvent?.({
      kind: 'update',
      items: [makeItem({ id: 'a', title: 'edited' })],
    });

    expect(updates).toHaveLength(2);
    expect(updates[1]?.[0]?.title).toBe('edited');
  });

  it('resolve event → fires resolve listeners with itemIds[]', () => {
    acquire('space-A', ctx);
    const resolveCalls: string[][] = [];
    subscribeResolve('space-A', (ids) => resolveCalls.push(ids));

    lastSub()?.listeners.onEvent?.({ kind: 'resolve', itemIds: ['a', 'b'] });

    expect(resolveCalls[0]).toEqual(['a', 'b']);
  });

  it('focus event → fires focus listeners', () => {
    acquire('space-A', ctx);
    const focusCalls: ActionCenterFocusEvent[] = [];
    subscribeFocus('space-A', (focus) => focusCalls.push(focus));

    lastSub()?.listeners.onEvent?.({
      kind: 'focus',
      message: { itemId: 'item-x', spaceId: 'space-A' },
    });

    expect(focusCalls[0]?.itemId).toBe('item-x');
  });

  it('N subscribers each receive every event', () => {
    acquire('space-A', ctx);
    const got: number[] = [];
    subscribeSnapshot('space-A', () => got.push(1));
    subscribeSnapshot('space-A', () => got.push(2));
    subscribeSnapshot('space-A', () => got.push(3));

    lastSub()?.listeners.onSnapshot?.({ items: [] });
    expect(got.sort()).toEqual([1, 2, 3]);
  });
});

describe('subscribeStatus', () => {
  it('fires the current status synchronously on subscribe', () => {
    acquire('space-A', ctx);
    const seen: boolean[] = [];
    subscribeStatus('space-A', (s) => seen.push(s.isConnected));
    expect(seen).toEqual([false]);
  });

  it('fires false → true when transport connects', () => {
    acquire('space-A', ctx);
    const seen: boolean[] = [];
    subscribeStatus('space-A', (s) => seen.push(s.isConnected));
    transportConnected = true;
    for (const fn of statusListeners) {
      fn({ isConnected: true, lastError: null });
    }
    expect(seen).toContain(true);
    expect(getStatusSnapshot('space-A').isConnected).toBe(true);
  });
});

describe('getStatusSnapshot', () => {
  it('returns disconnected for unknown space', () => {
    expect(getStatusSnapshot('never-acquired')).toEqual({ isConnected: false, error: null });
  });
});

describe('subscribe before acquire', () => {
  it('emits a dev warning and returns a no-op unsubscribe', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsub = subscribeSnapshot('never-acquired', () => {});
    expect(warn).toHaveBeenCalled();
    expect(() => unsub()).not.toThrow();
    warn.mockRestore();
  });
});

describe('resume — a stream refused while blocked', () => {
  it('opens no subscription while the session is blocked', () => {
    let blocked = true;
    acquire('space-A', { ...ctx, isSessionExpired: () => blocked });
    expect(captured).toHaveLength(0);
  });

  it('connects on resume once the session clears', () => {
    let blocked = true;
    acquire('space-A', { ...ctx, isSessionExpired: () => blocked });
    expect(captured).toHaveLength(0);

    blocked = false;
    resume();
    expect(captured).toHaveLength(1);
    expect(lastSub()?.topic['spaceId']).toBe('space-A');
  });

  it('stays closed if resume runs while still blocked', () => {
    acquire('space-A', { ...ctx, isSessionExpired: () => true });
    resume();
    expect(captured).toHaveLength(0);
  });

  it('leaves a healthy stream alone', () => {
    acquire('space-A', ctx);
    expect(captured).toHaveLength(1);
    resume();
    expect(captured).toHaveLength(1);
  });

  it('reconnects every live space, not just one', () => {
    let blocked = true;
    const gated = { ...ctx, isSessionExpired: () => blocked };
    acquire('space-A', gated);
    acquire('space-B', gated);
    expect(captured).toHaveLength(0);

    blocked = false;
    resume();
    expect(captured).toHaveLength(2);
  });

  it('skips a space nobody is holding any more', async () => {
    let blocked = true;
    acquire('space-A', { ...ctx, isSessionExpired: () => blocked });
    release('space-A');
    await new Promise((r) => setTimeout(r, 320));

    blocked = false;
    resume();
    expect(captured).toHaveLength(0);
  });
});

describe('resume — a retry that was refused while blocked', () => {
  /**
   * The path that looks recovered and is not: a stream that was connected, lost
   * the transport, and had its backoff reconnect fall inside the blocked window.
   * `connect` refuses before it would touch either field, so without clearing one
   * the entry keeps a handle that no longer carries anything and a flag saying it
   * is still trying — and `resume` reads both and skips it.
   */
  it('reconnects a stream whose scheduled retry was refused', () => {
    vi.useFakeTimers();
    try {
      let blocked = false;
      acquire('space-A', { ...ctx, isSessionExpired: () => blocked });
      expect(captured).toHaveLength(1);

      lastSub()?.listeners.onError?.('stream_error', 'transport lost');

      blocked = true;
      vi.advanceTimersByTime(5_000);
      expect(captured, 'a refused retry must not open a subscription').toHaveLength(1);

      blocked = false;
      resume();
      expect(captured, 'the stream stayed dead after the session recovered').toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
