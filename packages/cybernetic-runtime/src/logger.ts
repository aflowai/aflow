/**
 * Cybernetic runtime logger — wraps @aflow/observability.
 *
 * Lazily initialized singleton. Always call `getCyberneticLogger()`
 * at use-site, never cache at module scope — avoids triggering
 * `createLogger()` before the app calls `configureLogging()`.
 *
 * @packageDocumentation
 */
import { createLogger, type Logger } from '@aflow/observability';

let instance: Logger | undefined;

function resolve(): Logger {
  if (!instance) {
    instance = createLogger({ component: 'cybernetic-runtime' });
  }
  return instance;
}

/**
 * Returns the cybernetic-runtime logger singleton.
 * Always call at use-site, never cache at module scope.
 */
export function getCyberneticLogger(): Logger {
  return resolve();
}

export function logCyberneticError(
  message: string,
  error: unknown,
  meta?: Record<string, unknown>,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  resolve().error(message, err, meta);
}
