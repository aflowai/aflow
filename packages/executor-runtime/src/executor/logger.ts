/**
 * Executor logging — delegates to @aflow/observability.
 */
import { createLoggerWithConfig, type Logger } from '@aflow/observability';
import type { ExecutorLogger } from '../types.js';

const LOG_LEVEL = (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

/** Adapt observability Logger to the ExecutorLogger interface (error sig differs). */
function toExecutorLogger(logger: Logger): ExecutorLogger {
  return {
    debug: (m, d) => {
      logger.debug(m, d);
    },
    info: (m, d) => {
      logger.info(m, d);
    },
    warn: (m, d) => {
      logger.warn(m, d);
    },
    error: (m, d) => {
      logger.error(m, undefined, d);
    },
  };
}

/**
 * Create a service-level logger for executor apps.
 * Respects LOG_LEVEL, provides structured JSON output, and redacts secrets.
 * Compatible with ShutdownLogger, RedisErrorGuardLogger, and ExecutorLogger interfaces.
 */
export function createServiceLogger(service: string): ExecutorLogger {
  return toExecutorLogger(createLoggerWithConfig({ service, level: LOG_LEVEL }));
}

export function createJobLogger(
  service: string,
  job?: { stepExecutionId: string; attempt: number },
): ExecutorLogger {
  const base = createLoggerWithConfig({ service, level: LOG_LEVEL });
  const child = job
    ? base.child({ stepExecutionId: job.stepExecutionId, attempt: job.attempt })
    : base;
  return toExecutorLogger(child);
}
