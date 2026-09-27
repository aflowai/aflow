/**
 * Starting a built application, without deciding to be a process.
 *
 * Importing this must not read a `.env`, install a signal handler, or exit.
 * Those belong to whatever is the executable, and a runtime that did them
 * would impose them on every consumer — a test that imports the factory would
 * inherit the checkout's environment, and a second application embedding this
 * one would find its own shutdown already claimed.
 *
 * What is shared is the sequence: configure logging, install the background
 * control plane, build, listen. The caller decides what a failure means.
 */
import { errorContextFromUnknown, installBackgroundTaskControlPlane } from '@aflow/schemas';
import { configureLogging, createLogger, recordBackgroundTaskDisabled } from '@aflow/observability';
import { flushCrashReporting } from '@aflow/observability/crashReporting';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import type { ServerComposition } from './compose/surfaceTier.js';

export interface ServeOptions {
  host: string;
  port: number;
}

/**
 * Build and listen. Returns the running instance so the caller owns its
 * lifetime — including whether a failure to listen ends the process.
 */
export async function serve(
  composition: ServerComposition,
  { host, port }: ServeOptions,
): Promise<FastifyInstance> {
  const isProduction = process.env['NODE_ENV'] === 'production';

  const loggerConfig = isProduction
    ? { level: process.env['LOG_LEVEL'] ?? 'info' }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      };

  // Fastify's per-request lines duplicate the Next.js access log in
  // development, so they are off there unless asked for, and on in production
  // unless refused.
  const disableRequestLogging =
    process.env['HTTP_REQUEST_LOG'] === '1'
      ? false
      : process.env['HTTP_REQUEST_LOG'] === '0'
        ? true
        : !isProduction;

  // So that `createLogger()` works for every package running inside this
  // process, not only for the ones this file can see.
  configureLogging({
    service: 'phoenix-server',
    level: (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
    prettyPrint: !isProduction,
  });

  const backgroundLogger = createLogger({ component: 'background-tasks' });
  installBackgroundTaskControlPlane({
    services: ['server'],
    hooks: {
      logError: (message, data) => {
        backgroundLogger.error(message, undefined, data);
      },
      logWarn: (message, data) => {
        backgroundLogger.warn(message, data);
      },
      onDisabled: recordBackgroundTaskDisabled,
    },
  });

  const app = await buildApp(composition, { logger: loggerConfig, disableRequestLogging });

  try {
    await app.listen({ port, host });
    app.log.info(`Server running at http://${host}:${String(port)}`);
    app.log.info(`API docs at http://${host}:${String(port)}/docs`);
  } catch (err) {
    app.log.error(
      { err, ...errorContextFromUnknown(err, { phase: 'listen', port, host }) },
      'Server failed to listen',
    );
    // A failed listen never returns the instance, so the caller has no handle to
    // close what buildApp already opened. An embedding process survives the
    // rejection; its database and Redis connections would not be released.
    await app.close().catch(() => undefined);
    throw err;
  }

  return app;
}

/**
 * Close on the first termination signal, then flush.
 *
 * Offered rather than installed: a process opts in, and one embedding this
 * server keeps its own shutdown. Without the flush, a launcher's SIGTERM kills
 * the process with telemetry still buffered.
 */
export function closeOnSignal(app: FastifyInstance, exit: (code: number) => never): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully`);
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'Error while closing app during shutdown');
    }
    await flushCrashReporting(2000);
    exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
