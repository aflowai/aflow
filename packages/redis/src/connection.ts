/**
 * Redis connection management.
 * Uses ioredis for Redis Streams and general Redis operations.
 */
import { Redis, type RedisOptions } from 'ioredis';

// ============================================================================
// Configuration
// ============================================================================

export interface RedisConfig {
  /** Redis connection URL (redis://host:port) */
  url?: string;
  /** Redis host */
  host?: string;
  /** Redis port */
  port?: number;
  /** Redis password */
  password?: string;
  /** Redis database number */
  db?: number;
  /** Connection name for debugging */
  connectionName?: string;
  /** TCP keepalive probe interval in ms. `0` (ioredis's default) disables it. */
  keepAlive?: number;
  /** Enable TLS */
  tls?: boolean;
  /** Max retries on connection failure */
  maxRetriesPerRequest?: number;
  /** Enable read-only mode */
  readOnly?: boolean;
  enableOfflineQueue?: boolean;
  /**
   * ioredis issues `INFO` on connect to decide readiness. A connection that only
   * subscribes rejects that command once it is in subscriber mode, so the check
   * has to be off there.
   */
  enableReadyCheck?: boolean;
}

/**
 * Get Redis configuration from environment.
 */
export function getRedisConfig(): RedisConfig {
  const url = process.env['REDIS_URL'];

  if (url) {
    const config: RedisConfig = {
      url,
      maxRetriesPerRequest: 3,
    };
    // Kept out of the URL on purpose: the URL is an ordinary env var naming a
    // host, while the password belongs in a secret. Embedding it would also
    // drag in percent-encoding of whatever characters the provider generates.
    const password = process.env['REDIS_PASSWORD'];
    if (password) {
      config.password = password;
    }
    const connectionName = process.env['REDIS_CONNECTION_NAME'];
    if (connectionName) {
      config.connectionName = connectionName;
    }
    return config;
  }

  const config: RedisConfig = {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: process.env['REDIS_PORT'] ? parseInt(process.env['REDIS_PORT'], 10) : 6379,
    db: process.env['REDIS_DB'] ? parseInt(process.env['REDIS_DB'], 10) : 0,
    tls: process.env['REDIS_TLS'] === 'true',
    maxRetriesPerRequest: 3,
  };

  const password = process.env['REDIS_PASSWORD'];
  if (password) {
    config.password = password;
  }

  const connectionName = process.env['REDIS_CONNECTION_NAME'];
  if (connectionName) {
    config.connectionName = connectionName;
  }

  return config;
}

export function getExecutorRedisConfig(base?: RedisConfig): RedisConfig {
  const cfg = base ?? getRedisConfig();
  return {
    ...cfg,
    maxRetriesPerRequest: 1,
  };
}

/**
 * Convert our config to ioredis options.
 */
function configToRedisOptions(config: RedisConfig): RedisOptions {
  const options: RedisOptions = {
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  };

  if (config.connectionName) {
    options.connectionName = config.connectionName;
  }

  if (config.keepAlive !== undefined) {
    options.keepAlive = config.keepAlive;
  }

  if (config.enableOfflineQueue !== undefined) {
    options.enableOfflineQueue = config.enableOfflineQueue;
  }

  if (config.enableReadyCheck !== undefined) {
    options.enableReadyCheck = config.enableReadyCheck;
  }

  if (config.url) {
    // ioredis merges these over anything parsed out of the URL.
    if (config.password) {
      options.password = config.password;
    }

    if (config.url.startsWith('rediss://')) {
      // Some managed providers (Heroku Key-Value Store) present a certificate
      // with no publicly trusted chain, so verification has to be opt-out —
      // but skipping it makes the TLS connection interceptable, which is the
      // whole point of using `rediss://`. It must therefore be a deliberate,
      // named decision per deployment rather than the default.
      options.tls = { rejectUnauthorized: process.env['REDIS_TLS_INSECURE'] !== 'true' };
    }
  } else {
    options.host = config.host ?? 'localhost';
    options.port = config.port ?? 6379;
    options.db = config.db ?? 0;

    if (config.password) {
      options.password = config.password;
    }

    if (config.tls) {
      options.tls = {};
    }
  }

  return options;
}

// ============================================================================
// Connection Pool
// ============================================================================

let _redis: Redis | null = null;

/**
 * Get or create the Redis connection for regular operations.
 * This connection should NOT be used for blocking commands (XREADGROUP BLOCK, BRPOP, etc.)
 */
export function getRedisConnection(config?: RedisConfig): Redis {
  if (_redis) {
    return _redis;
  }

  const cfg = config ?? getRedisConfig();

  if (cfg.url) {
    _redis = new Redis(cfg.url, configToRedisOptions(cfg));
  } else {
    _redis = new Redis(configToRedisOptions(cfg));
  }

  return _redis;
}

// ============================================================================

declare const blockingBrand: unique symbol;

export type BlockingRedisConnection = Redis & { readonly [blockingBrand]: 'blocking' };

export function createBlockingRedisConnection(
  connectionName: string,
  config?: RedisConfig,
): BlockingRedisConnection {
  if (!connectionName || connectionName.trim().length === 0) {
    throw new Error(
      'createBlockingRedisConnection requires a non-empty connectionName for CLIENT LIST visibility',
    );
  }

  const cfg = { ...(config ?? getRedisConfig()), connectionName };
  const conn = cfg.url
    ? new Redis(cfg.url, configToRedisOptions(cfg))
    : new Redis(configToRedisOptions(cfg));

  return conn as BlockingRedisConnection;
}

export function streamIdToTimestampMs(id: string): number | null {
  if (!id || id === '-' || id === '+') return null;
  const dashIdx = id.indexOf('-');
  const tsRaw = dashIdx === -1 ? id : id.slice(0, dashIdx);
  const ts = Number(tsRaw);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/** Default timeout for Redis quit during shutdown (ms). */
const REDIS_QUIT_TIMEOUT_MS = 2000;

export async function quitRedisWithTimeout(
  redis: Redis,
  timeoutMs: number = REDIS_QUIT_TIMEOUT_MS,
): Promise<void> {
  try {
    await Promise.race([
      redis.quit(),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(new Error('quit timeout'));
        }, timeoutMs),
      ),
    ]);
  } catch {
    try {
      redis.disconnect(false);
    } catch {
      // Ignore disconnect errors during teardown
    }
  }
}

/**
 * For callers with no logger in scope. Still deliberate output rather than
 * ioredis' own unhandled-error fallback, which is the thing being replaced.
 */
const consoleErrorGuardLogger: RedisErrorGuardLogger = {
  debug: (message, data) => {
    console.debug(message, data ?? '');
  },
  error: (message, data) => {
    console.error(message, data ?? '');
  },
};

export interface RedisErrorGuardLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function attachRedisErrorGuard(
  redis: Redis,
  getShuttingDown: () => boolean,
  logger: RedisErrorGuardLogger,
): void {
  redis.on('error', (err: Error) => {
    if (getShuttingDown()) {
      logger.debug('Redis error during shutdown (suppressed)', {
        message: err.message,
      });
    } else {
      logger.error('Redis error', { error: err.message });
    }
  });
}

/**
 * Close the singleton regular Redis connection with graceful quit +
 * timeout fallback. Per-consumer blocking connections minted via
 * `createBlockingRedisConnection` are NOT managed here — callers close
 * them explicitly with `quitRedisWithTimeout` after stopping their loop.
 */
export async function closeRedisConnection(): Promise<void> {
  if (!_redis) return;
  const r = _redis;
  _redis = null;
  await quitRedisWithTimeout(r);
}

/**
 * Create a new Redis connection with specific config.
 * Useful for testing or multiple connections.
 */
/**
 * A connection that will only ever subscribe.
 *
 * Two things differ from an ordinary connection, and both follow from what a
 * subscriber cannot do.
 *
 * `enableReadyCheck` issues `INFO` on every connect, and a connection already in
 * subscriber mode rejects every non-subscriber command — so a subscriber that
 * drops and reconnects raises an error describing nothing about its health. The
 * check has no value here anyway: this connection will never issue a command
 * whose readiness it could report on.
 *
 * And without an `error` listener ioredis logs its own unhandled-error line,
 * which makes a genuine failure — auth, TLS, a dead node — indistinguishable
 * from that benign reconnect.
 */
/**
 * Well inside the shortest idle timeouts in the path (cloud NAT is typically
 * 10 minutes; Redis providers often 5), so the socket is proven live long
 * before anything upstream would reclaim it.
 */
const SUBSCRIBER_KEEPALIVE_MS = 60_000;

export function createSubscriberConnection(
  config: RedisConfig,
  logger: RedisErrorGuardLogger = consoleErrorGuardLogger,
  getShuttingDown: () => boolean = () => false,
): Redis {
  // Keepalive travels in the constructor options, not as a later assignment:
  // the client connects eagerly, so the first socket — the long-lived one this
  // exists to protect — would already have been created with the old value.
  //
  // A subscriber connection is idle whenever no events flow, which is exactly
  // when a NAT or middlebox drops it. Without keepalive the socket goes
  // half-open silently: no error, no `ready`, so no reconnect — and since
  // subscribers now drain on reconnect rather than on a timer, every session
  // watching through this connection would wait forever.
  const redis = createRedisConnection({
    ...config,
    enableReadyCheck: false,
    keepAlive: config.keepAlive ?? SUBSCRIBER_KEEPALIVE_MS,
  });
  attachRedisErrorGuard(redis, getShuttingDown, logger);
  return redis;
}

export function createRedisConnection(config: RedisConfig): Redis {
  if (config.url) {
    return new Redis(config.url, configToRedisOptions(config));
  }
  return new Redis(configToRedisOptions(config));
}

/**
 * Check if Redis is connected and responding.
 */
export async function pingRedis(redis: Redis): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
