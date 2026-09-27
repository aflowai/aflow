'use client';

import type { SessionEvent } from '../lib/types.js';
import {
  getRealtimeClient,
  type LiveDeltaFrame,
  type TopicSubscriptionHandle,
} from '../lib/realtimeClient.js';

export type { LiveDeltaFrame };

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const TEARDOWN_GRACE_MS = 250;
const RING_BUFFER_CAP = 2000;
const DEV_STREAM_WARN_THRESHOLD = 3;

function getBackoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

export interface ConnectionStatus {
  isConnected: boolean;
  error: Error | null;
}

export interface BrokerContext {
  apiUrl: string;
  spaceId: string | null;
  /** Lazy getter so callers don't have to re-acquire when sessionExpired flips. */
  isSessionExpired: () => boolean;
}

export type EventCallback = (event: SessionEvent) => void;
export type LiveDeltaCallback = (frame: LiveDeltaFrame) => void;
export type StatusCallback = (status: ConnectionStatus) => void;

interface BrokerEntry {
  sessionId: string;
  context: BrokerContext;
  wsSubscription: TopicSubscriptionHandle | null;
  events: SessionEvent[];
  status: ConnectionStatus;
  lastEventId: string | null;
  skipCatchup: boolean;
  cursorReady: boolean;
  refCount: number;
  shouldReconnect: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  eventListeners: Set<EventCallback>;
  liveDeltaListeners: Set<LiveDeltaCallback>;
  statusListeners: Set<StatusCallback>;
}

const registry = new Map<string, BrokerEntry>();
let warnedThisTick = false;

function devCheckStreamCount(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  if (warnedThisTick) return;
  let open = 0;
  for (const entry of registry.values()) {
    if (entry.wsSubscription && entry.refCount > 0) open += 1;
  }
  if (open > DEV_STREAM_WARN_THRESHOLD) {
    warnedThisTick = true;
    queueMicrotask(() => {
      warnedThisTick = false;
    });
    const ids = Array.from(registry.keys()).slice(0, 8).join(', ');
    console.warn(
      `[session-events-broker] ${String(open)} open session.events subscriptions (threshold ${String(
        DEV_STREAM_WARN_THRESHOLD,
      )}). Active sessions: ${ids}`,
    );
  }
}

function setStatus(entry: BrokerEntry, partial: Partial<ConnectionStatus>): void {
  const next: ConnectionStatus = { ...entry.status, ...partial };
  if (next.isConnected === entry.status.isConnected && next.error === entry.status.error) return;
  entry.status = next;
  for (const listener of entry.statusListeners) {
    try {
      listener(next);
    } catch (err) {
      console.error('[session-events-broker] status listener threw:', err);
    }
  }
}

function appendEvent(entry: BrokerEntry, event: SessionEvent): void {
  const next =
    entry.events.length >= RING_BUFFER_CAP ? entry.events.slice(1) : entry.events.slice();
  next.push(event);
  entry.events = next;
  // The resume position comes from the server's cursor, never from the event.
  // An event id is not seekable, so setting it here would silently undo the
  // position the transport just handed us.
  for (const listener of entry.eventListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('[session-events-broker] event listener threw:', err);
    }
  }
}

/**
 * Fan a live frame out without touching `lastEventId`. The resume position may
 * only name a durable event: a live frame is a preview of the step in flight
 * and has no identity that survives it, so resuming from one would ask the
 * server for a position that was never written.
 */
function fanOutLiveDelta(entry: BrokerEntry, frame: LiveDeltaFrame): void {
  for (const listener of entry.liveDeltaListeners) {
    try {
      listener(frame);
    } catch (err) {
      console.error('[session-events-broker] live delta listener threw:', err);
    }
  }
}

function clearTimers(entry: BrokerEntry): void {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.teardownTimer) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
}

function teardown(entry: BrokerEntry): void {
  entry.shouldReconnect = false;
  clearTimers(entry);
  if (entry.wsSubscription) {
    try {
      entry.wsSubscription.unsubscribe();
    } catch {
      /* idempotent */
    }
    entry.wsSubscription = null;
  }
  entry.eventListeners.clear();
  entry.liveDeltaListeners.clear();
  entry.statusListeners.clear();
  registry.delete(entry.sessionId);
}

function connect(entry: BrokerEntry): void {
  if (entry.context.isSessionExpired()) {
    // A refusal is not a connection, and saying nothing here leaves the entry
    // claiming to be one: a handle from before the block, which now carries
    // nothing, and a flag saying a reconnect is still being pursued. `resume`
    // reads both and skips the entry, so the stream stays dead for the life of
    // the route. Clearing the flag also stops a pending backoff from spinning
    // against a session the server is refusing.
    entry.shouldReconnect = false;
    return;
  }

  if (entry.wsSubscription) {
    try {
      entry.wsSubscription.unsubscribe();
    } catch {
      /* idempotent */
    }
    entry.wsSubscription = null;
  }
  entry.shouldReconnect = true;
  const client = getRealtimeClient();
  const cursor = entry.lastEventId ?? undefined;
  const tenantId = (typeof process !== 'undefined' && process.env['NEXT_PUBLIC_TENANT_ID']) || '';
  const subscription = client.subscribe(
    {
      kind: 'session.events',
      tenantId,
      sessionId: entry.sessionId,
      ...(cursor ? { cursor } : {}),
      ...(entry.skipCatchup ? { skipCatchup: true } : {}),
    },
    {
      onEvent: (event, cursor) => {
        appendEvent(entry, event as SessionEvent);
        entry.lastEventId = cursor;
        entry.reconnectAttempt = 0;
        if (!entry.status.isConnected) {
          setStatus(entry, { isConnected: true, error: null });
        }
      },
      onLiveDelta: (frame) => {
        fanOutLiveDelta(entry, frame);
      },
      onSnapshot: () => {
        /* REST snapshot owns this path */
      },
      onReconcileRequired: (reason) => {
        // A reconcile means this position can no longer be resumed from — the
        // events behind it are gone, or the cursor was minted in a format this
        // server no longer speaks. Clearing it and reporting an error is not
        // enough on its own: the subscription has ended, so a tab that did only
        // that would sit silent for the rest of its life.
        //
        // Reconnecting without a cursor re-reads from the durable start once.
        // That is what makes a cursor-format change survivable for tabs already
        // open across the deploy, which is the whole migration story.
        console.warn(`[session-events] reconcile required (${reason}); resubscribing from start`);
        entry.lastEventId = null;
        setStatus(entry, {
          error: new Error(`Realtime reconcile required: ${reason}`),
        });
        if (!entry.shouldReconnect) return;
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = null;
          connect(entry);
        }, getBackoffMs(0));
      },
      onError: (code, message) => {
        console.warn(`[session-events] subscribe error ${code}: ${message}`);
        setStatus(entry, { error: new Error(`${code}: ${message}`) });
        if (!entry.shouldReconnect) return;
        const attempt = entry.reconnectAttempt;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          entry.shouldReconnect = false;
          return;
        }
        entry.reconnectAttempt = attempt + 1;
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = null;
          connect(entry);
        }, getBackoffMs(attempt));
      },
    },
  );
  const unsubscribeStatus = client.subscribeStatus((s) => {
    if (s.isConnected !== entry.status.isConnected) {
      setStatus(entry, { isConnected: s.isConnected, error: null });
    }
  });
  entry.wsSubscription = {
    // The session-events subscription carries no presence; the room's
    // presence topic is separate and owns its own heartbeat.
    updatePresence: () => undefined,
    unsubscribe: () => {
      try {
        subscription.unsubscribe();
      } finally {
        unsubscribeStatus();
      }
    },
  };
}

function getOrCreateEntry(sessionId: string, context: BrokerContext): BrokerEntry {
  const existing = registry.get(sessionId);
  if (existing) {
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
    }
    const prevSpaceId = existing.context.spaceId;
    existing.context = context;
    if (prevSpaceId !== context.spaceId && existing.wsSubscription) {
      existing.shouldReconnect = true;
      existing.reconnectAttempt = 0;
      try {
        existing.wsSubscription.unsubscribe();
      } catch {
        /* idempotent */
      }
      existing.wsSubscription = null;
      if (existing.cursorReady) {
        connect(existing);
      }
    }
    return existing;
  }
  const entry: BrokerEntry = {
    sessionId,
    context,
    wsSubscription: null,
    events: [],
    status: { isConnected: false, error: null },
    lastEventId: null,
    skipCatchup: false,
    cursorReady: false,
    refCount: 0,
    shouldReconnect: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    teardownTimer: null,
    eventListeners: new Set(),
    liveDeltaListeners: new Set(),
    statusListeners: new Set(),
  };
  registry.set(sessionId, entry);
  return entry;
}

// =============================================================================
// Public API
// =============================================================================

export interface AcquireOptions {
  initialCursor?: string | null;
  skipCatchup?: boolean;
  passive?: boolean;
}

/**
 * A positioned acquire that carried no cursor seeds the broker at the start of
 * retained history — a real position, but a provisional one: it is what a
 * consumer passes when it does not yet know where the snapshot ended. While no
 * event has been delivered, adopting a later real cursor costs nothing and
 * saves re-draining history the snapshot already covered.
 */
function hasProvisionalSeed(entry: BrokerEntry): boolean {
  return entry.cursorReady && entry.lastEventId === null && entry.events.length === 0;
}

export function acquire(sessionId: string, context: BrokerContext, opts?: AcquireOptions): void {
  const entry = getOrCreateEntry(sessionId, context);
  const passive = opts?.passive === true;
  const positioned = !passive;
  let reposition = false;

  if (positioned) {
    if (!entry.cursorReady) {
      if (opts?.initialCursor != null) entry.lastEventId = opts.initialCursor;
      if (opts?.skipCatchup === true) entry.skipCatchup = true;
      entry.cursorReady = true;
    } else if (opts?.initialCursor != null && hasProvisionalSeed(entry)) {
      entry.lastEventId = opts.initialCursor;
      if (opts.skipCatchup !== undefined) entry.skipCatchup = opts.skipCatchup;
      reposition = true;
    } else if (process.env['NODE_ENV'] !== 'production') {
      if (opts?.initialCursor != null && opts.initialCursor !== entry.lastEventId) {
        console.warn(
          `[session-events-broker] acquire(${sessionId}) passed initialCursor=${opts.initialCursor} ` +
            `but the broker is already seeded at ${String(entry.lastEventId)}. First acquire wins.`,
        );
      }
      if (opts?.skipCatchup !== undefined && opts.skipCatchup !== entry.skipCatchup) {
        console.warn(
          `[session-events-broker] acquire(${sessionId}) passed skipCatchup=${String(opts.skipCatchup)} ` +
            `but the broker is already seeded with skipCatchup=${String(entry.skipCatchup)}. First acquire wins.`,
        );
      }
    }
  }

  entry.refCount += 1;
  if (reposition) {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    entry.reconnectAttempt = 0;
    connect(entry);
    devCheckStreamCount();
    return;
  }
  const hasChannel = Boolean(entry.wsSubscription);
  if (entry.cursorReady && !hasChannel && !entry.reconnectTimer) {
    connect(entry);
    devCheckStreamCount();
  }
}

export function release(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
  entry.teardownTimer = setTimeout(() => {
    if (entry.refCount > 0) return;
    teardown(entry);
  }, TEARDOWN_GRACE_MS);
}

export function subscribe(
  sessionId: string,
  listener: EventCallback,
  opts?: { replayHistory?: boolean },
): () => void {
  const entry = registry.get(sessionId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[session-events-broker] subscribe(${sessionId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  entry.eventListeners.add(listener);
  if (opts?.replayHistory) {
    for (const event of entry.events) {
      try {
        listener(event);
      } catch (err) {
        console.error('[session-events-broker] event listener threw during replay:', err);
      }
    }
  }
  return () => {
    entry.eventListeners.delete(listener);
  };
}

/**
 * Subscribe to the in-flight step's live frames. Nothing is replayed: the
 * buffer is a value, so a subscriber that arrives mid-step is given the whole
 * partial by the server on its next frame rather than a history of increments.
 */
export function subscribeLiveDeltas(sessionId: string, listener: LiveDeltaCallback): () => void {
  const entry = registry.get(sessionId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(
        `[session-events-broker] subscribeLiveDeltas(${sessionId}) before acquire — no-op`,
      );
    }
    return () => undefined;
  }
  entry.liveDeltaListeners.add(listener);
  return () => {
    entry.liveDeltaListeners.delete(listener);
  };
}

export function subscribeStatus(sessionId: string, listener: StatusCallback): () => void {
  const entry = registry.get(sessionId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[session-events-broker] subscribeStatus(${sessionId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  entry.statusListeners.add(listener);
  try {
    listener(entry.status);
  } catch (err) {
    console.error('[session-events-broker] status listener threw on subscribe:', err);
  }
  return () => {
    entry.statusListeners.delete(listener);
  };
}

export function getEventsSnapshot(sessionId: string): SessionEvent[] {
  const entry = registry.get(sessionId);
  return entry?.events ?? [];
}

export function getStatusSnapshot(sessionId: string): ConnectionStatus {
  const entry = registry.get(sessionId);
  return entry?.status ?? { isConnected: false, error: null };
}

export function reconnect(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.events = [];
  entry.lastEventId = null;
  entry.reconnectAttempt = 0;
  setStatus(entry, { isConnected: false, error: null });
  connect(entry);
}

/**
 * Give every live entry a fresh connection attempt.
 *
 * A stream stops for two reasons that look identical from here: the tab slept
 * through the backoff and exhausted its attempts, or `connect` declined outright
 * because the session was blocked. Either way the entry is idle with nobody left
 * to wake it — `acquire` already ran, so no effect re-runs on its own. Healthy
 * entries are left alone.
 */
export function resume(): void {
  for (const entry of registry.values()) {
    if (entry.refCount <= 0) continue;
    // The same gate `acquire` applies. An entry held only by a passive consumer
    // has no durable replay position yet — `useSessionLiveDeltas` deliberately
    // declines to choose one — so connecting it here would start the stream from
    // a null cursor and replay history from the wrong place.
    if (!entry.cursorReady) continue;
    entry.reconnectAttempt = 0;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
      connect(entry);
      continue;
    }
    if (!entry.shouldReconnect || !entry.wsSubscription) {
      connect(entry);
    }
  }
}

export function __resetForTests(): void {
  for (const entry of registry.values()) {
    clearTimers(entry);
    if (entry.wsSubscription) {
      try {
        entry.wsSubscription.unsubscribe();
      } catch {
        /* idempotent */
      }
    }
  }
  registry.clear();
}
