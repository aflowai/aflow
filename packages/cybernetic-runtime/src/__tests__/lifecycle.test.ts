import { describe, it, expect } from 'vitest';
import {
  applyPartialSignalAnnotation,
  deriveLifecycleFromSignals,
  LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
  type LifecycleSignals,
} from '../lifecycle.js';

const STALE = LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS;

function signals(overrides: Partial<LifecycleSignals> = {}): LifecycleSignals {
  return {
    terminal: null,
    interruptRequested: false,
    awaitingUserInput: false,
    awaitingChild: false,
    paused: false,
    hasLiveWork: false,
    hasOnlyScheduledWork: false,
    schedulerStallAgeMs: 0,
    staleThresholdMs: STALE,
    partialSignalRead: false,
    ...overrides,
  };
}

describe('deriveLifecycleFromSignals — terminal short-circuit', () => {
  it.each(['cancelled', 'failed', 'completed'] as const)(
    'terminal=%s wins over every other flag',
    (terminal) => {
      const r = deriveLifecycleFromSignals(
        signals({
          terminal,
          interruptRequested: true,
          awaitingUserInput: true,
          awaitingChild: true,
          paused: true,
          hasLiveWork: true,
          schedulerStallAgeMs: STALE * 10,
        }),
      );
      expect(r.lifecycle).toBe(terminal);
      expect(r.reasonCode).toBeUndefined();
    },
  );
});

describe('deriveLifecycleFromSignals — interrupt precedence', () => {
  it('interruptRequested wins over executing/paused/awaiting', () => {
    const r = deriveLifecycleFromSignals(
      signals({
        interruptRequested: true,
        awaitingUserInput: true,
        paused: true,
        hasLiveWork: true,
      }),
    );
    expect(r.lifecycle).toBe('interrupting');
    expect(r.reasonCode).toBe('interrupt_requested');
  });

  it('terminal still wins over interruptRequested', () => {
    const r = deriveLifecycleFromSignals(
      signals({ terminal: 'cancelled', interruptRequested: true }),
    );
    expect(r.lifecycle).toBe('cancelled');
  });
});

describe('deriveLifecycleFromSignals — awaiting blocks', () => {
  it('awaitingUserInput outranks generic paused', () => {
    const r = deriveLifecycleFromSignals(signals({ awaitingUserInput: true, paused: true }));
    expect(r.lifecycle).toBe('awaiting_user');
    expect(r.reasonCode).toBe('awaiting_user_input');
  });

  it('awaitingChild outranks paused', () => {
    const r = deriveLifecycleFromSignals(signals({ awaitingChild: true, paused: true }));
    expect(r.lifecycle).toBe('awaiting_child');
    expect(r.reasonCode).toBe('awaiting_child_session');
  });

  it('awaitingUserInput outranks awaitingChild', () => {
    const r = deriveLifecycleFromSignals(signals({ awaitingUserInput: true, awaitingChild: true }));
    expect(r.lifecycle).toBe('awaiting_user');
  });
});

describe('deriveLifecycleFromSignals — paused / executing', () => {
  it('paused without other signals → paused', () => {
    const r = deriveLifecycleFromSignals(signals({ paused: true }));
    expect(r.lifecycle).toBe('paused');
    expect(r.reasonCode).toBe('paused');
  });

  it('hasLiveWork without staleness → executing (no reason code)', () => {
    const r = deriveLifecycleFromSignals(signals({ hasLiveWork: true }));
    expect(r.lifecycle).toBe('executing');
    expect(r.reasonCode).toBeUndefined();
  });

  it('hasLiveWork with only-scheduled + stale → stalled (reason: not_dispatched)', () => {
    const r = deriveLifecycleFromSignals(
      signals({
        hasLiveWork: true,
        hasOnlyScheduledWork: true,
        schedulerStallAgeMs: STALE + 1,
      }),
    );
    expect(r.lifecycle).toBe('stalled');
    expect(r.reasonCode).toBe('scheduled_task_not_dispatched');
  });

  it('hasLiveWork with only-scheduled but fresh cursor → executing', () => {
    const r = deriveLifecycleFromSignals(
      signals({
        hasLiveWork: true,
        hasOnlyScheduledWork: true,
        schedulerStallAgeMs: 1000,
      }),
    );
    expect(r.lifecycle).toBe('executing');
  });
});

describe('deriveLifecycleFromSignals — stall detection (idle scheduler)', () => {
  it('idle with stale cursor → stalled (reason: scheduler_stale)', () => {
    const r = deriveLifecycleFromSignals(signals({ schedulerStallAgeMs: STALE + 1 }));
    expect(r.lifecycle).toBe('stalled');
    expect(r.reasonCode).toBe('scheduler_stale');
  });

  it('idle with fresh cursor → unknown (telemetry path)', () => {
    const r = deriveLifecycleFromSignals(signals({ schedulerStallAgeMs: 100 }));
    expect(r.lifecycle).toBe('unknown');
  });
});

describe('applyPartialSignalAnnotation', () => {
  it('does nothing when partialSignalRead is false', () => {
    const r = applyPartialSignalAnnotation({ lifecycle: 'executing' }, false);
    expect(r).toEqual({ lifecycle: 'executing' });
  });

  it('promotes partial_signal_read into the empty reasonCode slot', () => {
    const r = applyPartialSignalAnnotation({ lifecycle: 'executing' }, true);
    expect(r.reasonCode).toBe('partial_signal_read');
  });

  it('preserves a primary reason code (interrupt wins; partial-read goes to freshnessReason elsewhere)', () => {
    const r = applyPartialSignalAnnotation(
      { lifecycle: 'interrupting', reasonCode: 'interrupt_requested' },
      true,
    );
    expect(r.reasonCode).toBe('interrupt_requested');
  });
});
