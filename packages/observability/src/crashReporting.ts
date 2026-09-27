/**
 * The seam between core services and a crash reporter that only one edition has.
 *
 * The local edition ships no reporter at all — not a dormant one. §6b of the
 * local-security plan makes that a property of the artifact rather than of an
 * unset `SENTRY_DSN`, because a configuration can be defaulted back on by a later
 * release and cannot be audited by the person who installed the appliance.
 *
 * Which means core code cannot import the SDK, and the executors are shared
 * source: the same ten `instrument.ts` files run in both editions, so there is no
 * per-tier entrypoint to put the import behind. The reporter is therefore loaded
 * at runtime, from a module the public cut does not contain.
 *
 * **Loaded synchronously, and that is not a style choice.** The reporter's
 * OpenTelemetry instrumentation has to patch `redis` and `pg` before those
 * modules are evaluated, and an `await` here does not hold them back: a top-level
 * await in the first import does NOT block a sibling import from evaluating, so
 * `index.ts`'s remaining imports would load underneath it and come out unpatched.
 * `createRequire` is what makes the load land before them, and the same technique
 * is already used one file over to pull in an optional native profiler.
 */

import { createRequire } from 'node:module';

import {
  isSentryActive,
  markSentryActive,
  registerSentryShutdownFlush,
  SENTRY_SHUTDOWN_FLUSH_KEY,
} from './sentryActive.js';
import { installUnhandledRejectionGuard } from './unhandledRejection.js';

/**
 * What a reporter implementation needs from core, and the only surface it gets.
 *
 * The implementation is a separate workspace the public cut removes whole, so it
 * reaches core through this subpath rather than through relative paths into a
 * package it no longer lives in. Named for the role rather than the vendor: core
 * does not know which reporter, and a second implementation would use the same
 * four calls.
 */
export {
  installUnhandledRejectionGuard,
  markSentryActive as markCrashReporterActive,
  registerSentryShutdownFlush as registerCrashReporterFlush,
};

/** Where the reporter leaves a Fastify decorator, if it has one to leave. */
const FASTIFY_HANDLER_KEY = '__phoenixCrashReporterFastifyHandler';

export interface CrashReportingOptions {
  /** Canonical service name — becomes the reporter's service tag. */
  serviceName: string;
  /** Trace sample rate this service defaults to when nothing overrides it. */
  defaultTracesSampleRate?: number;
}

/** Whether a reporter initialised in this process. */
export function isCrashReporterActive(): boolean {
  return isSentryActive();
}

/**
 * Start the crash reporter, if this build has one and it is configured.
 *
 * The DSN is read before anything is loaded, so a build that *does* carry the
 * reporter still touches none of it until an operator has asked for reporting.
 * That ordering is what keeps development and test runs from requiring a module
 * they would then have to resolve through a TypeScript loader.
 */
export function initCrashReporting(options: CrashReportingOptions): void {
  // Before the DSN is consulted, and before any reporter is loaded: whether this
  // process survives a stray rejection must not depend on whether a secret
  // reached it, or on which edition it is. The guard is core behaviour that the
  // reporter merely used to sit in front of; it is idempotent, so a reporter that
  // installs it again is harmless.
  installUnhandledRejectionGuard(options.serviceName);

  const dsn = process.env['SENTRY_DSN'];
  const configured = dsn != null && dsn.trim() !== '';

  // Unset is the default and says nothing; only a configured DSN with no
  // reporter behind it is announced, because an empty reporting project and a
  // reporter that never loaded look identical from the outside, and the
  // difference decides whether anyone goes looking.
  if (!configured) return;
  const reporter = loadReporter(options.serviceName);
  if (reporter === null) {
    console.log(
      `[crash-reporting] no reporter in this build for ${options.serviceName}; nothing was sent`,
    );
    return;
  }

  reporter.initSentry(options);
}

interface ReporterModule {
  initSentry: (options: CrashReportingOptions) => void;
}

/**
 * The reporter module, or null when this build does not carry it.
 *
 * Absence is the expected answer in the public cut and a broken build anywhere
 * else, so the two are not reported the same way: the edition says which one this
 * is. Read from the environment rather than the resolved descriptor because this
 * runs before anything else in the process, which is the same moment the
 * descriptor resolves from.
 */
function loadReporter(serviceName: string): ReporterModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require('@aflow/crash-reporter-sentry') as ReporterModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env['PHOENIX_EDITION']?.trim() === 'community-local') {
      return null;
    }
    console.error(
      `[crash-reporting] ${serviceName} is configured for reporting but the reporter ` +
        `could not be loaded: ${message}`,
    );
    return null;
  }
}

/**
 * Drain buffered events before exit.
 *
 * Reads the flush the reporter registered rather than calling it directly, which
 * is how a shutdown seam in a package that must never import the SDK reaches it.
 */
export async function flushCrashReporting(timeoutMs = 2000): Promise<void> {
  const flush = (globalThis as Record<string, unknown>)[SENTRY_SHUTDOWN_FLUSH_KEY];
  if (typeof flush !== 'function') return;
  try {
    await (flush as () => Promise<void>)();
  } catch {
    // A failed flush must never be the reason a process will not stop.
  }
  void timeoutMs;
}

/** Let the reporter decorate a Fastify instance, if it registered a way to. */
export function registerCrashReporterFastifyHandler(fn: (app: unknown) => void): void {
  (globalThis as Record<string, unknown>)[FASTIFY_HANDLER_KEY] = fn;
}

/**
 * Apply the reporter's Fastify error handler, if one was registered.
 *
 * The server is core and the handler is the reporter's, so the server asks
 * whether anything registered one instead of naming the vendor.
 */
export function applyCrashReporterFastifyHandler(app: unknown): void {
  const fn = (globalThis as Record<string, unknown>)[FASTIFY_HANDLER_KEY];
  if (typeof fn === 'function') (fn as (app: unknown) => void)(app);
}
