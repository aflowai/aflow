/**
 * Cross-module marker for "Sentry owns OpenTelemetry in this process".
 *
 * The reporter sets this — it lives in `@aflow/crash-reporter-sentry`, a workspace
 * the public cut removes — and `initTracing` (in `./tracing.ts`) reads it to decide
 * whether to stand down.
 * Keeping the marker in this dependency-free module lets `tracing.ts` consult it
 * without pulling `@sentry/node` into the OpenTelemetry import chain.
 */

const FLAG = '__phoenixSentryActive';

/** Cross-package contract key. `initSentry` stores a flush fn here so generic
 * shutdown seams (notably `@aflow/lib`'s `attachSignalHandlers`) can drain
 * buffered Sentry events before `process.exit` WITHOUT importing `@sentry/node`.
 * The reader side hard-codes the same key — keep them in sync. */
export const SENTRY_SHUTDOWN_FLUSH_KEY = '__phoenixSentryShutdownFlush';

export function markSentryActive(): void {
  (globalThis as Record<string, unknown>)[FLAG] = true;
}

export function isSentryActive(): boolean {
  return (globalThis as Record<string, unknown>)[FLAG] === true;
}

export function registerSentryShutdownFlush(fn: () => Promise<void>): void {
  (globalThis as Record<string, unknown>)[SENTRY_SHUTDOWN_FLUSH_KEY] = fn;
}
