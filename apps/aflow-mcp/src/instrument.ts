// Side-effecting crash-reporter init. Must be the FIRST import of `index.ts` so Sentry's
// OpenTelemetry auto-instrumentation patches http before it loads.
// No-op when SENTRY_DSN is unset, and when the build carries no reporter.
import { initCrashReporting } from '@aflow/observability/crashReporting';

initCrashReporting({
  serviceName: 'aflow-mcp',
  defaultTracesSampleRate: 0.1,
});
