/**
 * A client whose connection was written to after its close cannot be repaired
 * from outside, so recovery exchanges it for a new one underneath everything
 * that holds it. These pin the exchange; the orchestrator's
 * `uncaughtException.test.ts` severs a real client mid-transaction against it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

import {
  createReplaceablePool,
  isAbruptCloseWrite,
  replacePoolsThatLostAConnection,
  type ReplaceablePool,
} from '../replaceablePool.js';

interface StubClient {
  sql: postgres.Sql;
  end: ReturnType<typeof vi.fn>;
  closeConnection: () => void;
}

/** A client that answers every call with its own name, and records how it was ended. */
function stubBuilder(): {
  build: Parameters<typeof createReplaceablePool>[0];
  built: StubClient[];
} {
  const built: StubClient[] = [];
  const build = (onclose: (connectionId: number) => void): postgres.Sql => {
    const name = `client-${String(built.length + 1)}`;
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(() => name, {
      options: { parsers: {}, serializers: {} },
      end,
      unsafe: () => name,
    }) as unknown as postgres.Sql;
    built.push({
      sql,
      end,
      closeConnection: () => {
        onclose(1);
      },
    });
    return sql;
  };
  return { build, built };
}

const opened: ReplaceablePool[] = [];
function open(build: Parameters<typeof createReplaceablePool>[0]): ReplaceablePool {
  const pool = createReplaceablePool(build);
  opened.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((pool) => pool.sql.end()));
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

  it('carries the type handlers installed on the client it replaces, and drains that client', () => {
    const { build, built } = stubBuilder();
    const pool = open(build);
    const handler = (value: unknown) => value;
    pool.sql.options.parsers[1184] = handler;
    pool.sql.options.serializers[3802] = handler;

    pool.replace();

    expect(built[1]?.sql.options.parsers[1184]).toBe(handler);
    expect(built[1]?.sql.options.serializers[3802]).toBe(handler);
    expect(built[0]?.end).toHaveBeenCalledWith({ timeout: expect.any(Number) as number });
  });
});

describe('recovery', () => {
  it('replaces only the pools whose current client has lost a connection', () => {
    const lost = stubBuilder();
    const intact = stubBuilder();
    open(lost.build);
    open(intact.build);

    lost.built[0]?.closeConnection();

    expect(replacePoolsThatLostAConnection()).toBe(1);
    expect(lost.built).toHaveLength(2);
    expect(intact.built).toHaveLength(1);
  });

  it('does not count a close from a client already retired against its replacement', () => {
    const { build, built } = stubBuilder();
    const pool = open(build);
    built[0]?.closeConnection();
    pool.replace();

    built[0]?.closeConnection();

    expect(pool.hasClosedConnection).toBe(false);
    expect(replacePoolsThatLostAConnection()).toBe(0);
  });

  it('leaves alone a pool that has been ended', async () => {
    const { build, built } = stubBuilder();
    const pool = createReplaceablePool(build);
    built[0]?.closeConnection();

    await pool.sql.end();

    expect(built[0]?.end).toHaveBeenCalledTimes(1);
    expect(replacePoolsThatLostAConnection()).toBe(0);
    expect(built).toHaveLength(1);
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
