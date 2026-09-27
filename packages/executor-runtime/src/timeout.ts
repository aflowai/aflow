/**
 * Timeout utilities for step execution.
 */
import type { AflowError } from '@aflow/schemas';

/**
 * Error thrown when a step execution times out.
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  /** Which limit fired — a stalled stream, the absolute ceiling, or a flat clock. */
  readonly kind: PhoenixTimeoutKind;

  constructor(timeoutMs: number, message?: string, kind: PhoenixTimeoutKind = 'fixed') {
    super(
      message !== undefined ? message : `Step execution timed out after ${String(timeoutMs)}ms`,
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.kind = kind;
  }

  /**
   * Convert to AflowError format.
   */
  toAflowError(): AflowError {
    return {
      code: 'STEP_TIMEOUT',
      message: this.message,
      classification: 'timeout',
      retryable: true,
      timestamp: new Date().toISOString(),
      details: {
        timeoutMs: this.timeoutMs,
        timeoutKind: this.kind,
      },
    };
  }
}

/**
 * Error thrown when a step is externally interrupted (e.g. user interrupt via pub/sub).
 */
export class InterruptedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Step execution was interrupted');
    this.name = 'InterruptedError';
  }

  toAflowError(): AflowError {
    return {
      code: 'STEP_INTERRUPTED',
      message: this.message,
      classification: 'timeout',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }
}

/** Why the step was aborted. */
export type AbortReason = 'timeout' | 'interrupted';

/**
 * Marker on an AbortSignal.reason set by `withTimeout` when its own deadline fires.
 * Lets downstream code (e.g. AI provider error normalizers) distinguish
 * "platform-enforced timeout fired" from "upstream SDK aborted on its own"
 * or "external interrupt" — the three look identical at the AbortError layer.
 */
export type PhoenixTimeoutKind = 'fixed' | 'idle' | 'ceiling';

export interface PhoenixTimeoutAbortReason {
  readonly marker: 'phoenix.executor.timeout';
  readonly timeoutMs: number;
  /** Which limit fired. Absent on records written before the field existed. */
  readonly kind?: PhoenixTimeoutKind;
}

/**
 * A progress-aware timeout: the deadline slides to `now + idleMs` on every
 * progress signal, capped at `start + maxMs`.
 *
 * Kill on STALL, not on WORK. A flat wall clock cannot tell a stream
 * delivering a token per second from one that died four minutes ago — it
 * reaps live generations (a reasoning-heavy turn streaming past the cap) and
 * dawdles on dead ones (a hung stream waits out the whole budget). The idle
 * window is the liveness signal; the ceiling only bounds runaway generation.
 * Same principle as the orchestrator's stall watchdog one layer up: never
 * reap on elapsed time alone.
 */
export interface ProgressAwareTimeoutSpec {
  /** Stall window — the deadline slides to now+idleMs on each progress signal. */
  idleMs: number;
  /** Hard ceiling from start; progress never extends past it. */
  maxMs: number;
}

export type TimeoutSpec = number | ProgressAwareTimeoutSpec;

const PHOENIX_TIMEOUT_MARKER = 'phoenix.executor.timeout' as const;

/**
 * True when an AbortSignal (or its `reason`) was aborted by `withTimeout`'s
 * own deadline, as opposed to an external abort or SDK-internal timeout.
 */
export function isPhoenixTimeoutAbort(value: unknown): value is PhoenixTimeoutAbortReason {
  if (value == null) return false;
  if (typeof value === 'object' && 'aborted' in value && 'reason' in value) {
    const sig = value as AbortSignal;
    if (!sig.aborted) return false;
    return isPhoenixTimeoutAbort(sig.reason);
  }
  return (
    typeof value === 'object' && (value as { marker?: unknown }).marker === PHOENIX_TIMEOUT_MARKER
  );
}

/**
 * Marker on an AbortSignal.reason set when the ORCHESTRATOR aborted the step —
 * an operator cancel, a session interrupt, or the stall watchdog. Distinct from
 * the timeout marker because a step that was stopped did not run out of time,
 * and a handler that reports one as the other misdirects whoever reads the run.
 */
export interface PhoenixExternalAbortReason extends Error {
  readonly marker: 'phoenix.executor.externalAbort';
  /** The orchestrator's own word for why, e.g. `cancelled` / `interrupted`. */
  readonly cause: string;
}

const PHOENIX_EXTERNAL_ABORT_MARKER = 'phoenix.executor.externalAbort' as const;

/**
 * An Error, not a bare object: Node rejects `fetch` with `signal.reason`
 * verbatim, so handler code that catches an abort would otherwise be handed
 * something that fails both `instanceof Error` and `isAbortError`, and would
 * stringify into a useless message. `name` is `AbortError` for the same reason.
 */
export function externalAbortReason(cause: string): PhoenixExternalAbortReason {
  const error = new Error(`Step aborted by the orchestrator (${cause})`) as Error & {
    marker: typeof PHOENIX_EXTERNAL_ABORT_MARKER;
    cause: string;
  };
  error.name = 'AbortError';
  error.marker = PHOENIX_EXTERNAL_ABORT_MARKER;
  error.cause = cause;
  return error;
}

/** True when an AbortSignal (or its `reason`) was aborted by the orchestrator. */
export function isPhoenixExternalAbort(value: unknown): value is PhoenixExternalAbortReason {
  if (value == null) return false;
  if (typeof value === 'object' && 'aborted' in value && 'reason' in value) {
    const sig = value as AbortSignal;
    if (!sig.aborted) return false;
    return isPhoenixExternalAbort(sig.reason);
  }
  return (
    typeof value === 'object' &&
    (value as { marker?: unknown }).marker === PHOENIX_EXTERNAL_ABORT_MARKER
  );
}

/**
 * Result of a timed operation.
 */
export type TimedResult<T> =
  | { success: true; value: T; durationMs: number }
  | { success: false; error: TimeoutError; durationMs: number; reason: 'timeout' }
  | { success: false; error: InterruptedError; durationMs: number; reason: 'interrupted' };

export interface WithTimeoutOpts {
  /** External abort (e.g. orchestrator interrupt via pub/sub). */
  externalSignal?: AbortSignal | undefined;
  /**
   * Live view of the current deadline (epoch ms). The step in-flight heartbeat
   * carries this to the orchestrator's stall watchdog, so an idle-extended
   * stream is never reaped at the original deadline + backstop.
   */
  deadlineRef?: { current: number } | undefined;
}

/**
 * Run a function with a timeout and optional external abort signal.
 *
 * The handler receives a composite AbortSignal that fires on either:
 * - timeout expiry (a flat clock, or the idle/ceiling pair of a
 *   ProgressAwareTimeoutSpec), or
 * - the external signal being aborted (e.g. orchestrator interrupt via pub/sub).
 *
 * With a spec, the handler's `reportProgress` callback slides the deadline —
 * call it on every unit of observable progress (each streamed chunk). With a
 * flat number the callback is a no-op, so handlers may call it unconditionally.
 *
 * The result discriminates between timeout and external interrupt so the caller
 * can skip emitting a failure result when the step was already force-completed.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal, reportProgress: () => void) => Promise<T>,
  timeout: TimeoutSpec,
  opts?: WithTimeoutOpts,
): Promise<TimedResult<T>> {
  const externalSignal = opts?.externalSignal;
  const timeoutController = new AbortController();
  const startTime = Date.now();

  const spec = typeof timeout === 'number' ? undefined : timeout;
  const ceilingMs = spec ? spec.maxMs : (timeout as number);
  const ceilingAtMs = startTime + ceilingMs;
  let deadlineAtMs = spec ? Math.min(startTime + spec.idleMs, ceilingAtMs) : ceilingAtMs;
  if (opts?.deadlineRef) opts.deadlineRef.current = deadlineAtMs;
  const fired: { kind: PhoenixTimeoutKind; ms: number } = { kind: 'fixed', ms: ceilingMs };

  let timeoutId: NodeJS.Timeout;
  const check = () => {
    const now = Date.now();
    if (now < deadlineAtMs) {
      // Progress moved the deadline since this timer was armed.
      timeoutId = setTimeout(check, deadlineAtMs - now);
      return;
    }
    if (spec) {
      fired.kind = now >= ceilingAtMs ? 'ceiling' : 'idle';
      fired.ms = fired.kind === 'idle' ? spec.idleMs : spec.maxMs;
    }
    const reason: PhoenixTimeoutAbortReason = {
      marker: PHOENIX_TIMEOUT_MARKER,
      timeoutMs: fired.ms,
      kind: fired.kind,
    };
    timeoutController.abort(reason);
  };
  timeoutId = setTimeout(check, deadlineAtMs - startTime);

  const reportProgress = () => {
    if (!spec || timeoutController.signal.aborted) return;
    const next = Math.min(Date.now() + spec.idleMs, ceilingAtMs);
    if (next > deadlineAtMs) {
      deadlineAtMs = next;
      if (opts?.deadlineRef) opts.deadlineRef.current = next;
    }
  };

  // Compose timeout + external signal. If no external signal, just use timeout.
  const compositeSignal = externalSignal
    ? AbortSignal.any([timeoutController.signal, externalSignal])
    : timeoutController.signal;

  try {
    const value = await fn(compositeSignal, reportProgress);
    clearTimeout(timeoutId);
    return {
      success: true,
      value,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    // Classify by the composite signal's reason — AbortSignal.any preserves
    // whichever abort fired FIRST. Checking externalSignal.aborted alone
    // misclassifies the race where the timeout fires and an external abort
    // lands moments later: the step would report 'interrupted', and the
    // caller would skip emitting the timeout failure entirely.
    const timedOutFirst = isPhoenixTimeoutAbort(compositeSignal.reason);
    if (externalSignal?.aborted && !timedOutFirst) {
      return {
        success: false,
        error: new InterruptedError(),
        durationMs,
        reason: 'interrupted',
      };
    }

    if (timeoutController.signal.aborted) {
      const message =
        fired.kind === 'idle'
          ? `Model stream stalled: no progress for ${String(fired.ms)}ms ` +
            `(step ran ${String(durationMs)}ms of a ${String(ceilingMs)}ms ceiling) — ` +
            `treated as a hung stream`
          : fired.kind === 'ceiling'
            ? `Step exceeded its ${String(ceilingMs)}ms ceiling while still making progress — ` +
              `the work is too large for one execution`
            : undefined;
      return {
        success: false,
        error: new TimeoutError(fired.ms, message, fired.kind),
        durationMs,
        reason: 'timeout',
      };
    }

    // Re-throw other errors (non-abort failures)
    throw error;
  }
}

/**
 * Create an abort signal that times out after the specified duration.
 */
export function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
    },
  };
}

/**
 * Check if an error is due to abort/timeout.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.name === 'InterruptedError' ||
      (error as { code?: string }).code === 'ABORT_ERR'
    );
  }
  return false;
}
