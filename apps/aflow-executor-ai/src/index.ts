/**
 * AI Executor Service
 * Processes ai.* step jobs (LLM generation, embeddings, etc.).
 * Also runs memory embedding worker when ROLE=memory-embedder or ROLE=all.
 */
// Must precede all other imports so Sentry can patch redis/pg before they load.
import './instrument.js';
import {
  ExecutorRuntime,
  DEFAULT_EXECUTOR_CONFIG,
  getDefaultPendingTimeoutMs,
  type ExecutorConfig,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import type { Redis } from 'ioredis';
import {
  getRedisConnection,
  closeRedisConnection,
  createRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  quitRedisWithTimeout,
  attachRedisErrorGuard,
  subscribeApiCatalogInvalidation,
  type BlockingRedisConnection,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys, ConsumerGroups, type TenantId } from '@aflow/schemas';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  providerCredentials,
} from '@aflow/database';
import { sql } from 'drizzle-orm';

import { createServiceLogger } from '@aflow/executor-runtime';

import { AiHandler } from './handlers/ai/index.js';
import {
  initCredentialResolver,
  getCredentialResolver,
  invalidateAllCredentialCaches,
} from './handlers/ai/aiClient.js';
// SearchHandler is lazy-loaded below — its submodules may not be compiled in Docker builds.
import { MemoryEmbedder } from './workers/memoryEmbedder.js';

const log = createServiceLogger('ai-executor');

// ============================================================================
// Configuration
// ============================================================================

function getAiConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `ai-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('ai'),
    streamKey: StreamKeys.jobStream('ai'),
    stepType: 'ai',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '20', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '120000', 10),
    pendingTimeoutMs: getDefaultPendingTimeoutMs('ai'),
  };
}

function getSearchConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `ai-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: `${hostname}-search`,
    consumerGroup: ConsumerGroups.executor('search'),
    streamKey: StreamKeys.jobStream('search'),
    stepType: 'search',
    concurrency: 10,
    defaultTimeoutMs: 30_000,
    pendingTimeoutMs: getDefaultPendingTimeoutMs('search'),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Determine role from environment
  const role = process.env['ROLE'] ?? 'step-executor';
  const shouldRunStepExecutor = role === 'step-executor' || role === 'all';
  const shouldRunMemoryEmbedder = role === 'memory-embedder' || role === 'all';

  log.info('Starting AI Executor...', { role });

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `ai-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `ai-executor-${String(process.pid)}-subscriber`,
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

  // Every role of this executor needs the database: the embedder reads its
  // queue from it, and a media render is filed as a Memory document by the
  // operation that paid the provider — so a step lane without one turns every
  // render into a paid failure discovered one call at a time.
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    log.error('DATABASE_URL is required for the AI executor', { role });
    process.exit(1);
  }
  const database = createDatabase({ connectionString: DATABASE_URL });
  log.info('Database connection established');

  // Build dependencies
  const deps: ExecutorDependencies = {
    redis,
    redisBlocking,
    redisSubscriber,
    payloadStore,
  };

  if (shouldRunStepExecutor) {
    const db = database.db;

    initCredentialResolver(async (tenantId, providerId) => {
      const tenantContext = createTenantContext(tenantId as TenantId);
      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .select()
            .from(providerCredentials)
            .where(sql`${providerCredentials.providerId} = ${providerId}`);
        });
        return (rows as Array<typeof providerCredentials.$inferSelect>).map((r) => ({
          id: r.id,
          providerId: r.providerId,
          scope: r.scope,
          scopeId: r.scopeId,
          encryptedSecrets: r.encryptedSecrets,
          configJson: (r.configJson ?? {}) as Record<string, unknown>,
          status: r.status ?? 'active',
          updatedAt: r.updatedAt.toISOString(),
        }));
      } catch {
        // Table may not exist yet (migration 23 not applied) — return empty
        return [];
      }
    });
    log.info('Credential resolver initialized (BYOK Plan 67)');
  }

  // Subscribe to credential invalidation (Pub/Sub) so credential mutations
  // in the server clear this executor's in-memory caches immediately.
  let redisSub: Redis | null = null;
  let unsubscribeCredentials: (() => Promise<void>) | null = null;
  if (shouldRunStepExecutor && getCredentialResolver()) {
    redisSub = createRedisConnection({
      ...getExecutorRedisConfig(),
      connectionName: `ai-executor-${String(process.pid)}-subscriber`,
    });
    unsubscribeCredentials = await subscribeApiCatalogInvalidation(redisSub, (msg) => {
      if (msg.kind === 'credential') {
        log.info(`Credential invalidation received for tenant ${msg.tenantId}`);
        invalidateAllCredentialCaches(msg.tenantId);
      }
    });
  }

  // Create AI executor runtime (for ai.* step jobs)
  let aiRuntime: ExecutorRuntime | null = null;
  if (shouldRunStepExecutor) {
    const config = getAiConfig();
    aiRuntime = new ExecutorRuntime(config, deps);
    aiRuntime.registerHandler(new AiHandler({ payloadStore, redis, db: database.db }));
  }

  // Create Search executor runtime (for search.* step jobs)
  // Colocated in the same process — separate ExecutorRuntime consuming aflow:jobs:search
  // Search always starts (credentials resolved per-request via BYOK, not at startup)
  let searchRuntime: ExecutorRuntime | null = null;
  let redisBlockingSearch: BlockingRedisConnection | null = null;
  if (shouldRunStepExecutor) {
    redisBlockingSearch = createBlockingRedisConnection(
      `ai-executor-${String(process.pid)}-search-blocking`,
      getExecutorRedisConfig(),
    );
    const searchDeps: ExecutorDependencies = {
      redis,
      redisBlocking: redisBlockingSearch,
      payloadStore,
    };
    const searchConfig = getSearchConfig();
    searchRuntime = new ExecutorRuntime(searchConfig, searchDeps);

    const resolver = getCredentialResolver();
    if (resolver) {
      try {
        const { SearchHandler } = await import('./handlers/search/index.js');
        searchRuntime.registerHandler(
          new SearchHandler({
            credentialResolver: resolver,
            payloadStore,
            redis,
            db: database.db,
          }),
        );
      } catch (err) {
        log.warn('Search handler not available — search executor will not process steps.', {
          error: err instanceof Error ? err.message : '',
        });
      }
    } else {
      log.warn('Credential resolver not available — search executor will not process steps.');
    }
  }

  // Create memory embedder (for embedding worker)
  //
  let memoryEmbedder: MemoryEmbedder | null = null;
  let memoryEmbedderBlockingRedis: BlockingRedisConnection | null = null;
  if (shouldRunMemoryEmbedder) {
    memoryEmbedderBlockingRedis = createBlockingRedisConnection(
      `ai-memory-embedder-${String(process.pid)}`,
      getExecutorRedisConfig(),
    );
    memoryEmbedder = new MemoryEmbedder({
      redis,
      blockingRedis: memoryEmbedderBlockingRedis,
      payloadStore,
      db: database.db,
    });
  }

  const controller = createShutdownController({
    name: 'AI Executor',
    logger: log,
    onShutdown: async () => {
      if (aiRuntime) await aiRuntime.stop();
      if (searchRuntime) {
        await searchRuntime.stop();
        if (redisBlockingSearch) await quitRedisWithTimeout(redisBlockingSearch);
      }
      if (unsubscribeCredentials) await unsubscribeCredentials();
      if (redisSub) await quitRedisWithTimeout(redisSub);
      if (memoryEmbedder) await memoryEmbedder.stop();
      if (memoryEmbedderBlockingRedis) await quitRedisWithTimeout(memoryEmbedderBlockingRedis);
      await database.close();
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  // Start AI step executor
  if (aiRuntime) {
    await aiRuntime.start();
    const config = getAiConfig();
    log.info('AI Step Executor started', {
      pid: process.pid,
      consumer: config.consumerName,
      group: config.consumerGroup,
      stream: config.streamKey,
      concurrency: config.concurrency,
    });
  }

  // Start search step executor
  if (searchRuntime) {
    await searchRuntime.start();
    const config = getSearchConfig();
    log.info('Search Step Executor started', {
      pid: process.pid,
      consumer: config.consumerName,
      group: config.consumerGroup,
      stream: config.streamKey,
      concurrency: config.concurrency,
    });
  }

  // Start memory embedder
  if (memoryEmbedder) {
    await memoryEmbedder.start();
    log.info('Memory Embedder started', { pid: process.pid });
  }
}

main().catch((error: unknown) => {
  log.error('Failed to start AI Executor', { error: String(error) });
  process.exit(1);
});
