/**
 * Application context - shared dependencies for all routes.
 *
 * This provides access to:
 * - Database connections
 * - Redis client
 * - Payload store
 * - Services (run, flow, etc.)
 */
// Use 'unknown' for db type to avoid drizzle-orm version conflicts
// The actual type is PostgresJsDatabase from @aflow/database
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { PayloadStore } from '@aflow/payload-store';
import type { PubSubSubscriber, PubSubPublisher } from './pubsub.js';

// ============================================================================
// Types
// ============================================================================

export interface AppContext {
  /** Database connection (PostgresJsDatabase from @aflow/database) */
  db: unknown;
  /** Raw postgres-js client backing the same pool as `db` (postgres.Sql from
   *  @aflow/database). Typed `unknown` for the same drizzle-version reason
   *  as `db`. Used by raw-SQL paths like space purge. */
  sql: unknown;
  /** Redis client */
  redis: Redis | null;
  /** GCS payload store */
  payloadStore: PayloadStore | null;
  /** Pub/Sub publisher for event notifications */
  pubsubPublisher: PubSubPublisher | null;
  /** Pub/Sub subscriber for event notifications */
  pubsubSubscriber: PubSubSubscriber | null;
  /** Redis URL for creating additional connections */
  redisUrl: string | null;
  /** Whether we're in mock mode */
  isMock: boolean;
  /** Cleanup function */
  close?: (() => Promise<void>) | undefined;
}

// ============================================================================
// Fastify Decorations
// ============================================================================

declare module 'fastify' {
  interface FastifyInstance {
    appContext: AppContext;
  }
}

// ============================================================================
// Context Creation
// ============================================================================

/**
 * Create application context from environment.
 * Call this during server startup.
 */
export async function createAppContext(): Promise<AppContext> {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];

  // If no database URL, return mock context
  if (!databaseUrl) {
    return createMockAppContext();
  }

  // Database: the process-wide pool, not a second one of this context's own.
  // Routes reach for `getDatabase()` directly — the health probe among them —
  // so building a private pool here left every server instance holding two,
  // and the connection budget counts one per process.
  const { getConnection, getDatabase, closeConnection } = await import('@aflow/database');
  const database = {
    sql: getConnection(),
    db: getDatabase(),
    close: closeConnection,
  };

  // Redis (optional). Built through the shared helper rather than from the URL
  // directly: everything the connection needs beyond a host — AUTH password,
  // TLS certificate verification, retry policy — is applied there, and a
  // client constructed here from the bare URL silently has none of it.
  let redis: Redis | null = null;
  if (redisUrl || process.env['REDIS_HOST']) {
    const { getRedisConnection } = await import('@aflow/redis');
    redis = getRedisConnection();
  }

  // The in-memory store is not offered here: it is process-local, and every
  // payload this process reads was written by another one.
  const { resolvePayloadStore } = await import('@aflow/payload-store');
  const resolvedPayloadStore = resolvePayloadStore({ redis });
  const payloadStore: PayloadStore | null = resolvedPayloadStore?.store ?? null;
  if (resolvedPayloadStore) {
    console.info(`[server] ${resolvedPayloadStore.reason}`);
  }

  // Flow execution service (requires both db and redis)
  let pubsubPublisher: PubSubPublisher | null = null;
  let pubsubSubscriber: PubSubSubscriber | null = null;

  // Gated on the connection, not on which variable described it — a host/port
  // configuration yields a working client with no URL, and pub/sub silently
  // not starting there would disable RBAC invalidation without saying so.
  if (redis) {
    const { createPubSubPublisher, createPubSubSubscriber } = await import('./pubsub.js');
    pubsubPublisher = createPubSubPublisher(redis);
    pubsubSubscriber = createPubSubSubscriber();
  }

  return {
    db: database.db,
    sql: database.sql,
    redis,
    payloadStore,
    pubsubPublisher,
    pubsubSubscriber,
    redisUrl: redisUrl ?? null,
    isMock: false,
    close: async () => {
      await database.close();
      if (pubsubSubscriber) {
        await pubsubSubscriber.close();
      }
      if (redis) {
        await redis.quit();
      }
    },
  };
}

/**
 * Create a mock context for development/testing.
 */
export function createMockAppContext(): AppContext {
  return {
    db: null,
    sql: null,
    redis: null,
    payloadStore: null,
    pubsubPublisher: null,
    pubsubSubscriber: null,
    redisUrl: null,
    isMock: true,
  };
}

/**
 * Register the application context as a Fastify plugin.
 */
export async function registerAppContext(
  fastify: FastifyInstance,
  options: { useMock?: boolean } = {},
): Promise<void> {
  let context: AppContext;

  if (options.useMock || process.env['USE_MOCK_CONTEXT'] === 'true') {
    fastify.log.warn('Using mock application context - no database or Redis connections');
    context = createMockAppContext();
  } else {
    try {
      context = await createAppContext();
      if (context.isMock) {
        fastify.log.warn('No DATABASE_URL set - using mock application context');
      } else {
        fastify.log.info('Application context initialized with database and Redis');
      }
    } catch (err) {
      fastify.log.error({ err }, 'Failed to create application context, falling back to mock');
      context = createMockAppContext();
    }
  }

  // Decorate fastify with the context
  fastify.decorate('appContext', context);

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    if (context.close) {
      await context.close();
    }
  });
}
