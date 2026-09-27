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
  subscribeMcpCatalogInvalidation,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';
import { createDatabase } from '@aflow/database';
import { createOauthConsentStateReaper } from './oauthConsentStateReaper.js';
import { randomUUID } from 'crypto';

import { McpHandler } from './handlers/mcpHandler.js';

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): ExecutorConfig {
  const hostnameBase = process.env['HOSTNAME'] ?? `mcp-executor-${String(process.pid)}`;
  const nonce = randomUUID().slice(0, 8);
  const hostname = `${hostnameBase}-${nonce}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('mcp'),
    streamKey: StreamKeys.jobStream('mcp'),
    stepType: 'mcp',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '10', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '60000', 10),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const log = createServiceLogger('mcp-executor');

  log.info('Starting MCP Executor...');

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `mcp-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSub = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `mcp-executor-${String(process.pid)}-subscriber`,
  });
  const redisAbortSub = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `mcp-executor-${String(process.pid)}-abort-sub`,
  });

  // Hoisted so the shutdown handler can close cleanly. The `let` here is
  // intentional — shutdown may fire during partial init (e.g. Redis
  // connect throws after the controller is built), and we want the
  // `if (x) await x.shutdown()` guard to no-op for not-yet-initialized
  // resources rather than TDZ-throw. Each is assigned exactly once below.
  /* eslint-disable prefer-const */
  let unsubscribeMcpCatalog: (() => Promise<void>) | undefined;
  let mcpHandler: McpHandler | undefined;
  let runtime: ExecutorRuntime | undefined;
  let oauthConsentStateReaper: ReturnType<typeof createOauthConsentStateReaper> | undefined;
  let elicitationSubscriberHandle: ReturnType<typeof createRedisConnection> | undefined;
  /* eslint-enable prefer-const */

  const controller = createShutdownController({
    name: 'MCP Executor',
    logger: log,
    onShutdown: async () => {
      if (oauthConsentStateReaper) await oauthConsentStateReaper.stop();
      if (unsubscribeMcpCatalog) await unsubscribeMcpCatalog();
      if (mcpHandler) await mcpHandler.shutdown();
      if (runtime) await runtime.stop();
      if (elicitationSubscriberHandle) {
        await quitRedisWithTimeout(elicitationSubscriberHandle);
      }
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
  runtime = new ExecutorRuntime(config, deps);

  // Signal handlers wire onShutdown → runtime.stop(); attach only after runtime exists.
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  // Register MCP handler with DB + redis (for managed-path resolution + cache writes).
  const databaseUrl = process.env['DATABASE_URL'];
  const dbConn = databaseUrl ? createDatabase({ connectionString: databaseUrl }) : undefined;
  const db = dbConn?.db;
  elicitationSubscriberHandle = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `mcp-executor-${String(process.pid)}-elicitation-sub`,
  });
  elicitationSubscriberHandle.setMaxListeners(0);
  attachRedisErrorGuard(elicitationSubscriberHandle, () => controller.shuttingDown, log);
  mcpHandler = new McpHandler({
    db,
    redis,
    redisSubscriber: elicitationSubscriberHandle,
    executorInstanceId: config.consumerName,
  });
  runtime.registerHandler(mcpHandler);

  if (dbConn) {
    oauthConsentStateReaper = createOauthConsentStateReaper({
      sqlClient: dbConn.sql,
      db: dbConn.db,
      log,
    });
    oauthConsentStateReaper.start();
  }

  // Subscribe to MCP catalog invalidation so server-side mutations clear the
  // in-memory tenant cache and drop any warm sessions whose auth might have
  // changed.
  unsubscribeMcpCatalog = await subscribeMcpCatalogInvalidation(redisSub, (msg) => {
    log.info('MCP catalog invalidation received', {
      tenantId: msg.tenantId,
      spaceId: msg.spaceId,
      kind: msg.kind,
      ...(msg.serverId ? { serverId: msg.serverId } : {}),
      ...(msg.bindingId ? { bindingId: msg.bindingId } : {}),
    });
    if (mcpHandler) {
      mcpHandler.invalidateSpace(msg.tenantId, msg.spaceId, {
        ...(msg.bindingId ? { bindingId: msg.bindingId } : {}),
        kind: msg.kind,
      });
    }
  });

  // Start the executor
  await runtime.start();

  log.info('MCP Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
  });
}

main().catch((error: unknown) => {
  const log = createServiceLogger('mcp-executor');
  log.error('Failed to start MCP Executor', { error });
  process.exit(1);
});
