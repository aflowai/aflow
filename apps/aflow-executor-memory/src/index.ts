/**
 * Memory Executor Service (v2)
 *
 * Processes memory operations:
 * - memory.store.query  (list / search / grep)
 * - memory.store.get    (stat / preview / content)
 * - memory.store.put    (create / upsert)
 * - memory.store.patch  (json_patch / text_patch)
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
import { MemoryHandler } from './handlers/memory/index.js';
import { MemoryDocEmbedder } from './embedder.js';

// Configuration from environment — use getDatabaseConfig() for SSL support
const DATABASE_URL = process.env['DATABASE_URL'];

function getConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `memory-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('memory'),
    streamKey: StreamKeys.jobStream('memory'),
    stepType: 'memory',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '20', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '30000', 10),
  };
}

const log = createServiceLogger('memory-executor');

async function main() {
  log.info('Starting Memory Executor...');

  // Validate required configuration
  if (!DATABASE_URL) {
    log.error('DATABASE_URL is required for memory executor');
    process.exit(1);
  }

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `memory-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `memory-executor-${String(process.pid)}-subscriber`,
  });

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

  // Initialize Database (getDatabaseConfig picks up SSL settings)
  const database = createDatabase(getDatabaseConfig());

  // Dedicated Redis connection for the embedder's blocking XREADGROUP calls.
  // CRITICAL: The embedder must NOT share the main `redis` connection because
  // XREADGROUP BLOCK 5000 monopolises the connection for up to 5 seconds,
  // stalling every other Redis command (executor heartbeats, step state
  // updates, payload reads/writes, result emission) queued behind it.
  //
  const embedderRedis = createBlockingRedisConnection(
    `memory-embedder-${String(process.pid)}`,
    getExecutorRedisConfig(),
  );

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

  // Register the memory handler
  const memoryHandler = new MemoryHandler(database.db, redis, payloadStore);
  runtime.registerHandler(memoryHandler);

  // Start the embedding worker as a background loop
  const embedder = new MemoryDocEmbedder({
    redis: embedderRedis,
    db: database.db,
    sqlClient: database.sql,
    budgetRedis: redis,
  });

  const controller = createShutdownController({
    name: 'Memory Executor',
    logger: log,
    onShutdown: async () => {
      await embedder.stop();
      await runtime.stop();
      await database.close();
      await quitRedisWithTimeout(embedderRedis);
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);
  attachRedisErrorGuard(embedderRedis, () => controller.shuttingDown, log);
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  void embedder.start().catch((err: unknown) => {
    log.error('MemoryDocEmbedder failed to start', { error: err });
  });

  // Start the executor
  await runtime.start();

  log.info('Memory Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
  });
}

main().catch((error: unknown) => {
  log.error('Failed to start Memory Executor', { error });
  process.exit(1);
});
