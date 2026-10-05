/**
 * A client whose connection was written to after its close cannot be repaired
 * from outside, so recovery exchanges it for a new one underneath everything
 * that holds it. Stubs pin the routing; what the client does with its own
 * connections is pinned against a real postgres.js client over an in-memory
 * backend, since a stub only does what the test says the client does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

import {
  createReplaceablePool,
  isAbruptCloseWrite,
  replacePoolsThatLostAConnection,
  type PoolBuilder,
  type ReplaceablePool,
} from '../replaceablePool.js';
import {
  deliverImmediateThrowsTo,
  fakeClient,
  fakePostgres,
  severedTransaction,
  type FakePostgres,
} from '../testing/index.js';

/** Far longer than any fixed grace a replaced client's work could be given. */
const LONG_QUERY_MS = 60_000;

/** Short enough that the client closes its connection while the test waits. */
const CLIENT_CLOSE_SECONDS = 0.01;

interface StubClient {
  sql: postgres.Sql;
  end: ReturnType<typeof vi.fn>;
}

/** A client that answers every call with its own name, and records how it was ended. */
function stubBuilder(): { build: PoolBuilder; built: StubClient[] } {
  const built: StubClient[] = [];
  const build = (): postgres.Sql => {
    const name = `client-${String(built.length + 1)}`;
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(() => name, {
      options: { parsers: {}, serializers: {} },
      end,
      unsafe: () => name,
    }) as unknown as postgres.Sql;
    built.push({ sql, end });
    return sql;
  };
  return { build, built };
}

/** Real clients over `server`, counting how many have been built. */
function realBuilder(
  server: FakePostgres,
  options?: Parameters<typeof fakeClient>[1],
): { build: PoolBuilder; readonly built: number } {
  let built = 0;
  return {
    build: () => {
      built += 1;
      return fakeClient(server, options);
    },
    get built() {
      return built;
    },
  };
}

const opened: ReplaceablePool[] = [];
function open(build: PoolBuilder): ReplaceablePool {
  const pool = createReplaceablePool(build);
  opened.push(pool);
  return pool;
}

const thrown: unknown[] = [];
let restoreImmediates: (() => void) | undefined;
function collectImmediateThrows(): void {
  restoreImmediates = deliverImmediateThrowsTo((error) => thrown.push(error));
}

afterEach(async () => {
  vi.useRealTimers();
  restoreImmediates?.();
  restoreImmediates = undefined;
  thrown.length = 0;
  await Promise.all(opened.splice(0).map((pool) => pool.sql.end({ timeout: 0 })));
});

describe('a replaceable pool', () => {
  it('sends every call to the client current at the time, through the one `sql` its holders keep', () => {
    const { build } = stubBuilder();
    const pool = open(build);
    const held = pool.sql as unknown as () => string;
    const heldUnsafe = (pool.sql as unknown as { unsafe: () => string }).unsafe;

    expect(held()).toBe('client-1');
    pool.replace();
    expect(held()).toBe('client-2');
    expect((pool.sql as unknown as { unsafe: () => string }).unsafe()).toBe('client-2');
    // A method read before the replacement belongs to the retired client.
    expect(heldUnsafe()).toBe('client-1');
  });

  it('carries the type handlers installed on the client it replaces', () => {
    const { build, built } = stubBuilder();
    const pool = open(build);
    const handler = (value: unknown) => value;
    pool.sql.options.parsers[1184] = handler;
    pool.sql.options.serializers[3802] = handler;

    pool.replace();

    expect(built[1]?.sql.options.parsers[1184]).toBe(handler);
    expect(built[1]?.sql.options.serializers[3802]).toBe(handler);
  });

  it('lets a query the replaced client is running finish however long it takes, and gives new work to the new client meanwhile', async () => {
    const server = fakePostgres();
    const pool = open(realBuilder(server).build);
    await pool.sql`select 1`;
    const slow = server.holdOn(/pg_sleep/);
    const running = pool.sql`select pg_sleep(60)`.then(
      (rows) => rows.command,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(slow.received).toBe(true);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pool.replace();
    await vi.advanceTimersByTimeAsync(LONG_QUERY_MS);
    vi.useRealTimers();

    expect((await pool.sql`select 1`).command).toBe('SELECT');
    expect(server.connections).toBe(2);
    expect(server.terminations).toBe(0);

    slow.release();

    expect(await running).toBe('SELECT');
    await vi.waitFor(() => {
      expect(server.terminations).toBe(1);
    });
  });
});

describe('recovery', () => {
  it.each(['idle_timeout', 'max_lifetime'] as const)(
    'does not replace a pool whose client closed a connection at its %s',
    async (option) => {
      const server = fakePostgres();
      const clients = realBuilder(server, { [option]: CLIENT_CLOSE_SECONDS });
      const pool = open(clients.build);
      await pool.sql`select 1`;

      await vi.waitFor(() => {
        expect(server.terminations).toBe(1);
      });

      expect(pool.lostConnectionUnderTransaction).toBe(false);
      expect(replacePoolsThatLostAConnection()).toBe(0);
      expect(clients.built).toBe(1);
    },
  );

  it('replaces only the pools whose current client lost a connection under a transaction, not one whose connection closed idle', async () => {
    collectImmediateThrows();
    const lostServer = fakePostgres();
    const idleServer = fakePostgres();
    const lost = realBuilder(lostServer);
    const idle = realBuilder(idleServer, { idle_timeout: CLIENT_CLOSE_SECONDS });
    const lostPool = open(lost.build);
    const idlePool = open(idle.build);
    await idlePool.sql`select 1`;
    await vi.waitFor(() => {
      expect(idleServer.terminations).toBe(1);
    });

    await severedTransaction(lostPool.sql, lostServer);
    await vi.waitFor(() => {
      expect(thrown.filter(isAbruptCloseWrite)).toHaveLength(1);
    });

    expect(replacePoolsThatLostAConnection()).toBe(1);
    expect(lost.built).toBe(2);
    expect(idle.built).toBe(1);
  });

  it('does not count a transaction lost on a client already retired against its replacement', async () => {
    collectImmediateThrows();
    const server = fakePostgres();
    const pool = open(realBuilder(server).build);
    let resume = (): void => undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let started = false;
    server.severOn(/^insert/i);
    const transaction = pool.sql
      .begin(async (tx) => {
        await tx`select 1`;
        started = true;
        await resumed;
        await tx`insert into step_results values (1)`;
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });

    pool.replace();
    resume();

    expect(await transaction).toMatchObject({ code: 'CONNECTION_CLOSED' });
    await vi.waitFor(() => {
      expect(thrown.filter(isAbruptCloseWrite)).toHaveLength(1);
    });
    expect(pool.lostConnectionUnderTransaction).toBe(false);
    expect(replacePoolsThatLostAConnection()).toBe(0);
  });

  it('leaves alone a pool that has been ended', async () => {
    collectImmediateThrows();
    const server = fakePostgres();
    const clients = realBuilder(server);
    const pool = createReplaceablePool(clients.build);
    await severedTransaction(pool.sql, server);
    await vi.waitFor(() => {
      expect(thrown.filter(isAbruptCloseWrite)).toHaveLength(1);
    });
    expect(pool.lostConnectionUnderTransaction).toBe(true);

    await pool.sql.end({ timeout: 0 });

    expect(replacePoolsThatLostAConnection()).toBe(0);
    expect(clients.built).toBe(1);
  });
});

describe('the abrupt-close write', () => {
  const message = "Cannot read properties of null (reading 'write')";
  const withStack = (error: Error, frame: string): Error => {
    error.stack = `${error.name}: ${error.message}\n    at ${frame}\n    at process.processImmediate (node:internal/timers:485:21)`;
    return error;
  };

  it('is recognised from the client’s own write, deferred or immediate, in either build', () => {
    for (const frame of [
      'Immediate.nextWrite (file:///repo/node_modules/postgres/src/connection.js:255:22)',
      'nextWrite (/repo/node_modules/postgres/cjs/src/connection.js:255:22)',
    ]) {
      expect(isAbruptCloseWrite(withStack(new TypeError(message), frame))).toBe(true);
    }
  });

  it('is not any other null write, nor any other error from the client', () => {
    expect(
      isAbruptCloseWrite(withStack(new TypeError(message), 'flush (file:///repo/apps/x.js:1:1)')),
    ).toBe(false);
    expect(
      isAbruptCloseWrite(
        withStack(
          new TypeError("Cannot read properties of null (reading 'destroy')"),
          'Timeout.connectTimedOut (file:///repo/node_modules/postgres/src/connection.js:261:12)',
        ),
      ),
    ).toBe(false);
    expect(isAbruptCloseWrite(new Error(message))).toBe(false);
    expect(isAbruptCloseWrite(message)).toBe(false);
  });
});
