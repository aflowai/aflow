import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquire,
  getEventsSnapshot,
  release,
  resume,
  subscribeLiveDeltas,
  __resetForTests,
  type BrokerContext,
  type LiveDeltaFrame,
} from './session-events-broker';

type EventHandler = (event: { eventId: string }, cursor: string) => void;
type LiveDeltaHandler = (frame: LiveDeltaFrame) => void;

interface CapturedSubscription {
  topic: Record<string, unknown>;
  onEvent: EventHandler;
  onLiveDelta: LiveDeltaHandler;
  onError?: (code: string, message: string) => void;
}

const captured: CapturedSubscription[] = [];
let transportConnected = true;

vi.mock('../lib/realtimeClient.js', () => ({
  getRealtimeClient: () => ({
    getStatus: () => ({
      isConnected: transportConnected,
      lastError: null,
      failedConnectAttempts: 0,
    }),
    subscribeStatus: (fn: (s: { isConnected: boolean }) => void) => {
      fn({ isConnected: transportConnected });
      return () => undefined;
    },
    subscribe: (
      topic: Record<string, unknown>,
      handlers: {
        onEvent: EventHandler;
        onLiveDelta: LiveDeltaHandler;
        onError?: (code: string, message: string) => void;
      },
    ) => {
      captured.push({
        topic,
        onEvent: handlers.onEvent,
        onLiveDelta: handlers.onLiveDelta,
        ...(handlers.onError ? { onError: handlers.onError } : {}),
      });
      return { unsubscribe: vi.fn() };
    },
  }),
}));

const ctx: BrokerContext = {
  apiUrl: 'http://api.test',
  spaceId: 'space-1',
  isSessionExpired: () => false,
};

beforeEach(() => {
  __resetForTests();
  captured.length = 0;
  transportConnected = true;
});

afterEach(() => {
  __resetForTests();
});

function lastTopic(): Record<string, unknown> | undefined {
  return captured[captured.length - 1]?.topic;
}

/** Deliver an event on the most recently opened channel. */
function emit(eventId: string): void {
  captured[captured.length - 1]?.onEvent({ eventId }, eventId);
}

/** Deliver a live frame on the most recently opened channel. */
function emitLive(delta: string, channel: LiveDeltaFrame['channel'] = 'text'): void {
  captured[captured.length - 1]?.onLiveDelta({
    stepExecutionId: 'step-exec-1',
    channel,
    offset: 0,
    delta,
  });
}

/** Force the broker to re-open the channel, exposing its resume cursor. */
function reopen(sessionId: string): void {
  acquire(sessionId, { ...ctx, spaceId: `${ctx.spaceId ?? ''}-moved` });
}

describe('acquire — initialCursor seeding (Phase 3)', () => {
  it('seeds cursor on session.events subscribe', () => {
    acquire('s1', ctx, { initialCursor: 'evt-abc' });
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-abc');
  });

  it('omits cursor when no initialCursor is given', () => {
    acquire('s2', ctx);
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBeUndefined();
  });

  it('null initialCursor behaves like omitted', () => {
    acquire('s3', ctx, { initialCursor: null });
    expect(lastTopic()?.['cursor']).toBeUndefined();
  });

  it('second acquire with same cursor: no dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s4', ctx, { initialCursor: 'evt-a' });
    acquire('s4', ctx, { initialCursor: 'evt-a' });
    expect(warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    warn.mockRestore();
  });

  it('second acquire with different cursor: dev warning, first wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s5', ctx, { initialCursor: 'evt-a' });
    acquire('s5', ctx, { initialCursor: 'evt-b' });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('First acquire wins');
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-a');
    warn.mockRestore();
  });

  it('second acquire with no cursor (sibling component): no warning, no churn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s6', ctx, { initialCursor: 'evt-a' });
    acquire('s6', ctx);
    expect(warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('acquire — skipCatchup seeding (Phase 6)', () => {
  it('passes skipCatchup: true on subscribe', () => {
    acquire('s-skip-1', ctx, { skipCatchup: true });
    expect(lastTopic()?.['skipCatchup']).toBe(true);
  });

  it('omits skipCatchup when default (false)', () => {
    acquire('s-skip-2', ctx);
    expect(lastTopic()?.['skipCatchup']).toBeUndefined();
  });

  it('omits skipCatchup when explicitly false', () => {
    acquire('s-skip-3', ctx, { skipCatchup: false });
    expect(lastTopic()?.['skipCatchup']).toBeUndefined();
  });

  it('combines cursor + skipCatchup (snapshot+tail typical case)', () => {
    acquire('s-skip-4', ctx, { initialCursor: 'evt-c', skipCatchup: true });
    expect(lastTopic()?.['cursor']).toBe('evt-c');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
  });

  it('second acquire with conflicting skipCatchup: warns, first wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-skip-5', ctx, { skipCatchup: true });
    acquire('s-skip-5', ctx, { skipCatchup: false });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('First acquire wins');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
    warn.mockRestore();
  });
});

describe('acquire — provisional seed upgrade', () => {
  it('adopts a real cursor after a cursor-less positioned acquire, and re-opens the channel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-1', ctx);
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBeUndefined();

    acquire('s-prov-1', ctx, { initialCursor: 'evt-after-snapshot', skipCatchup: true });
    expect(warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(2);
    expect(lastTopic()?.['cursor']).toBe('evt-after-snapshot');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
    warn.mockRestore();
  });

  it('explicit null seed is also provisional', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-2', ctx, { initialCursor: null });
    acquire('s-prov-2', ctx, { initialCursor: 'evt-real' });
    expect(warn).not.toHaveBeenCalled();
    expect(lastTopic()?.['cursor']).toBe('evt-real');
    warn.mockRestore();
  });

  it('a provisional seed keeps skipCatchup when the upgrade omits it', () => {
    acquire('s-prov-3', ctx, { skipCatchup: true });
    acquire('s-prov-3', ctx, { initialCursor: 'evt-real' });
    expect(lastTopic()?.['cursor']).toBe('evt-real');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
  });

  it('a real seed is NOT provisional — second cursor still warns and is discarded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-4', ctx, { initialCursor: 'evt-a' });
    acquire('s-prov-4', ctx, { initialCursor: 'evt-b' });
    expect(warn).toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-a');
    warn.mockRestore();
  });

  it('once an event has been delivered the seed is no longer provisional', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-5', ctx);
    emit('evt-live-1');
    acquire('s-prov-5', ctx, { initialCursor: 'evt-real' });
    expect(warn).toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    warn.mockRestore();
  });

  it('upgrades across a release/re-acquire inside the teardown grace window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-7', ctx);
    release('s-prov-7');
    acquire('s-prov-7', ctx, { initialCursor: 'evt-after-snapshot', skipCatchup: true });
    expect(warn).not.toHaveBeenCalled();
    expect(lastTopic()?.['cursor']).toBe('evt-after-snapshot');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
    warn.mockRestore();
  });

  it('upgrading twice does not churn — the second upgrade is a no-op reseed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-prov-6', ctx);
    acquire('s-prov-6', ctx, { initialCursor: 'evt-real' });
    acquire('s-prov-6', ctx, { initialCursor: 'evt-real' });
    expect(warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(2);
    warn.mockRestore();
  });
});

describe('live frames never advance the resume cursor', () => {
  it('reconnects from the last durable event, not the last live frame', () => {
    acquire('s-live-1', ctx, { initialCursor: 'evt-1' });
    emit('evt-2');
    emitLive('partial answer');
    emitLive(' continues');

    reopen('s-live-1');

    expect(captured).toHaveLength(2);
    expect(lastTopic()?.['cursor']).toBe('evt-2');
  });

  it('a live frame does not consume the provisional seed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquire('s-live-2', ctx);
    emitLive('partial answer');
    // Still provisional: the snapshot's real cursor is adopted without a warning.
    acquire('s-live-2', ctx, { initialCursor: 'evt-after-snapshot' });
    expect(warn).not.toHaveBeenCalled();
    expect(lastTopic()?.['cursor']).toBe('evt-after-snapshot');
    warn.mockRestore();
  });

  it('fans frames out to live listeners and keeps them out of the event buffer', () => {
    const frames: LiveDeltaFrame[] = [];
    acquire('s-live-3', ctx, { initialCursor: 'evt-1' });
    const unsubscribe = subscribeLiveDeltas('s-live-3', (frame) => frames.push(frame));

    emitLive('thinking about it', 'thinking');
    emitLive('answering');
    unsubscribe();
    emitLive('after unsubscribe');

    expect(frames.map((f) => [f.channel, f.delta])).toEqual([
      ['thinking', 'thinking about it'],
      ['text', 'answering'],
    ]);
    expect(getEventsSnapshot('s-live-3')).toHaveLength(0);
  });
});

describe('acquire — passive subscribers (Plan 154 follow-up)', () => {
  it('passive acquire alone does not open a subscription', () => {
    acquire('s-passive-1', ctx, { passive: true });
    expect(captured).toHaveLength(0);
  });

  it('passive-then-positioned: subscribe opens with the positioned cursor', () => {
    acquire('s-passive-2', ctx, { passive: true });
    expect(captured).toHaveLength(0);
    acquire('s-passive-2', ctx, { initialCursor: 'evt-after-snapshot', skipCatchup: true });
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-after-snapshot');
    expect(lastTopic()?.['skipCatchup']).toBe(true);
  });

  it('positioned-then-passive: passive does NOT trigger a second connect', () => {
    acquire('s-passive-3', ctx, { initialCursor: 'evt-a', skipCatchup: true });
    acquire('s-passive-3', ctx, { passive: true });
    expect(captured).toHaveLength(1);
  });
});

describe('resume — a stream refused while blocked', () => {
  it('connects a positioned entry once the session clears', () => {
    let blocked = true;
    acquire('s-resume-1', { ...ctx, isSessionExpired: () => blocked }, { initialCursor: 'evt-7' });
    expect(captured).toHaveLength(0);

    blocked = false;
    resume();
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-7');
  });

  it('leaves a passively-held entry alone — it has no replay position to use', () => {
    let blocked = true;
    acquire('s-resume-2', { ...ctx, isSessionExpired: () => blocked }, { passive: true });

    blocked = false;
    resume();
    expect(captured).toHaveLength(0);
  });

  it('connects that entry only once a positioned consumer seeds the cursor', () => {
    let blocked = true;
    const gated = { ...ctx, isSessionExpired: () => blocked };
    acquire('s-resume-3', gated, { passive: true });
    blocked = false;
    resume();
    expect(captured).toHaveLength(0);

    acquire('s-resume-3', gated, { initialCursor: 'evt-9', skipCatchup: true });
    expect(captured).toHaveLength(1);
    expect(lastTopic()?.['cursor']).toBe('evt-9');
  });

  it('stays closed if resume runs while still blocked', () => {
    acquire('s-resume-4', { ...ctx, isSessionExpired: () => true }, { initialCursor: 'evt-1' });
    resume();
    expect(captured).toHaveLength(0);
  });

  it('leaves a healthy stream alone', () => {
    acquire('s-resume-5', ctx, { initialCursor: 'evt-1' });
    expect(captured).toHaveLength(1);
    resume();
    expect(captured).toHaveLength(1);
  });
});

describe('resume — a retry that was refused while blocked', () => {
  /**
   * The path that looks recovered and is not: a stream that was connected, lost
   * the transport, and had its backoff reconnect fall inside the blocked window.
   * `connect` refuses before it would touch either field, so without clearing one
   * the entry keeps a subscription that no longer carries anything and a flag
   * saying it is still trying — and `resume` reads both and skips it.
   */
  it('reconnects a stream whose scheduled retry was refused', () => {
    vi.useFakeTimers();
    try {
      let blocked = false;
      acquire('s-refused', { ...ctx, isSessionExpired: () => blocked }, { initialCursor: 'evt-1' });
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
