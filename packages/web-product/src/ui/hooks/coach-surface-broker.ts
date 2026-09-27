'use client';

import type {
  ActiveSurfaceCoach,
  ActiveSurfaceHelmsman,
  ActiveSurfaceRun,
  ActiveSurfaceTransition,
  CoachAnomalySummary,
  CoachSurfaceDelta,
  CoachSurfaceSnapshot,
} from '@aflow/schemas';
import { CoachSurfaceDeltaSchema, CoachSurfaceSnapshotSchema } from '@aflow/schemas';
import { getRealtimeClient } from '../lib/realtimeClient.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const TEARDOWN_GRACE_MS = 250;
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
  headers: () => Record<string, string>;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  isSessionExpired: () => boolean;
}

export type SnapshotCallback = (snapshot: CoachSurfaceSnapshot) => void;
export type LifecycleCallback = (coach: ActiveSurfaceCoach) => void;
export type AnomalyAddedCallback = (anomaly: CoachAnomalySummary) => void;
export type AnomalyResolvedCallback = (anomalyId: string) => void;
export type SurfacedRunsCallback = (runs: ActiveSurfaceRun[]) => void;
export type HelmsmanCallback = (helmsman: ActiveSurfaceHelmsman) => void;
export type TransitionsCallback = (transitions: ActiveSurfaceTransition[]) => void;
export type StatusCallback = (status: ConnectionStatus) => void;
export type StreamErrorCallback = (message: string) => void;
export type ReconcileRequiredCallback = (reason: string) => void;

interface ListenerSets {
  snapshot: Set<SnapshotCallback>;
  lifecycle: Set<LifecycleCallback>;
  anomalyAdded: Set<AnomalyAddedCallback>;
  anomalyResolved: Set<AnomalyResolvedCallback>;
  surfacedRuns: Set<SurfacedRunsCallback>;
  helmsman: Set<HelmsmanCallback>;
  transitions: Set<TransitionsCallback>;
  status: Set<StatusCallback>;
  error: Set<StreamErrorCallback>;
  reconcile: Set<ReconcileRequiredCallback>;
}

interface BrokerEntry {
  spaceId: string;
  context: BrokerContext;
  wsHandle: { unsubscribe: () => void } | null;
  wsStatusUnsub: (() => void) | null;
  status: ConnectionStatus;
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
      `[coach-surface-broker] ${String(open)} open space.coach_surface subscriptions (threshold ${String(
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
      console.error('[coach-surface-broker] status listener threw:', err);
    }
  }
}

function fanout<T>(set: Set<(arg: T) => void>, arg: T, label: string): void {
  for (const listener of set) {
    try {
      listener(arg);
    } catch (err) {
      console.error(`[coach-surface-broker] ${label} listener threw:`, err);
    }
  }
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
  entry.listeners.snapshot.clear();
  entry.listeners.lifecycle.clear();
  entry.listeners.anomalyAdded.clear();
  entry.listeners.anomalyResolved.clear();
  entry.listeners.surfacedRuns.clear();
  entry.listeners.helmsman.clear();
  entry.listeners.transitions.clear();
  entry.listeners.status.clear();
  entry.listeners.error.clear();
  entry.listeners.reconcile.clear();
  registry.delete(entry.spaceId);
}

function dispatchDelta(entry: BrokerEntry, delta: CoachSurfaceDelta): void {
  switch (delta.kind) {
    case 'lifecycle':
      fanout(entry.listeners.lifecycle, delta.coach, 'lifecycle');
      break;
    case 'anomaly_added':
      fanout(entry.listeners.anomalyAdded, delta.anomaly, 'anomalyAdded');
      break;
    case 'anomaly_resolved':
      fanout(entry.listeners.anomalyResolved, delta.anomalyId, 'anomalyResolved');
      break;
    case 'surfaced_runs':
      fanout(entry.listeners.surfacedRuns, delta.surfacedRuns, 'surfacedRuns');
      break;
    case 'helmsman':
      fanout(entry.listeners.helmsman, delta.helmsman, 'helmsman');
      break;
    case 'transitions':
      fanout(entry.listeners.transitions, delta.recentTransitions, 'transitions');
      break;
  }
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
    { kind: 'space.coach_surface', spaceId: entry.spaceId },
    {
      onSnapshot: (data) => {
        // The realtime envelope ships `data: unknown`; the gateway
        // does not parse per-topic payload shapes. Parse here so a
        // malformed snapshot can't poison the TanStack cache or
        // crash listeners that assume `coach.lifecycle` exists.
        const parsed = CoachSurfaceSnapshotSchema.safeParse(data);
        if (!parsed.success) {
          console.warn('[coach-surface] dropped malformed snapshot:', parsed.error.message);
          return;
        }
        entry.reconnectAttempt = 0;
        fanout(entry.listeners.snapshot, parsed.data, 'snapshot');
      },
      onEvent: (raw) => {
        const parsed = CoachSurfaceDeltaSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn('[coach-surface] dropped malformed delta:', parsed.error.message);
          return;
        }
        entry.reconnectAttempt = 0;
        dispatchDelta(entry, parsed.data);
      },
      onError: (_code, message) => {
        fanout(entry.listeners.error, message, 'error');
        scheduleReconnectWithBackoff(entry);
      },
      onReconcileRequired: (reason) => {
        console.warn(`[coach-surface] reconcile_required: ${reason}`);
        fanout(entry.listeners.reconcile, reason, 'reconcile');
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
    refCount: 0,
    shouldReconnect: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    teardownTimer: null,
    listeners: {
      snapshot: new Set(),
      lifecycle: new Set(),
      anomalyAdded: new Set(),
      anomalyResolved: new Set(),
      surfacedRuns: new Set(),
      helmsman: new Set(),
      transitions: new Set(),
      status: new Set(),
      error: new Set(),
      reconcile: new Set(),
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
      console.warn(`[coach-surface-broker] subscribe${label}(${spaceId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  set(entry).add(listener);
  return () => {
    set(entry).delete(listener);
  };
}

export function subscribeSnapshot(spaceId: string, listener: SnapshotCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.snapshot, listener, 'Snapshot');
}

export function subscribeLifecycle(spaceId: string, listener: LifecycleCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.lifecycle, listener, 'Lifecycle');
}

export function subscribeAnomalyAdded(spaceId: string, listener: AnomalyAddedCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.anomalyAdded, listener, 'AnomalyAdded');
}

export function subscribeAnomalyResolved(
  spaceId: string,
  listener: AnomalyResolvedCallback,
): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.anomalyResolved, listener, 'AnomalyResolved');
}

export function subscribeSurfacedRuns(spaceId: string, listener: SurfacedRunsCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.surfacedRuns, listener, 'SurfacedRuns');
}

export function subscribeHelmsman(spaceId: string, listener: HelmsmanCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.helmsman, listener, 'Helmsman');
}

export function subscribeTransitions(spaceId: string, listener: TransitionsCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.transitions, listener, 'Transitions');
}

export function subscribeStreamError(spaceId: string, listener: StreamErrorCallback): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.error, listener, 'StreamError');
}

export function subscribeReconcileRequired(
  spaceId: string,
  listener: ReconcileRequiredCallback,
): () => void {
  return subscribeImpl(spaceId, (e) => e.listeners.reconcile, listener, 'ReconcileRequired');
}

export function subscribeStatus(spaceId: string, listener: StatusCallback): () => void {
  const entry = registry.get(spaceId);
  if (!entry) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[coach-surface-broker] subscribeStatus(${spaceId}) before acquire — no-op`);
    }
    return () => undefined;
  }
  entry.listeners.status.add(listener);
  try {
    listener(entry.status);
  } catch (err) {
    console.error('[coach-surface-broker] status listener threw on subscribe:', err);
  }
  return () => {
    entry.listeners.status.delete(listener);
  };
}

export function getStatusSnapshot(spaceId: string): ConnectionStatus {
  const entry = registry.get(spaceId);
  return entry?.status ?? { isConnected: false, error: null };
}

export function reconnect(spaceId: string): void {
  const entry = registry.get(spaceId);
  if (!entry) return;
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

export function __resetForTests(): void {
  for (const entry of registry.values()) {
    clearTimers(entry);
    entry.wsStatusUnsub?.();
    entry.wsHandle?.unsubscribe();
  }
  registry.clear();
}
