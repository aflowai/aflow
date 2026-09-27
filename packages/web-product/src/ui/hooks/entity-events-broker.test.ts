/**
 * The entity broker's recovery, which had no test of its own.
 *
 * A green suite on a sibling broker says nothing here: each one names its own
 * handle field and its own reconnect condition, so the shared shape of `resume()`
 * is exactly the kind of thing that regresses in one copy while the others stay
 * passing. This broker also reaches `resume()` from two directions — a tab
 * returning to visibility and a session that stopped being blocked — and only one
 * of them existed before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetForTests,
  acquire,
  release,
  resume,
  type BrokerContext,
} from './entity-events-broker';

interface CapturedSubscription {
  topic: Record<string, unknown>;
  onEvent?: (raw: unknown, cursor: string) => void;
  onError?: (code: string, message: string) => void;
}

const captured: CapturedSubscription[] = [];
let transportConnected = false;

vi.mock('../lib/realtimeClient.js', () => ({
  getRealtimeClient: () => ({
    getStatus: () => ({ isConnected: transportConnected, lastError: null }),
    subscribeStatus: (fn: (s: { isConnected: boolean; lastError: Error | null }) => void) => {
      fn({ isConnected: transportConnected, lastError: null });
      return () => undefined;
    },
    subscribe: (
      topic: Record<string, unknown>,
      handlers: {
        onEvent?: (raw: unknown, cursor: string) => void;
        onError?: (code: string, message: string) => void;
      },
    ) => {
      captured.push({
        topic,
        ...(handlers.onEvent ? { onEvent: handlers.onEvent } : {}),
        ...(handlers.onError ? { onError: handlers.onError } : {}),
      });
      return { unsubscribe: () => undefined };
    },
  }),
}));

const live: BrokerContext = { isSessionExpired: () => false };

function gated(blocked: () => boolean): BrokerContext {
  return { isSessionExpired: blocked };
}

beforeEach(() => {
  captured.length = 0;
  transportConnected = false;
});

afterEach(() => {
  __resetForTests();
});

describe('resume — a stream refused while blocked', () => {
  it('opens no subscription while the session is blocked', () => {
    acquire(
      'space-A',
      gated(() => true),
    );
    expect(captured).toHaveLength(0);
  });

  it('connects on resume once the session clears', () => {
    let blocked = true;
    acquire(
      'space-A',
      gated(() => blocked),
    );
    expect(captured).toHaveLength(0);

    blocked = false;
    resume();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.topic['spaceId']).toBe('space-A');
  });

  it('stays closed if resume runs while still blocked', () => {
    acquire(
      'space-A',
      gated(() => true),
    );
    resume();
    expect(captured).toHaveLength(0);
  });

  it('leaves a healthy stream alone', () => {
    acquire('space-A', live);
    expect(captured).toHaveLength(1);
    resume();
    expect(captured).toHaveLength(1);
  });

  it('reconnects every live space, not just one', () => {
    let blocked = true;
    const ctx = gated(() => blocked);
    acquire('space-A', ctx);
    acquire('space-B', ctx);
    expect(captured).toHaveLength(0);

    blocked = false;
    resume();
    expect(captured).toHaveLength(2);
  });

  it('skips a space nobody is holding any more', async () => {
    let blocked = true;
    acquire(
      'space-A',
      gated(() => blocked),
    );
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
      acquire(
        'space-A',
        gated(() => blocked),
      );
      expect(captured).toHaveLength(1);

      captured[0]?.onError?.('stream_error', 'transport lost');

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
