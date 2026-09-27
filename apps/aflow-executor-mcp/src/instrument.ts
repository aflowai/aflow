// Side-effecting crash-reporter init. Must be the FIRST import of `index.ts` so Sentry's
// OpenTelemetry auto-instrumentation patches redis/pg before those modules load.
// Conservative sample rates: executors run on the high-throughput worker hot path.
// No-op when SENTRY_DSN is unset, and when the build carries no reporter.
import { initCrashReporting } from '@aflow/observability/crashReporting';

initCrashReporting({
  serviceName: 'mcp-executor',
  defaultTracesSampleRate: 0.05,
});
