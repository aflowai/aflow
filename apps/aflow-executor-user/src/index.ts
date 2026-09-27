/**
 * User Executor Service
 * Processes user.* step jobs (input requests, approvals, email notifications).
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
import { StreamKeys, ConsumerGroups, type TenantId } from '@aflow/schemas';
import { createDatabase, getDatabaseConfig } from '@aflow/database';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CredentialResolver } from '@aflow/credential-resolver';

import { UserHandler } from './handlers/userInputHandler.js';

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `user-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('user'),
    streamKey: StreamKeys.jobStream('user'),
    stepType: 'user',
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '20', 10),
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '30000', 10),
  };
}

// ============================================================================
// Main
// ============================================================================

const log = createServiceLogger('user-executor');

async function main(): Promise<void> {
  log.info('Starting User Executor...');

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `user-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `user-executor-${String(process.pid)}-subscriber`,
  });

  // Initialize database connection for recipient resolution
  let db;
  try {
    const dbConfig = getDatabaseConfig();
    const dbInstance = createDatabase(dbConfig);
    db = dbInstance.db;
    log.info('Database connection established for recipient resolution');
  } catch (err: unknown) {
    log.warn('Database not available — email notifications will be disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let credentialResolver: CredentialResolver | undefined;
  if (db) {
    const { createTenantContext, withTenantSchema, providerCredentials } =
      await import('@aflow/database');
    const { eq } = await import('drizzle-orm');

    credentialResolver = new CredentialResolver({
      loader: async (tenantId, providerId) => {
        const tenantContext = createTenantContext(tenantId as TenantId);
        const rows = await withTenantSchema(db as PostgresJsDatabase, tenantContext, async (tx) => {
          return tx
            .select()
            .from(providerCredentials)
            .where(eq(providerCredentials.providerId, providerId));
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
      },
    });
    log.info('Credential resolver initialized for email (BYOK Plan 67)');
  } else {
    log.info('Database not available — email will fail until credentials are configured');
  }

  const controller = createShutdownController({
    name: 'User Executor',
    logger: log,
    onShutdown: async () => {
      await runtime.stop();
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
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

  // Register handler with credential resolver for BYOK email
  runtime.registerHandler(
    new UserHandler({
      redis,
      db,
      credentialResolver,
    }),
  );

  // Start the executor
  await runtime.start();

  log.info('User Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
    email: credentialResolver ? 'BYOK (credential resolver)' : 'disabled (no DB)',
  });
}

main().catch((error: unknown) => {
  log.error('Failed to start User Executor', { error });
  process.exit(1);
});
