/**
 * The client hands a topic listener the cursor the server acknowledged a
 * subscription with, on the first subscribe and on every resubscribe after the
 * socket drops — a listener that tracks its own resume point has nothing else
 * to learn it from until an event arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRealtimeClientForTests, getRealtimeClient } from './realtimeClient';

interface SentMessage {
  type: string;
  requestId?: string;
  topic?: Record<string, unknown>;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  readonly sent: SentMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;

  constructor() {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentMessage);
  }

  close(): void {
    this.onclose?.({ reason: '' });
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  open(): void {
    this.onopen?.();
    this.receive({ type: 'ready' });
  }

  lastSubscribe(): SentMessage {
    const subscribe = this.sent.filter((m) => m.type === 'subscribe').at(-1);
    if (!subscribe) throw new Error('no subscribe was sent on this socket');
    return subscribe;
  }
}

const sockets: FakeWebSocket[] = [];

async function socketNumber(n: number): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(sockets).toHaveLength(n));
  const socket = sockets[n - 1];
  if (!socket) throw new Error(`socket ${String(n)} never opened`);
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  vi.stubGlobal('window', {});
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'token', realtimeUrl: 'ws://realtime.test' }),
    })),
  );
  __resetRealtimeClientForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetRealtimeClientForTests();
});

describe('a subscription acknowledged by the server', () => {
  it('hands the listener the acknowledged cursor, then the one each resubscribe is acknowledged with', async () => {
    const onSubscribed = vi.fn();
    getRealtimeClient().subscribe(
      { kind: 'space.entity_events', spaceId: 'space-A' },
      { onSubscribed },
    );

    const first = await socketNumber(1);
    first.open();
    first.receive({
      type: 'subscribed',
      requestId: first.lastSubscribe().requestId,
      subscriptionId: 'sub-1',
      cursor: '1700000000000-0',
    });
    expect(onSubscribed).toHaveBeenLastCalledWith('1700000000000-0');

    first.close();
    await vi.runOnlyPendingTimersAsync();
    const second = await socketNumber(2);
    second.open();
    const resubscribe = second.lastSubscribe();
    expect(resubscribe.topic?.['cursor']).toBe('1700000000000-0');

    second.receive({
      type: 'subscribed',
      requestId: resubscribe.requestId,
      subscriptionId: 'sub-2',
      cursor: '1700000000001-0',
    });
    expect(onSubscribed).toHaveBeenCalledTimes(2);
    expect(onSubscribed).toHaveBeenLastCalledWith('1700000000001-0');
  });
});
