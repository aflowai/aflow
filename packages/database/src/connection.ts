/**
 * Database connection management for PostgreSQL.
 * Handles connection pooling and configuration.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  assessPoolHeadroom,
  poolHeadroomWarning,
  serverCapacityDrift,
  resolveOtherServiceConnections,
  fleetBasisNote,
} from './poolHeadroom.js';
import { serverMaxConnectionsFromEnv } from './connectionBudget.js';
import { createReplaceablePool } from './replaceablePool.js';

// ============================================================================
// Configuration
// ============================================================================

export interface DatabaseConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Maximum number of connections in the pool */
  maxConnections?: number;
  /** Idle timeout in seconds */
  idleTimeout?: number;
  /** Connect timeout in seconds */
  connectTimeout?: number;
  /** Enable SSL */
  ssl?: boolean | 'require' | 'prefer';
}

/**
 * The pool size for this process, from the environment.
 *
 * Both constructors resolve it HERE. They did not: `getDatabaseConfig` read
 * `DB_MAX_CONNECTIONS` while `createDatabase` defaulted to a literal 20 of its
 * own, so a caller passing only a connection string got twenty connections no
 * matter what the fleet had allocated it — and four executors do exactly that.
 * The launcher's assignment reached the processes and then did nothing.
 *
 * In production the unset fallback is ONE. Every production service is sized
 * explicitly, so falling back at all means a process nobody budgeted, and the
 * declared plan leaves it almost no room: the fleet already holds 17 of the 19
 * servable connections, so a stray process helping itself to five would reach
 * past the budget and into the reserve the migration job runs on — the exact
 * exhaustion this arithmetic exists to prevent. One connection lets such a
 * process work, slowly, without taking the deploy down with it.
 *
 * Outside production the database is not the scarce resource and the fallback
 * stays generous, since dev and tests size nothing.
 */
export function resolvePoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DB_MAX_CONNECTIONS'];
  if (raw !== undefined && raw.trim() !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return env['NODE_ENV'] === 'production' ? 1 : 20;
}

/**
 * Get database configuration from environment.
 */
export function getDatabaseConfig(): DatabaseConfig {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const config: DatabaseConfig = {
    connectionString,
    maxConnections: resolvePoolMax(),
    idleTimeout: process.env['DB_IDLE_TIMEOUT'] ? parseInt(process.env['DB_IDLE_TIMEOUT'], 10) : 30,
    connectTimeout: process.env['DB_CONNECT_TIMEOUT']
      ? parseInt(process.env['DB_CONNECT_TIMEOUT'], 10)
      : 10,
  };

  // Enable SSL: explicit setting, connection string hint, or production
  // default. Managed providers such as Cloud SQL reject unencrypted
  // connections, so production infers it.
  //
  // An explicit `DB_SSL` decides either way, because the inferred default is
  // wrong for a deployment whose database is not reachable from outside its
  // own network — a self-hosted stack on a private Compose network has nothing
  // to terminate TLS, and without a way to say so it cannot connect at all.
  const explicitSsl = process.env['DB_SSL']?.trim();
  const inferSsl =
    process.env['NODE_ENV'] === 'production' ||
    connectionString.includes('sslmode=require') ||
    connectionString.includes('sslmode=verify');

  if (explicitSsl === 'true' || (explicitSsl !== 'false' && inferSsl)) {
    config.ssl = 'require';
  } else if (explicitSsl === 'false') {
    // Set, not omitted. postgres.js maps `sslmode` out of the connection
    // string into its own `ssl` option, so leaving this undefined would let a
    // URL carrying `sslmode=require` reinstate exactly what was turned off.
    config.ssl = false;
  }

  return config;
}

// ============================================================================
// Connection Pool
// ============================================================================

/**
 * How this process identifies itself to Postgres.
 *
 * `pg_stat_activity.application_name` is the only thing that tells one Phoenix
 * service's connections from another's on a shared database, which is what lets
 * the headroom check below count what the REST of the fleet holds rather than
 * take a hand-configured guess for it. It doubles as the answer to "who is
 * holding these connections" when the database is near its limit.
 */
function applicationName(): string {
  return `phoenix-${process.env['PHOENIX_PROFILE'] ?? 'unknown'}`;
}

let _sql: postgres.Sql | null = null;
let _db: PostgresJsDatabase | null = null;

/**
 * Server notices, minus the ones idempotent DDL raises for what it skipped.
 *
 * The client prints every notice by default, and `IF NOT EXISTS` / `IF EXISTS`
 * raise one per object they pass over ("relation … already exists, skipping"),
 * which buried a migration run's real output under hundreds of them. Anything
 * else is kept, on one line: a migration's own RAISE NOTICE is how it records
 * what an operator has to act on.
 */
function logServerNotice(notice: postgres.Notice): void {
  const message = notice['message'] ?? '';
  if (message.endsWith(', skipping')) return;
  console.warn(`[db] ${notice['severity'] ?? 'NOTICE'}: ${message}`);
}

/**
 * One client for `cfg`, replaceable once its connections are lost
 * (`replaceablePool.ts`). Both constructors build through it.
 */
function openClient(cfg: DatabaseConfig, poolMax: number): postgres.Sql {
  return createReplaceablePool((onclose) =>
    postgres(cfg.connectionString, {
      max: poolMax,
      idle_timeout: cfg.idleTimeout ?? 30,
      connect_timeout: cfg.connectTimeout ?? 10,
      prepare: true,
      ...(cfg.ssl !== undefined ? { ssl: cfg.ssl } : {}),
      connection: { application_name: applicationName() },
      onnotice: logServerNotice,
      onclose,
    }),
  ).sql;
}

/**
 * Get or create the database connection pool.
 */
export function getConnection(config?: DatabaseConfig): postgres.Sql {
  if (_sql) {
    return _sql;
  }

  const cfg = config ?? getDatabaseConfig();
  const poolMax = cfg.maxConnections ?? resolvePoolMax();
  _sql = openClient(cfg, poolMax);

  void reportPoolHeadroom(_sql, poolMax);

  return _sql;
}

/**
 * Get or create the Drizzle database instance.
 */
export function getDatabase(config?: DatabaseConfig): PostgresJsDatabase {
  if (_db) {
    return _db;
  }

  const sql = getConnection(config);
  _db = drizzle(sql);

  return _db;
}

/** A non-negative integer from the environment, or the fallback. */
function envCount(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Connections the rest of the fleet is holding against this database.
 *
 * Measured, not configured: the worker hosts identify themselves with a
 * different `application_name`, so what they hold can be counted instead of
 * guessed. Sibling instances of THIS service are deliberately excluded — they
 * are already counted as `poolMax x instances`, and counting them twice is what
 * makes the check cry wolf.
 *
 * It is a reading taken at boot, so it describes the fleet as it is now rather
 * than at its peak; `DB_FLEET_RESERVED_CONNECTIONS` overrides it where that
 * peak is known.
 */
async function measureOtherServiceConnections(sql: postgres.Sql): Promise<number | null> {
  try {
    const rows = await sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND application_name <> ${applicationName()}
    `;
    const n = (rows[0] as { n?: number } | undefined)?.n;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    // A role without visibility into other backends still gets a check, just a
    // more optimistic one.
    return null;
  }
}

async function reportPoolHeadroom(sql: postgres.Sql, poolMax: number): Promise<void> {
  try {
    const rows = await sql`SHOW max_connections`;
    const raw = (rows[0] as Record<string, unknown> | undefined)?.['max_connections'];
    const maxConnections = Number(raw);
    if (!Number.isFinite(maxConnections) || maxConnections <= 0) return;

    // Measured unconditionally, cheap as it is. Skipping the read whenever the
    // variable is merely PRESENT is what made a malformed one dangerous: the
    // resolver rejects the junk and then has no reading to fall back to, so a
    // typo silently turned the check optimistic and reported that it knew
    // nothing — the one outcome worse than either real answer.
    const fleet = resolveOtherServiceConnections({
      configured: process.env['DB_FLEET_RESERVED_CONNECTIONS'],
      measured: await measureOtherServiceConnections(sql),
    });

    const opts = {
      poolMax,
      instances: Math.max(1, envCount('PHOENIX_MAX_INSTANCES', 1)),
      maxConnections,
      otherServices: fleet.value,
    };
    const headroom = assessPoolHeadroom(opts);
    if (!headroom.fits) {
      console.warn(`${poolHeadroomWarning(opts, headroom)} ${fleetBasisNote(fleet.basis)}`);
    }

    const drift = serverCapacityDrift({
      declared: serverMaxConnectionsFromEnv(),
      actual: maxConnections,
    });
    if (drift) console.warn(drift.message);
  } catch {
    // Never block startup on a diagnostic.
  }
}

/**
 * Close the database connection pool.
 * Should be called during graceful shutdown.
 */
export async function closeConnection(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _db = null;
  }
}

/**
 * Create a new database instance with a specific config.
 * Useful for testing or multiple database connections.
 */
export function createDatabase(config: DatabaseConfig): {
  sql: postgres.Sql;
  db: PostgresJsDatabase;
  close: () => Promise<void>;
} {
  const poolMax = config.maxConnections ?? resolvePoolMax();
  const sqlClient = openClient(config, poolMax);

  const db = drizzle(sqlClient);

  // Both construction paths report, because they are not interchangeable:
  // `phoenix-core` — the service whose instance ceiling this exists to protect —
  // builds its client here rather than through `getConnection`, so a check
  // wired only to the singleton would never run where it matters.
  void reportPoolHeadroom(sqlClient, poolMax);

  return {
    sql: sqlClient,
    db,
    close: async () => {
      await sqlClient.end();
    },
  };
}
