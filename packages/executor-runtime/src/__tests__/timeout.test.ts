import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError, InterruptedError, isPhoenixTimeoutAbort } from '../timeout.js';

describe('withTimeout', () => {
  it('returns success when fn completes within timeout', async () => {
    const result = await withTimeout(async () => 42, 1000);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(42);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns timeout failure when fn exceeds timeout', async () => {
    const result = await withTimeout(async (signal) => {
      // Simulate a long-running operation that respects abort
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(_resolve, 5000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    }, 50);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('timeout');
      expect(result.error).toBeInstanceOf(TimeoutError);
    }
  });

  it('re-throws non-abort errors from fn', async () => {
    await expect(
      withTimeout(async () => {
        throw new Error('business logic error');
      }, 1000),
    ).rejects.toThrow('business logic error');
  });

  // ── External signal tests ──────────────────────────────────────────────

  it('returns interrupted failure when external signal is aborted', async () => {
    const external = new AbortController();

    const resultPromise = withTimeout(
      async (signal) => {
        // Simulate a long-running operation that respects abort
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      5000, // Long timeout — external abort should fire first
      { externalSignal: external.signal },
    );

    // Abort externally after a brief delay
    setTimeout(() => external.abort(), 50);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('interrupted');
      expect(result.error).toBeInstanceOf(InterruptedError);
    }
  });

  it('external abort takes priority over timeout when both fire', async () => {
    const external = new AbortController();
    // Pre-abort the external signal before calling withTimeout
    external.abort();

    const result = await withTimeout(
      async (signal) => {
        // Signal is already aborted — throw immediately
        if (signal.aborted) throw new Error('aborted');
        return 'unreachable';
      },
      5000,
      { externalSignal: external.signal },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('interrupted');
    }
  });

  it('passes composite signal to fn that aborts on either timeout or external', async () => {
    const external = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const result = await withTimeout(
      async (signal) => {
        receivedSignal = signal;
        return 'ok';
      },
      1000,
      { externalSignal: external.signal },
    );

    expect(result.success).toBe(true);
    // The signal should have been provided to the handler
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('works normally without external signal (backward compat)', async () => {
    const result = await withTimeout(async () => 'ok', 1000);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe('ok');
    }
  });
});

describe('isPhoenixTimeoutAbort', () => {
  it('detects the platform-timeout marker on the composite signal passed to fn', async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await withTimeout(async (signal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }, 30);

    expect(result.success).toBe(false);
    expect(receivedSignal).toBeDefined();
    expect(isPhoenixTimeoutAbort(receivedSignal)).toBe(true);
    const reason = receivedSignal!.reason as { marker?: string; timeoutMs?: number };
    expect(reason.marker).toBe('phoenix.executor.timeout');
    expect(reason.timeoutMs).toBe(30);
  });

  it('returns false for an external abort (no platform marker)', async () => {
    const external = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const resultPromise = withTimeout(
      async (signal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      5000,
      { externalSignal: external.signal },
    );
    setTimeout(() => external.abort(), 20);
    await resultPromise;
    expect(isPhoenixTimeoutAbort(receivedSignal)).toBe(false);
  });

  it('returns false for an unrelated value', () => {
    expect(isPhoenixTimeoutAbort(undefined)).toBe(false);
    expect(isPhoenixTimeoutAbort({ marker: 'something-else' })).toBe(false);
  });
});

describe('InterruptedError', () => {
  it('converts to AflowError with STEP_INTERRUPTED code', () => {
    const err = new InterruptedError();
    const aflowError = err.toAflowError();
    expect(aflowError.code).toBe('STEP_INTERRUPTED');
    expect(aflowError.retryable).toBe(false);
    expect(aflowError.classification).toBe('timeout');
  });
});

// ── Progress-aware timeout ─────────────────────────────────────────────────

describe('withTimeout — progress-aware spec', () => {
  /** fn that survives until aborted, reporting progress every `everyMs`. */
  function streamFor(totalMs: number, everyMs: number) {
    return (signal: AbortSignal, reportProgress: () => void) =>
      new Promise<string>((resolve, reject) => {
        const ticker = setInterval(reportProgress, everyMs);
        const done = setTimeout(() => {
          clearInterval(ticker);
          resolve('finished');
        }, totalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearInterval(ticker);
            clearTimeout(done);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
  }

  it('a slow-but-live stream outlives the idle window — kill on stall, not on work', async () => {
    // Runs 3× the idle window, but progress arrives well inside it every time.
    const result = await withTimeout(streamFor(150, 10), { idleMs: 50, maxMs: 1000 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toBe('finished');
  });

  it('a silent stream dies at the idle window with kind=idle', async () => {
    // No progress at all — the stall window is the liveness signal.
    const result = await withTimeout(streamFor(5000, 10_000), { idleMs: 50, maxMs: 5000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('timeout');
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect((result.error as TimeoutError).kind).toBe('idle');
      expect(result.error.message).toContain('stalled');
      // Fired at the idle window, nowhere near the ceiling.
      expect(result.durationMs).toBeLessThan(1000);
    }
  });

  it('continuous progress cannot extend past the ceiling — kind=ceiling', async () => {
    const result = await withTimeout(streamFor(5000, 10), { idleMs: 100, maxMs: 200 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('timeout');
      expect((result.error as TimeoutError).kind).toBe('ceiling');
      expect(result.error.message).toContain('ceiling');
    }
  });

  it('the abort reason carries the kind for downstream normalizers', async () => {
    let captured: unknown;
    const result = await withTimeout(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              captured = signal.reason;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      { idleMs: 40, maxMs: 5000 },
    );
    expect(result.success).toBe(false);
    expect(isPhoenixTimeoutAbort(captured)).toBe(true);
    expect((captured as { kind?: string }).kind).toBe('idle');
    expect((captured as { timeoutMs?: number }).timeoutMs).toBe(40);
  });

  it('keeps deadlineRef current so the heartbeat carries the live deadline', async () => {
    const deadlineRef = { current: 0 };
    const before = Date.now();
    const observed: number[] = [];
    const result = await withTimeout(
      (signal, reportProgress) =>
        new Promise<string>((resolve) => {
          observed.push(deadlineRef.current);
          setTimeout(() => {
            reportProgress();
            observed.push(deadlineRef.current);
            resolve('ok');
          }, 60);
        }),
      { idleMs: 100, maxMs: 10_000 },
      { deadlineRef },
    );
    expect(result.success).toBe(true);
    // Armed at start+idle, then slid forward by the progress report.
    expect(observed[0]).toBeGreaterThanOrEqual(before + 100);
    expect(observed[1]).toBeGreaterThan(observed[0]!);
  });

  it('a flat number keeps exact legacy behavior and reports kind=fixed', async () => {
    const result = await withTimeout(
      (signal, reportProgress) =>
        new Promise((_resolve, reject) => {
          // Progress must be a harmless no-op under a flat clock.
          const ticker = setInterval(reportProgress, 10);
          signal.addEventListener(
            'abort',
            () => {
              clearInterval(ticker);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      60,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect((result.error as TimeoutError).kind).toBe('fixed');
      // Progress did NOT extend the flat deadline.
      expect(result.durationMs).toBeLessThan(1000);
    }
  });
});

describe('withTimeout — abort classification race', () => {
  it('a timeout that fired first stays a timeout even when an external abort lands after it', async () => {
    const external = new AbortController();
    const result = await withTimeout(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              // The external abort arrives while the rejection is in flight —
              // the race the classifier must not lose.
              external.abort();
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      40,
      { externalSignal: external.signal },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('timeout');
      expect(result.error).toBeInstanceOf(TimeoutError);
    }
  });
});
