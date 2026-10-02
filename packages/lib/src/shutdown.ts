export interface ShutdownLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** Work still running when the signal came, and the instant its own timeout ends it. */
export interface InFlightWork {
  name: string;
  deadlineAt: number;
}

/** Work a signal lets finish: claiming stops at once, and what was claimed runs to its end. */
export interface DrainableWork {
  stopClaiming(): void;
  inFlight(): readonly InFlightWork[];
  /** Resolves once nothing is in flight. */
  idle(): Promise<void>;
}

export interface ShutdownDrain {
  work: DrainableWork;
  /** Ends whatever is still running: a drain past its deadline, or one the operator stopped. */
  endInFlight: () => void;
}

export interface ShutdownController {
  readonly shuttingDown: boolean;
  shutdownOnce(): Promise<void>;
  /** Ends a drain under way; outside one it does nothing. */
  stopNow(): void;
}

export interface CreateShutdownControllerOptions {
  name: string;
  logger: ShutdownLogger;
  onShutdown: () => Promise<void>;
  drain?: ShutdownDrain;
}

type DrainOutcome = 'finished' | 'deadline' | 'stopped';

/** `setTimeout` fires at once for a longer delay, so a later deadline is waited for in steps. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

function latestDeadline(work: readonly InFlightWork[]): number | undefined {
  return work.length === 0 ? undefined : Math.max(...work.map((w) => w.deadlineAt));
}

export function createShutdownController(
  options: CreateShutdownControllerOptions,
): ShutdownController {
  const { name, logger, onShutdown, drain } = options;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let endDrain: ((outcome: DrainOutcome) => void) | null = null;

  const runDrain = async ({ work, endInFlight }: ShutdownDrain): Promise<void> => {
    work.stopClaiming();
    const running = work.inFlight();
    const deadlineAt = latestDeadline(running);
    logger.info(`${name}: draining — claiming no new work, exiting once the steps in flight end`, {
      inFlight: running.map((w) => w.name),
      deadline: deadlineAt === undefined ? 'none' : new Date(deadlineAt).toISOString(),
    });

    const outcome = await new Promise<DrainOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (result: DrainOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        endDrain = null;
        resolve(result);
      };
      endDrain = settle;
      // Read again each time it fires rather than fixed at the start: a step
      // still queued had no timeout yet, and a progress-aware one slides its own.
      const arm = (): void => {
        const latest = latestDeadline(work.inFlight());
        if (latest === undefined) return;
        const wait = latest - Date.now();
        if (wait <= 0) {
          settle('deadline');
          return;
        }
        timer = setTimeout(arm, Math.min(wait, LONGEST_TIMER_MS));
      };
      void work.idle().then(() => {
        settle('finished');
      });
      arm();
    });

    const left = work.inFlight().map((w) => w.name);
    if (outcome !== 'finished') endInFlight();
    logger.info(`${name}: drain ended`, {
      outcome,
      ...(outcome === 'finished' ? {} : { ended: left }),
    });
  };

  const shutdownOnce = async (): Promise<void> => {
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        if (drain !== undefined) await runDrain(drain);
        logger.info(`${name}: shutting down gracefully...`);
        await onShutdown();
        logger.info(`${name}: shutdown complete`);
      } catch (error) {
        logger.warn(`${name}: error during shutdown`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    await shutdownPromise;
  };

  return {
    get shuttingDown() {
      return shuttingDown;
    },
    shutdownOnce,
    stopNow: () => {
      endDrain?.('stopped');
    },
  };
}

export interface AttachSignalHandlersOptions {
  onShutdown: () => Promise<void>;
  exitCode?: number;
  /** A SIGTERM or SIGINT that arrives while shutdown is already under way. */
  onRepeatSignal?: () => void;
}

/**
 * Cross-package contract: `@aflow/observability`'s `initSentry` registers a flush
 * fn on this global (see `SENTRY_SHUTDOWN_FLUSH_KEY`) so we can drain buffered Sentry
 * events before exit without importing `@sentry/node` into this generic package.
 * No-op when Sentry never initialized.
 */
async function drainSentry(): Promise<void> {
  const flush = (globalThis as Record<string, unknown>)['__phoenixSentryShutdownFlush'];
  if (typeof flush === 'function') {
    try {
      await (flush as () => Promise<void>)();
    } catch {
      // Never let a flush failure block exit.
    }
  }
}

export function attachSignalHandlers(options: AttachSignalHandlersOptions): void {
  const { onShutdown, exitCode = 0, onRepeatSignal } = options;
  let handling = false;

  const handle = () => {
    if (handling) {
      onRepeatSignal?.();
      return;
    }
    handling = true;
    void (async () => {
      try {
        await onShutdown();
      } finally {
        await drainSentry();
        process.exit(exitCode);
      }
    })();
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
}
