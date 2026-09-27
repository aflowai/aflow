/**
 * Lazy orchestrator logger — modules must not call `createLogger()` at import time
 * (logging is configured in `index.ts` after `initObservability`).
 *
 * Unit tests (Vitest) do not run `configureLogging()`; fall back to a standalone
 * logger so ShardManager, ResultConsumer, RecoveryService, etc. stay testable.
 */
import { createLogger, createLoggerWithConfig, type Logger } from '@aflow/observability';
import { errorContextFromUnknown } from '@aflow/schemas';

let instance: Logger | undefined;

const TEST_FALLBACK_CONFIG = {
  service: 'aflow-orchestrator',
  level: 'error' as const,
  prettyPrint: false,
};

export function getOrchestratorLogger(): Logger {
  if (!instance) {
    try {
      instance = createLogger({ component: 'orchestrator' });
    } catch {
      instance = createLoggerWithConfig(TEST_FALLBACK_CONFIG, { component: 'orchestrator' });
    }
  }
  return instance;
}

export function logOrchestratorError(
  message: string,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  getOrchestratorLogger().error(
    message,
    err instanceof Error ? err : undefined,
    errorContextFromUnknown(err, context),
  );
}
