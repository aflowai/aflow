/**
 * The standard non-overlapping runner for stateful background work.
 *
 * `setInterval` is the wrong primitive for anything that talks to a datastore:
 * a cycle that runs long stacks on the next one, and the overlap is invisible
 * until the backlog is already unbounded. Every registered task schedules its
 * next cycle only after the previous one settles.
 *
 * This module is deliberately independent of `@aflow/schemas` — that package
 * depends on `@aflow/lib`, so the registry cannot be imported here. Callers
 * resolve a task's declared cadence/batch/mode from the registry and pass the
 * resulting numbers in.
 */

/**
 * Declared here rather than in the registry because `@aflow/schemas` depends
 * on this package: the Zod enum is built from this tuple, so the two cannot
 * drift into a state where a mode the registry accepts is one the runner has
 * never heard of.
 */
export const BACKGROUND_TASK_MODES = ['enabled', 'observe', 'disabled'] as const;
export type BackgroundTaskMode = (typeof BACKGROUND_TASK_MODES)[number];

/** The modes a cycle can actually observe — `start()` refuses to run `disabled`. */
export type BackgroundTaskRunningMode = Exclude<BackgroundTaskMode, 'disabled'>;

/**
 * Where the task is allowed to run. The runner enforces the obligation each one
 * implies rather than trusting the caller to remember it.
 */
export type BackgroundTaskScope =
  'per_instance' | 'singleton' | 'shard_owner' | 'active_subscription';

export interface BackgroundTaskCycleContext {
  readonly taskId: string;
  /**
   * Aborted when the task stops *and* when the cycle exhausts `maxCycleMs`.
   * Pass it to every awaited datastore call — without that, the budget is a
   * report after the fact rather than a limit, and a hung call outlives the
   * lease that made the work safe.
   */
  readonly signal: AbortSignal;
  /** Registry-declared batch ceiling for one cycle. */
  readonly maxBatch: number;
  /** Wall-clock deadline for this cycle. */
  readonly deadlineAtMs: number;
  /**
   * `observe` runs discovery and comparison but must suppress side effects.
   * Cycles that can produce side effects check this before acting.
   */
  readonly mode: BackgroundTaskRunningMode;
  /** True once the cycle has spent its time budget — stop claiming more work. */
  budgetExhausted(): boolean;
}

export interface BackgroundTaskCycleResult {
  /** Due candidates the cycle observed. */
  candidates?: number;
  /** Candidates the cycle claimed and processed. */
  processed?: number;
  /** Candidates whose handler failed and were rescheduled. */
  failed?: number;
  /**
   * More work is already known to be due. The runner re-arms immediately
   * instead of waiting a full cadence, so a backlog drains at batch speed.
   */
  hasMore?: boolean;
}

export type BackgroundTaskCycleFn = (
  ctx: BackgroundTaskCycleContext,
) => Promise<BackgroundTaskCycleResult>;

/**
 * Compare-and-release singleton lease. Supplied by the caller so this package
 * stays free of a Redis or Postgres dependency.
 */
export interface BackgroundTaskLease {
  /** Returns an opaque token on success, or null when another holder owns it. */
  acquire(): Promise<string | null>;
  /** Releases only if `token` is still the current holder. */
  release(token: string): Promise<void>;
}

export interface BackgroundTaskCycleEvent {
  taskId: string;
  outcome: 'completed' | 'failed' | 'skipped_lease' | 'skipped_overlap' | 'budget_exceeded';
  durationMs: number;
  candidates: number;
  processed: number;
  failed: number;
  consecutiveErrors: number;
  nextDelayMs: number;
  error?: Error;
}

export interface BackgroundTaskObserver {
  onCycle(event: BackgroundTaskCycleEvent): void;
}

export interface BackgroundTaskLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
}

export interface BackgroundTaskRunnerConfig {
  /** Registry task id. Used verbatim in every log line and metric label. */
  taskId: string;
  /** Registry execution scope. `singleton` requires `lease`. */
  scope: BackgroundTaskScope;
  /** Cadence between cycles when the previous cycle found nothing due. */
  intervalMs: number;
  maxBatch: number;
  maxCycleMs: number;
  mode?: BackgroundTaskMode;
  /** First backoff after a failed cycle. Doubles up to `maxErrorBackoffMs`. */
  errorBackoffMs?: number;
  maxErrorBackoffMs?: number;
  /**
   * Fraction of `intervalMs` used to spread instances apart. Without it every
   * replica wakes on the same tick and the datastore sees a synchronized burst.
   */
  jitterRatio?: number;
  /** Run the first cycle immediately instead of after a jittered delay. */
  runImmediately?: boolean;
  /** Keep the timer from holding the process open. Default true. */
  unref?: boolean;
  lease?: BackgroundTaskLease;
  /**
   * How long `stop()` waits for an in-flight cycle before giving up and
   * returning. Unbounded shutdown hangs a rolling deploy behind one stuck
   * datastore call, and lets work outlive the lease that made it safe.
   */
  shutdownTimeoutMs?: number;
  logger?: BackgroundTaskLogger;
  observer?: BackgroundTaskObserver;
}

export interface BackgroundTaskStatus {
  taskId: string;
  mode: BackgroundTaskMode;
  running: boolean;
  cycles: number;
  consecutiveErrors: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastError?: string;
  lastCandidates: number;
  lastProcessed: number;
}

export interface BackgroundTaskRunner {
  start(): void;
  stop(): Promise<void>;
  /** Run one cycle now, outside the schedule. Used by tests and operator tools. */
  runOnce(): Promise<BackgroundTaskCycleResult>;
  status(): BackgroundTaskStatus;
}

const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_ERROR_BACKOFF_MS = 1000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 60_000;

function jittered(baseMs: number, ratio: number): number {
  if (ratio <= 0) return baseMs;
  const spread = baseMs * ratio;
  return Math.max(0, Math.round(baseMs - spread / 2 + Math.random() * spread));
}

export function createBackgroundTaskRunner(
  config: BackgroundTaskRunnerConfig,
  cycle: BackgroundTaskCycleFn,
): BackgroundTaskRunner {
  const {
    taskId,
    intervalMs,
    maxBatch,
    maxCycleMs,
    mode = 'enabled',
    errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
    maxErrorBackoffMs = DEFAULT_MAX_ERROR_BACKOFF_MS,
    jitterRatio = DEFAULT_JITTER_RATIO,
    runImmediately = false,
    unref = true,
    lease,
    scope,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    logger,
    observer,
  } = config;

  if (scope === 'singleton' && !lease) {
    throw new Error(
      `Background task "${taskId}" is declared singleton but was given no lease. ` +
        'Without one it starts on every instance and processes the same candidates concurrently.',
    );
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `Background task "${taskId}" needs a positive intervalMs; got ${String(intervalMs)}. ` +
        'A zero cadence re-arms on the next macrotask and spins against the datastore.',
    );
  }

  // `start()` returns early for 'disabled', so a cycle only ever sees these.
  const runningMode: BackgroundTaskRunningMode = mode === 'disabled' ? 'enabled' : mode;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let started = false;
  let inFlight: Promise<unknown> | null = null;

  let cycles = 0;
  let consecutiveErrors = 0;
  let lastSuccessAtMs: number | undefined;
  let lastFailureAtMs: number | undefined;
  let lastError: string | undefined;
  let lastCandidates = 0;
  let lastProcessed = 0;

  function emit(event: BackgroundTaskCycleEvent): void {
    try {
      observer?.onCycle(event);
    } catch {
      // An observability failure must never take down the task.
    }
  }

  async function executeCycle(signal: AbortSignal): Promise<{
    result: BackgroundTaskCycleResult;
    error?: Error;
    outcome: BackgroundTaskCycleEvent['outcome'];
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + maxCycleMs;

    // The cycle's signal aborts on shutdown *or* on the budget, so a datastore
    // call that honours it is actually cancelled rather than merely reported.
    const cycleAbort = new AbortController();
    const onTaskAbort = (): void => {
      cycleAbort.abort(signal.reason);
    };
    if (signal.aborted) cycleAbort.abort(signal.reason);
    else signal.addEventListener('abort', onTaskAbort, { once: true });
    const budgetTimer = setTimeout(() => {
      cycleAbort.abort(new Error(`Background task "${taskId}" exceeded maxCycleMs`));
    }, maxCycleMs);
    budgetTimer.unref();

    const ctx: BackgroundTaskCycleContext = {
      taskId,
      signal: cycleAbort.signal,
      maxBatch,
      deadlineAtMs,
      mode: runningMode,
      budgetExhausted: () => Date.now() >= deadlineAtMs,
    };

    let leaseToken: string | null = null;
    try {
      if (lease) {
        // Inside the try: a rejecting acquire is a failed cycle. Outside it the
        // rejection escapes the runner entirely, so the error backoff never
        // engages and `void tick()` surfaces it as an unhandled rejection.
        leaseToken = await lease.acquire();
        if (leaseToken === null) {
          return {
            result: {},
            outcome: 'skipped_lease',
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const result = await cycle(ctx);
      const durationMs = Date.now() - startedAt;
      return {
        result,
        outcome: durationMs > maxCycleMs ? 'budget_exceeded' : 'completed',
        durationMs,
      };
    } catch (err) {
      return {
        result: {},
        error: err instanceof Error ? err : new Error(String(err)),
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(budgetTimer);
      signal.removeEventListener('abort', onTaskAbort);
      if (lease && leaseToken !== null) {
        try {
          await lease.release(leaseToken);
        } catch {
          // Lease expiry is the backstop; a failed release is not fatal.
        }
      }
    }
  }

  function nextDelayMs(
    outcome: BackgroundTaskCycleEvent['outcome'],
    result: BackgroundTaskCycleResult,
  ): number {
    if (outcome === 'failed') {
      const growth = errorBackoffMs * Math.pow(2, Math.max(0, consecutiveErrors - 1));
      return jittered(Math.min(growth, maxErrorBackoffMs), jitterRatio);
    }
    if (result.hasMore === true) return 0;
    return jittered(intervalMs, jitterRatio);
  }

  function arm(delayMs: number): void {
    if (!started) return;
    // A restart can leave the timer `start()` armed still pending while a
    // finishing cycle arms its own; only the last assignment is tracked, so the
    // earlier one would fire untracked and double the cadence.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    if (unref) timer.unref();
  }

  async function tick(): Promise<void> {
    if (!started) return;
    const signal = abortController?.signal;
    if (!signal || signal.aborted) return;

    if (inFlight !== null) {
      // A `runOnce()` is holding the slot. Skip this beat rather than stacking.
      emit({
        taskId,
        outcome: 'skipped_overlap',
        durationMs: 0,
        candidates: 0,
        processed: 0,
        failed: 0,
        consecutiveErrors,
        nextDelayMs: intervalMs,
      });
      arm(jittered(intervalMs, jitterRatio));
      return;
    }

    const pending = executeCycle(signal);
    inFlight = pending;
    let outcomeDelay = intervalMs;
    try {
      const { result, error, outcome, durationMs } = await pending;
      cycles += 1;
      lastCandidates = result.candidates ?? 0;
      lastProcessed = result.processed ?? 0;

      if (outcome === 'failed' && error) {
        consecutiveErrors += 1;
        lastFailureAtMs = Date.now();
        lastError = error.message;
        logger?.error(`[${taskId}] background cycle failed`, error, {
          taskId,
          consecutiveErrors,
        });
      } else if (outcome !== 'skipped_lease') {
        consecutiveErrors = 0;
        lastSuccessAtMs = Date.now();
        if (outcome === 'budget_exceeded') {
          logger?.warn(`[${taskId}] background cycle exceeded its time budget`, {
            taskId,
            durationMs,
            maxCycleMs,
          });
        }
      }

      outcomeDelay = nextDelayMs(outcome, result);
      emit({
        taskId,
        outcome,
        durationMs,
        candidates: result.candidates ?? 0,
        processed: result.processed ?? 0,
        failed: result.failed ?? 0,
        consecutiveErrors,
        nextDelayMs: outcomeDelay,
        ...(error ? { error } : {}),
      });
    } finally {
      inFlight = null;
      // `stop()` clears `started` before awaiting this cycle, and `arm` refuses
      // to schedule once it is clear — so a stop that lands mid-cycle cannot
      // leave a timer behind.
      arm(outcomeDelay);
    }
  }

  return {
    start(): void {
      if (started) return;
      if (mode === 'disabled') {
        logger?.warn(`[${taskId}] background task disabled by override — not started`, { taskId });
        return;
      }
      started = true;
      abortController = new AbortController();
      logger?.debug(`[${taskId}] background task started`, {
        taskId,
        mode,
        intervalMs,
        maxBatch,
        maxCycleMs,
      });
      arm(runImmediately ? 0 : jittered(intervalMs, jitterRatio));
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const stopping = abortController;
      stopping?.abort();
      if (inFlight) {
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([
          inFlight.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            drainTimer = setTimeout(() => {
              resolve(false);
            }, shutdownTimeoutMs);
            drainTimer.unref();
          }),
        ]);
        if (drainTimer) clearTimeout(drainTimer);
        if (!drained) {
          logger?.warn(`[${taskId}] background cycle did not drain before shutdown timeout`, {
            taskId,
            shutdownTimeoutMs,
          });
        }
      }
      // Only clear the controller we aborted. A `start()` that lands during the
      // await above has already installed a live one, and nulling that leaves
      // every later tick bailing on a missing signal with `running: true`.
      if (abortController === stopping) {
        abortController = null;
      }
      logger?.debug(`[${taskId}] background task stopped`, { taskId, cycles });
    },

    async runOnce(): Promise<BackgroundTaskCycleResult> {
      if (mode === 'disabled') {
        throw new Error(
          `Background task "${taskId}" is disabled by override; runOnce would perform the ` +
            'side effects the operator turned off.',
        );
      }
      // Take the same slot a scheduled cycle takes. Without this an operator or
      // test invocation runs a second cycle body concurrently against the same
      // datastore — the exact overlap the runner exists to prevent.
      while (inFlight !== null) {
        await inFlight;
      }
      const controller = abortController ?? new AbortController();
      const pending = executeCycle(controller.signal);
      inFlight = pending;
      try {
        const { result, error, outcome, durationMs } = await pending;
        emit({
          taskId,
          outcome,
          durationMs,
          candidates: result.candidates ?? 0,
          processed: result.processed ?? 0,
          failed: result.failed ?? 0,
          consecutiveErrors,
          nextDelayMs: 0,
          ...(error ? { error } : {}),
        });
        if (error) throw error;
        return result;
      } finally {
        inFlight = null;
      }
    },

    status(): BackgroundTaskStatus {
      return {
        taskId,
        mode,
        running: started,
        cycles,
        consecutiveErrors,
        lastCandidates,
        lastProcessed,
        ...(lastSuccessAtMs !== undefined ? { lastSuccessAtMs } : {}),
        ...(lastFailureAtMs !== undefined ? { lastFailureAtMs } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
      };
    },
  };
}
