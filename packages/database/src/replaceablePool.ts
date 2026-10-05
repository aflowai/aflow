/**
 * A Postgres client that can be exchanged for a fresh one underneath every
 * holder of it.
 *
 * postgres.js has one way to wedge a connection for good. When a connection
 * closes while a transaction holds it, `begin()` still sends its own ROLLBACK
 * through that connection, and the write runs on a later tick against the
 * socket the close has already cleared: a TypeError thrown from an immediate,
 * which no caller can catch and which ends the process. Surviving the throw is
 * not enough. The unsent bytes stay buffered on the connection and its write
 * timer stays set, so every later reconnect queues its startup message behind
 * them and never sends it, and each use of that connection costs a connect
 * timeout. Nothing outside the client can reach that state, so recovery
 * replaces the client: every holder keeps the same `sql`, and the next query
 * runs on a new pool.
 */
import type postgres from 'postgres';

/** Builds one client, calling `onclose` whenever one of its connections closes. */
export type PoolBuilder = (onclose: (connectionId: number) => void) => postgres.Sql;

export interface ReplaceablePool {
  /** Stable across replacements; this is what callers hold. */
  readonly sql: postgres.Sql;
  /**
   * Whether a connection of the current client has closed since it was built.
   * A client none of whose connections has closed cannot hold one written to
   * after its close, so it is never the one a recovery replaces.
   */
  readonly hasClosedConnection: boolean;
  replace(): void;
}

/** How long a replaced client's queries in flight get before its connections are destroyed. */
const RETIRED_CLIENT_GRACE_SECONDS = 5;

const livePools = new Set<ReplaceablePool>();

/**
 * Drizzle installs its type handlers by mutating the client it is given, once,
 * when it is constructed. A replacement has to carry them, or every timestamp
 * and JSON column read after a recovery comes back in another shape.
 */
function carryTypeHandlers(from: postgres.Sql, to: postgres.Sql): void {
  Object.assign(to.options.parsers, from.options.parsers);
  Object.assign(to.options.serializers, from.options.serializers);
}

export function createReplaceablePool(build: PoolBuilder): ReplaceablePool {
  let generation = 0;
  let closedConnection = false;
  let ended = false;

  const open = (): postgres.Sql => {
    generation += 1;
    const built = generation;
    closedConnection = false;
    return build(() => {
      if (built === generation) closedConnection = true;
    });
  };

  let current = open();

  const end = async (options?: { timeout?: number | undefined }): Promise<void> => {
    ended = true;
    livePools.delete(pool);
    await current.end(options);
  };

  // The target only lends the proxy a callable shape; every read and call goes
  // to whichever client is current at that moment.
  const target = (() => undefined) as unknown as postgres.Sql;
  const sql = new Proxy(target, {
    apply: (_target, thisArg, args: unknown[]): unknown =>
      Reflect.apply(current, thisArg, args) as unknown,
    get: (_target, property): unknown =>
      property === 'end' ? end : (Reflect.get(current, property) as unknown),
    has: (_target, property) => Reflect.has(current, property),
    set: (_target, property, value) => Reflect.set(current, property, value),
  });

  const pool: ReplaceablePool = {
    sql,
    get hasClosedConnection() {
      return closedConnection;
    },
    replace() {
      if (ended) return;
      const retired = current;
      current = open();
      carryTypeHandlers(retired, current);
      retired.end({ timeout: RETIRED_CLIENT_GRACE_SECONDS }).catch(() => undefined);
    },
  };
  livePools.add(pool);
  return pool;
}

const ABRUPT_CLOSE_MESSAGE = "Cannot read properties of null (reading 'write')";
const ABRUPT_CLOSE_FRAME = /\bnextWrite \(.*[\\/]postgres[\\/](?:cjs[\\/])?src[\\/]connection\.js:/;

/** Whether `error` is postgres.js writing to a connection it has already closed. */
export function isAbruptCloseWrite(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === ABRUPT_CLOSE_MESSAGE &&
    ABRUPT_CLOSE_FRAME.test(error.stack ?? '')
  );
}

/**
 * Replaces every client in this process that has lost a connection — the
 * only ones the write can have come from — and returns how many it replaced.
 * A stale write from a client already retired finds nothing to replace.
 */
export function replacePoolsThatLostAConnection(): number {
  let replaced = 0;
  for (const pool of livePools) {
    if (!pool.hasClosedConnection) continue;
    pool.replace();
    replaced += 1;
  }
  return replaced;
}
