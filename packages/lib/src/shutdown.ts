import drainSignal from './drainSignal.json' with { type: 'json' };

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
  /** Claims nothing more, and gives back whatever was claimed but has not started. */
  stopClaiming(): void;
  /** The work that has started. Work still waiting its turn is not in flight. */
  inFlight(): readonly InFlightWork[];
  /** Resolves once something is in flight, at once if something already is. */
  whenInFlight(): Promise<void>;
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
  /** Stops now: ends whatever is in flight, a drain under way included, then shuts down. */
  shutdownOnce(): Promise<void>;
  /**
   * Claims nothing more, waits for what is in flight, then shuts down. Asked
   * again while the drain is under way, it stops now. Without a `drain` it is
   * `shutdownOnce`.
   */
  drainOnce(): Promise<void>;
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

/**
 * Two ways to stop, because supervisors make two different promises.
 *
 * `shutdownOnce` is what SIGTERM and SIGINT ask for, and it ends every workload
 * at once. Whatever sends those may follow with SIGKILL after a short grace —
 * the dev runner after ten seconds, a watcher restarting the service after
 * five, launchd after its default — and SIGKILL skips every exit handler and
 * reaches no process in a group of its own. Work left running then is
 * unaddressed: a harness holding its provider credential, a checkout on disk.
 *
 * `drainOnce` is what SIGUSR2 asks for, sent only by a supervisor that has
 * promised to wait for the exit without a kill — `scripts/watch-service.mjs --drain`.
 * It stops claiming, lets what is in flight run to its own deadline, then shuts
 * down. A second drain request, or a `shutdownOnce` during the drain, stops now.
 */
export function createShutdownController(
  options: CreateShutdownControllerOptions,
): ShutdownController {
  const { name, logger, onShutdown, drain } = options;
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
      // Read again each time it fires rather than fixed at the start: a step a
      // read under way delivers starts later, and a progress-aware one slides
      // its own.
      const arm = (): void => {
        if (settled) return;
        const latest = latestDeadline(work.inFlight());
        // Nothing in flight, yet not idle: a read under way can still hand
        // this consumer steps, and the first one's timeout sets the deadline.
        if (latest === undefined) {
          void work.whenInFlight().then(arm);
          return;
        }
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

  const shutDownAfter = (first: () => Promise<void> | void): Promise<void> =>
    (shutdownPromise ??= (async () => {
      try {
        await first();
        logger.info(`${name}: shutting down gracefully...`);
        await onShutdown();
        logger.info(`${name}: shutdown complete`);
      } catch (error) {
        logger.warn(`${name}: error during shutdown`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })());

  const endInFlightNow = ({ work, endInFlight }: ShutdownDrain): void => {
    const running = work.inFlight().map((w) => w.name);
    if (running.length > 0) {
      logger.info(`${name}: stopping now — ending the steps in flight`, { ended: running });
    }
    endInFlight();
  };

  const shutdownOnce = (): Promise<void> => {
    if (endDrain !== null) {
      endDrain('stopped');
      return shutdownPromise ?? Promise.resolve();
    }
    return shutDownAfter(() => {
      if (drain !== undefined) endInFlightNow(drain);
    });
  };

  const drainOnce = (): Promise<void> => {
    if (endDrain !== null || drain === undefined) return shutdownOnce();
    return shutDownAfter(() => runDrain(drain));
  };

  return {
    get shuttingDown() {
      return shutdownPromise !== null;
    },
    shutdownOnce,
    drainOnce,
  };
}

/**
 * A signal no supervisor that kills sends: only one that waits for the exit
 * asks for a drain, so SIGTERM and SIGINT can stay a stop. Kept in JSON because
 * the watcher that sends it, `scripts/watch-service.mjs`, runs under plain
 * Node and reads it from there.
 */
export const DRAIN_SIGNAL = drainSignal.signal;

export interface AttachSignalHandlersOptions {
  /** SIGTERM and SIGINT, every time either arrives; it must be safe to call again. */
  onShutdown: () => Promise<void>;
  /** `DRAIN_SIGNAL`, every time it arrives. Without one the signal keeps its default. */
  onDrain?: () => Promise<void>;
  exitCode?: number;
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
  const { onShutdown, onDrain, exitCode = 0 } = options;
  let exiting = false;

  // Every signal reaches its handler, so a later one can turn a drain into a stop;
  // the process exits once, when the first one's shutdown settles.
  const handleWith = (handler: () => Promise<void>) => () => {
    const settled = handler();
    if (exiting) return;
    exiting = true;
    void (async () => {
      try {
        await settled;
      } finally {
        await drainSentry();
        process.exit(exitCode);
      }
    })();
  };

  process.on('SIGTERM', handleWith(onShutdown));
  process.on('SIGINT', handleWith(onShutdown));
  if (onDrain !== undefined) process.on(DRAIN_SIGNAL, handleWith(onDrain));
}
