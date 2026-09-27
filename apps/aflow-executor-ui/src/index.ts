/**
 * UI Executor Service
 * Processes ui.* step jobs (artifact generation, validation, rendering).
 */
// Must precede all other imports so Sentry can patch redis/pg before they load.
import './instrument.js';
import {
  ExecutorRuntime,
  DEFAULT_EXECUTOR_CONFIG,
  createServiceLogger,
  type ExecutorConfig,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import {
  getRedisConnection,
  closeRedisConnection,
  createRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  quitRedisWithTimeout,
  attachRedisErrorGuard,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';
import { createDatabase, getDatabaseConfig } from '@aflow/database';

import { UiArtifactHandler } from './handlers/uiArtifactHandler.js';
import { createAppletDeltaFanout } from './handlers/appletDeltaFanout.js';
import { initUiAiClient } from './aiClient.js';

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `ui-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('ui'),
    streamKey: StreamKeys.jobStream('ui'),
    stepType: 'ui',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '10', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '60000', 10),
  };
}

const log = createServiceLogger('ui-executor');

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  log.info('Starting UI Executor...');

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `ui-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `ui-executor-${String(process.pid)}-subscriber`,
  });

  // Initialize database connection — raw postgres.Sql for tenant-scoped
  // queries plus a drizzle handle for BYOK credential resolution.
  let database;
  try {
    database = createDatabase(getDatabaseConfig());
    log.info('Database connection established');
  } catch (err) {
    log.error('Failed to connect to database', { error: err });
    throw err;
  }
  const sqlClient = database.sql;
  initUiAiClient(database.db);

  const controller = createShutdownController({
    name: 'UI Executor',
    logger: log,
    onShutdown: async () => {
      await runtime.stop();
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
      await database.close();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);

  // No in-memory fallback: this process writes refs another one reads, and a
  // process-local store would resolve none of them. Refusing to start names
  // the missing configuration; taking it would surface as empty step inputs.
  const resolved = resolvePayloadStore({ redis });
  if (!resolved) {
    log.error(
      'No payload store: set PHOENIX_PAYLOAD_DIR, configure GCS, or leave USE_REDIS_PAYLOAD_STORE unset so Redis can serve it.',
    );
    process.exit(1);
  }
  const payloadStore = resolved.store;
  log.info(resolved.reason);

  // Build dependencies
  const deps: ExecutorDependencies = {
    redis,
    redisBlocking,
    redisSubscriber,
    payloadStore,
  };

  // Create executor runtime
  const config = getConfig();
  const runtime = new ExecutorRuntime(config, deps);

  // Signal handlers wire onShutdown → runtime.stop(); attach only after runtime exists.
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  // Register handler (UiArtifactHandler delegates to SurfaceHandler for ui.surface.*
  // and AppletHandler for ui.applet.* ops)
  runtime.registerHandler(
    new UiArtifactHandler({
      sqlClient,
      payloadStore,
      db: database.db,
      publishAppletDelta: createAppletDeltaFanout(redis),
    }),
  );

  // Start the executor
  await runtime.start();

  log.info('UI Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
  });
}

main().catch((error: unknown) => {
  log.error('Failed to start UI Executor', { error });
  process.exit(1);
});
