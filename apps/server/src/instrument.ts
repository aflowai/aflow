// Side-effecting crash-reporter init. Must be the FIRST import of `index.ts` so Sentry's
// OpenTelemetry auto-instrumentation patches http/fastify/pg/redis before those
// modules are imported. No-op when SENTRY_DSN is unset.
import { initCrashReporting } from '@aflow/observability/crashReporting';

initCrashReporting({
  serviceName: 'phoenix-server',
  defaultTracesSampleRate: 0.1,
});
