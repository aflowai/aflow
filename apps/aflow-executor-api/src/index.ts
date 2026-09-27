/**
 * API Executor Service
 * Processes api.* step jobs.
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
  subscribeApiCatalogInvalidation,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';

import { ApiCallHandler } from './handlers/api/index.js';
import { createDatabase } from '@aflow/database';

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `api-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('api'),
    streamKey: StreamKeys.jobStream('api'),
    stepType: 'api',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '20', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '30000', 10),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const log = createServiceLogger('api-executor');

  log.info('Starting API Executor...');

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `api-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSub = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `api-executor-${String(process.pid)}-subscriber`,
  });
  const redisAbortSub = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `api-executor-${String(process.pid)}-abort-sub`,
  });

  const controller = createShutdownController({
    name: 'API Executor',
    logger: log,
    onShutdown: async () => {
      if (unsubscribeApiCatalog) await unsubscribeApiCatalog();
      await runtime.stop();
      await quitRedisWithTimeout(redisAbortSub);
      await quitRedisWithTimeout(redisSub);
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisSub, () => controller.shuttingDown, log);

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
  log.debug(resolved.reason);

  // Build dependencies
  const deps: ExecutorDependencies = {
    redis,
    redisBlocking,
    redisSubscriber: redisAbortSub,
    payloadStore,
  };

  // Create executor runtime
  const config = getConfig();
  const runtime = new ExecutorRuntime(config, deps);

  // Signal handlers wire onShutdown → runtime.stop(); attach only after runtime exists.
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  // Register handlers
  const databaseUrl = process.env['DATABASE_URL'];
  const db = databaseUrl ? createDatabase({ connectionString: databaseUrl }).db : undefined;
  const apiHandler = new ApiCallHandler({ db, redis, payloadStore });
  runtime.registerHandler(apiHandler);

  // Subscribe to API catalog invalidation (Pub/Sub) so definition/binding/credential
  // mutations in the server or orchestrator clear this executor's in-memory cache.
  const unsubscribeApiCatalog = await subscribeApiCatalogInvalidation(redisSub, (msg) => {
    log.info('API catalog invalidation received', {
      tenantId: msg.tenantId,
      spaceId: msg.spaceId,
      kind: msg.kind,
    });
    apiHandler.invalidateSpace(msg.tenantId, msg.spaceId);
  });

  // Start the executor
  await runtime.start();

  log.info('API Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
  });
}

main().catch((error: unknown) => {
  const log = createServiceLogger('api-executor');
  log.error('Failed to start API Executor', { error });
  process.exit(1);
});
