import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetForTests,
  acquire,
  getStatusSnapshot,
  release,
  resume,
  subscribeAnomalyAdded,
  subscribeAnomalyResolved,
  subscribeHelmsman,
  subscribeLifecycle,
  subscribeReconcileRequired,
  subscribeSnapshot,
  subscribeStatus,
  subscribeSurfacedRuns,
  subscribeTransitions,
  type BrokerContext,
} from './coach-surface-broker';
import type {
  ActiveSurfaceCoach,
  ActiveSurfaceHelmsman,
  ActiveSurfaceRun,
  ActiveSurfaceTransition,
  CoachAnomalySummary,
  CoachSurfaceSnapshot,
} from '@aflow/schemas';

interface CapturedSubscription {
  topic: Record<string, unknown>;
  listeners: {
    onSnapshot?: (data: unknown) => void;
    onEvent?: (raw: unknown) => void;
    onError?: (code: string, message: string) => void;
    onReconcileRequired?: (reason: string) => void;
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

const sampleCoach: ActiveSurfaceCoach = {
  lifecycle: 'reviewing',
  coachSessionId: '00000000-0000-0000-0000-000000000001',
  pendingProposals: 1,
  pendingPlatformIssues: 0,
  pendingAnomalies: 2,
};

const sampleHelmsman: ActiveSurfaceHelmsman = {
  sessionId: null,
  lifecycle: 'executing',
  mode: null,
  triggerSource: null,
  lastInteractionAt: null,
};

const sampleAnomaly: CoachAnomalySummary = {
  id: '00000000-0000-0000-0000-0000000000a1',
  kind: 'repeated_failure',
  severity: 'warning',
  summary: 'sample',
  reportedAt: '2026-06-04T00:00:00.000Z',
  acknowledged: false,
  coachSessionId: '00000000-0000-0000-0000-000000000001',
};

const sampleRun: ActiveSurfaceRun = {
  runId: '00000000-0000-0000-0000-000000000010',
  sessionId: null,
  skillId: null,
  skillName: null,
  workflowSlug: 'demo',
  lifecycle: 'executing',
  startedAt: '2026-06-04T00:00:00.000Z',
  endedAt: null,
  graphFidelity: 'full',
  tasks: [],
};

const sampleTransition: ActiveSurfaceTransition = {
  at: '2026-06-04T00:00:00.000Z',
  kind: 'mode',
  label: 'autonomous',
};

const sampleSnapshot: CoachSurfaceSnapshot = {
  coach: sampleCoach,
  anomalies: [sampleAnomaly],
  helmsman: sampleHelmsman,
  surfacedRuns: [sampleRun],
  recentTransitions: [sampleTransition],
};

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
    expect(lastSub()?.topic['kind']).toBe('space.coach_surface');
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
  it('onSnapshot → fires snapshot listeners with the full CoachSurfaceSnapshot', () => {
    acquire('space-A', ctx);
    const seen: CoachSurfaceSnapshot[] = [];
    subscribeSnapshot('space-A', (snap) => seen.push(snap));

    lastSub()?.listeners.onSnapshot?.(sampleSnapshot);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.coach.lifecycle).toBe('reviewing');
    expect(seen[0]?.anomalies).toHaveLength(1);
  });

  it('lifecycle delta fires lifecycle listeners with the full coach object', () => {
    acquire('space-A', ctx);
    const seen: ActiveSurfaceCoach[] = [];
    subscribeLifecycle('space-A', (c) => seen.push(c));

    lastSub()?.listeners.onEvent?.({ kind: 'lifecycle', coach: sampleCoach });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pendingAnomalies).toBe(2);
  });

  it('anomaly_added fires anomalyAdded listeners with the anomaly', () => {
    acquire('space-A', ctx);
    const seen: CoachAnomalySummary[] = [];
    subscribeAnomalyAdded('space-A', (a) => seen.push(a));

    lastSub()?.listeners.onEvent?.({ kind: 'anomaly_added', anomaly: sampleAnomaly });
    expect(seen[0]?.id).toBe(sampleAnomaly.id);
  });

  it('anomaly_resolved fires anomalyResolved listeners with the id', () => {
    acquire('space-A', ctx);
    const seen: string[] = [];
    subscribeAnomalyResolved('space-A', (id) => seen.push(id));

    const id = '00000000-0000-0000-0000-0000000000a9';
    lastSub()?.listeners.onEvent?.({ kind: 'anomaly_resolved', anomalyId: id });
    expect(seen).toEqual([id]);
  });

  it('surfaced_runs fires surfacedRuns listeners with the new array', () => {
    acquire('space-A', ctx);
    const seen: ActiveSurfaceRun[][] = [];
    subscribeSurfacedRuns('space-A', (runs) => seen.push(runs));

    lastSub()?.listeners.onEvent?.({ kind: 'surfaced_runs', surfacedRuns: [sampleRun] });
    expect(seen[0]).toHaveLength(1);
  });

  it('helmsman fires helmsman listeners with the new helmsman summary', () => {
    acquire('space-A', ctx);
    const seen: ActiveSurfaceHelmsman[] = [];
    subscribeHelmsman('space-A', (h) => seen.push(h));

    lastSub()?.listeners.onEvent?.({ kind: 'helmsman', helmsman: sampleHelmsman });
    expect(seen[0]?.lifecycle).toBe('executing');
  });

  it('transitions fires transitions listeners with the new array', () => {
    acquire('space-A', ctx);
    const seen: ActiveSurfaceTransition[][] = [];
    subscribeTransitions('space-A', (t) => seen.push(t));

    lastSub()?.listeners.onEvent?.({
      kind: 'transitions',
      recentTransitions: [sampleTransition],
    });
    expect(seen[0]).toHaveLength(1);
  });

  it('N subscribers each receive every event', () => {
    acquire('space-A', ctx);
    const got: number[] = [];
    subscribeSnapshot('space-A', () => got.push(1));
    subscribeSnapshot('space-A', () => got.push(2));
    subscribeSnapshot('space-A', () => got.push(3));

    lastSub()?.listeners.onSnapshot?.(sampleSnapshot);
    expect(got.sort()).toEqual([1, 2, 3]);
  });

  it('unknown delta kind is silently ignored', () => {
    acquire('space-A', ctx);
    const lifecycle: ActiveSurfaceCoach[] = [];
    subscribeLifecycle('space-A', (c) => lifecycle.push(c));
    lastSub()?.listeners.onEvent?.({ kind: 'unknown', payload: {} });
    expect(lifecycle).toHaveLength(0);
  });
});

describe('subscribeReconcileRequired (Plan 174 review P2)', () => {
  it('fires when the transport signals reconcile_required', () => {
    acquire('space-A', ctx);
    const seen: string[] = [];
    subscribeReconcileRequired('space-A', (reason) => seen.push(reason));
    lastSub()?.listeners.onReconcileRequired?.('snapshot_failed');
    expect(seen).toEqual(['snapshot_failed']);
  });

  it('fires for every subscriber on the same space', () => {
    acquire('space-A', ctx);
    const a: string[] = [];
    const b: string[] = [];
    subscribeReconcileRequired('space-A', (r) => a.push(r));
    subscribeReconcileRequired('space-A', (r) => b.push(r));
    lastSub()?.listeners.onReconcileRequired?.('cursor_invalid');
    expect(a).toEqual(['cursor_invalid']);
    expect(b).toEqual(['cursor_invalid']);
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
    const unsub = subscribeSnapshot('never-acquired', () => undefined);
    expect(warn).toHaveBeenCalled();
    expect(() => unsub()).not.toThrow();
    warn.mockRestore();
  });
});

describe('resume — a Coach stream refused while blocked', () => {
  it('opens no subscription while the session is blocked', () => {
    acquire('space-A', { ...ctx, isSessionExpired: () => true });
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
});

describe('resume — a retry that was refused while blocked', () => {
  /**
   * The path that looks recovered and is not: a stream that was connected, lost
   * the transport, and had its backoff reconnect fall inside the blocked window.
   * `connect` refuses before it touches either field, so the entry keeps a handle
   * that no longer carries anything and a flag saying it is still trying.
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
