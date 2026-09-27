'use client';

import type { EntityEventEnvelope } from '@aflow/schemas';
import { getRealtimeClient } from '../lib/realtimeClient.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const TEARDOWN_GRACE_MS = 250;
const RING_BUFFER_CAP = 1_000;
const DEV_STREAM_WARN_THRESHOLD = 3;

function getBackoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

export interface ConnectionStatus {
  isConnected: boolean;
  error: Error | null;
}

export interface BrokerContext {
  isSessionExpired: () => boolean;
}

export type EventCallback = (event: EntityEventEnvelope) => void;
export type SnapshotChangeCallback = (events: EntityEventEnvelope[]) => void;
export type StatusCallback = (status: ConnectionStatus) => void;
export type StreamErrorCallback = (message: string) => void;

interface ListenerSets {
  event: Set<EventCallback>;
  snapshotChange: Set<SnapshotChangeCallback>;
  status: Set<StatusCallback>;
  error: Set<StreamErrorCallback>;
}

interface BrokerEntry {
  spaceId: string;
  context: BrokerContext;
  wsHandle: { unsubscribe: () => void } | null;
  wsStatusUnsub: (() => void) | null;
  status: ConnectionStatus;
  events: EntityEventEnvelope[];
  /** Last Redis stream id from the gateway `event.cursor` (not `event.eventId`). */
  lastStreamCursor: string | null;
  refCount: number;
  shouldReconnect: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  listeners: ListenerSets;
}

const registry = new Map<string, BrokerEntry>();
let warnedThisTick = false;

function devCheckStreamCount(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  if (warnedThisTick) return;
  let open = 0;
  for (const entry of registry.values()) {
    if (entry.wsHandle && entry.refCount > 0) open += 1;
  }
  if (open > DEV_STREAM_WARN_THRESHOLD) {
    warnedThisTick = true;
    queueMicrotask(() => {
      warnedThisTick = false;
    });
    const ids = Array.from(registry.keys()).slice(0, 8).join(', ');
    console.warn(
      `[entity-events-broker] ${String(open)} open space.entity_events subscriptions (threshold ${String(
        DEV_STREAM_WARN_THRESHOLD,
      )}). Active spaces: ${ids}`,
    );
  }
}

function setStatus(entry: BrokerEntry, partial: Partial<ConnectionStatus>): void {
  const next: ConnectionStatus = { ...entry.status, ...partial };
  if (next.isConnected === entry.status.isConnected && next.error === entry.status.error) return;
  entry.status = next;
  for (const listener of entry.listeners.status) {
    try {
      listener(next);
    } catch (err) {
      console.error('[entity-events-broker] status listener threw:', err);
    }
  }
}

function fanout<T>(set: Set<(arg: T) => void>, arg: T, label: string): void {
  for (const listener of set) {
    try {
      listener(arg);
    } catch (err) {
      console.error(`[entity-events-broker] ${label} listener threw:`, err);
    }
  }
}

function appendEvent(entry: BrokerEntry, event: EntityEventEnvelope): void {
  const next =
    entry.events.length >= RING_BUFFER_CAP ? entry.events.slice(1) : entry.events.slice();
  next.push(event);
  entry.events = next;
  fanout(entry.listeners.event, event, 'event');
  fanout(entry.listeners.snapshotChange, entry.events, 'snapshotChange');
}

function scheduleReconnectWithBackoff(entry: BrokerEntry): void {
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
  if (entry.wsStatusUnsub) {
    entry.wsStatusUnsub();
    entry.wsStatusUnsub = null;
  }
  if (entry.wsHandle) {
    entry.wsHandle.unsubscribe();
    entry.wsHandle = null;
  }
  entry.listeners.event.clear();
  entry.listeners.snapshotChange.clear();
  entry.listeners.status.clear();
  entry.listeners.error.clear();
  registry.delete(entry.spaceId);
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
  if (entry.wsHandle) {
    entry.wsHandle.unsubscribe();
    entry.wsHandle = null;
  }
  if (entry.wsStatusUnsub) {
    entry.wsStatusUnsub();
    entry.wsStatusUnsub = null;
  }
  entry.shouldReconnect = true;

  const client = getRealtimeClient();
  setStatus(entry, { isConnected: client.getStatus().isConnected, error: null });
  entry.wsStatusUnsub = client.subscribeStatus((s) => {
    setStatus(entry, { isConnected: s.isConnected, error: s.lastError ?? null });
  });
  entry.wsHandle = client.subscribe(
    {
      kind: 'space.entity_events',
      spaceId: entry.spaceId,
      ...(entry.lastStreamCursor !== null ? { cursor: entry.lastStreamCursor } : {}),
    },
    {
      onEvent: (raw, streamCursor) => {
        const ev = raw as EntityEventEnvelope | null;
        if (!ev || typeof ev !== 'object' || typeof ev.eventId !== 'string') return;
        entry.reconnectAttempt = 0;
        appendEvent(entry, ev);
        entry.lastStreamCursor = streamCursor;
      },
      onError: (_code, message) => {
        fanout(entry.listeners.error, message, 'error');
        scheduleReconnectWithBackoff(entry);
      },
      onReconcileRequired: (reason) => {
        console.warn(`[entity-events-broker] reconcile_required: ${reason}`);
        // The server cleared its cursor — drop the local cursor so
        // the next connect starts from the live tail (matches the
        // session-events broker's reconcile path).
        entry.lastStreamCursor = null;
        scheduleReconnectWithBackoff(entry);
      },
    },
  );
}

function getOrCreateEntry(spaceId: string, context: BrokerContext): BrokerEntry {
  const existing = registry.get(spaceId);
  if (existing) {
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
    }
    existing.context = context;
    return existing;
  }
  const entry: BrokerEntry = {
    spaceId,
    context,
    wsHandle: null,
    wsStatusUnsub: null,
    status: { isConnected: false, error: null },
    events: [],
    lastStreamCursor: null,
    refCount: 0,
    shouldReconnect: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    teardownTimer: null,
    listeners: {
      event: new Set(),
      snapshotChange: new Set(),
      status: new Set(),
      error: new Set(),
    },
  };
  registry.set(spaceId, entry);
  return entry;
}

export function acquire(spaceId: string, context: BrokerContext): void {
  const entry = getOrCreateEntry(spaceId, context);
  entry.refCount += 1;
  if (!entry.wsHandle && !entry.reconnectTimer) {
    connect(entry);
    devCheckStreamCount();
  }
}

export function release(spaceId: string): void {
  const entry = registry.get(spaceId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
  entry.teardownTimer = setTimeout(() => {
    if (entry.refCount > 0) return;
    teardown(entry);
  }, TEARDOWN_GRACE_MS);
}

function subscribeImpl<T>(
  spaceId: string,
  set: (entry: BrokerEntry) => Set<T>,
  listener: T,
  label: string,
): () => void {
  const entry = registry.get(spaceId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[entity-events-broker] subscribe${label}(${spaceId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  set(entry).add(listener);
  return () => {
    set(entry).delete(listener);
  };
}

export function subscribe(spaceId: string, listener: EventCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.event, listener, 'Event');
}

export function subscribeSnapshotChange(
  spaceId: string,
  listener: SnapshotChangeCallback,
): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.snapshotChange, listener, 'SnapshotChange');
}

export function subscribeStatus(spaceId: string, listener: StatusCallback): () => void {
  const entry = registry.get(spaceId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[entity-events-broker] subscribeStatus(${spaceId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  entry.listeners.status.add(listener);
  try {
    listener(entry.status);
  } catch (err) {
    console.error('[entity-events-broker] status listener threw on subscribe:', err);
  }
  return () => {
    entry.listeners.status.delete(listener);
  };
}

export function subscribeStreamError(spaceId: string, listener: StreamErrorCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.error, listener, 'StreamError');
}

// Returned values are shared across subscribers — treat as immutable.
// Fresh references are produced on each append / status transition, so
// React equality checks work. Module-level stable fallbacks keep
// `useSyncExternalStore` from looping when called before `acquire` has
// registered the entry (the typical mount-before-effect-runs race).
const EMPTY_EVENTS: EntityEventEnvelope[] = [];
const EMPTY_STATUS: ConnectionStatus = { isConnected: false, error: null };

export function getEventsSnapshot(spaceId: string): EntityEventEnvelope[] {
  const entry = registry.get(spaceId);
  return entry?.events ?? EMPTY_EVENTS;
}

export function getStatusSnapshot(spaceId: string): ConnectionStatus {
  const entry = registry.get(spaceId);
  return entry?.status ?? EMPTY_STATUS;
}

/** Exposed for the React hook's null-spaceId / SSR fallback path. */
export const STATUS_FALLBACK: ConnectionStatus = EMPTY_STATUS;

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
    entry.reconnectAttempt = 0;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
      connect(entry);
      continue;
    }
    if (!entry.shouldReconnect || !entry.wsHandle) {
      connect(entry);
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
}

export function __resetForTests(): void {
  for (const entry of registry.values()) {
    clearTimers(entry);
    entry.wsStatusUnsub?.();
    entry.wsHandle?.unsubscribe();
  }
  registry.clear();
}
