/**
 * A real postgres.js client over `fakePostgres`, and what a test of an abrupt
 * close needs besides: a transaction whose connection the database drops, and
 * a way to see the throw postgres.js then raises from an immediate.
 */
import postgres from 'postgres';

import type { FakePostgres } from './fakePostgres.js';

type ClientOptions = postgres.Options<Record<string, postgres.PostgresType>>;

/** Short, so a connection that never comes back fails the test quickly rather than hanging it. */
const CONNECT_TIMEOUT_SECONDS = 1;

/** A client of one connection to `server`, with `options` over its defaults. */
export function fakeClient(server: FakePostgres, options: ClientOptions = {}): postgres.Sql {
  // `socket` is how postgres.js takes a connection it did not open; its types omit it.
  return postgres({
    max: 1,
    fetch_types: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    ...options,
    socket: server.socket,
  } as ClientOptions);
}

/**
 * Routes whatever a deferred callback throws to `onThrow`, as the process
 * would, and returns what puts `setImmediate` back. A test runner owns its
 * worker's uncaught exceptions, so the throw is taken before it gets there.
 */
export function deliverImmediateThrowsTo(onThrow: (error: unknown) => void): () => void {
  const realSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    realSetImmediate(() => {
      try {
        callback(...args);
      } catch (error) {
        onThrow(error);
      }
    })) as typeof setImmediate;
  return () => {
    globalThis.setImmediate = realSetImmediate;
  };
}

/**
 * A transaction whose write the database drops, settled with what it was
 * rejected with. The client then writes its ROLLBACK to the closed socket.
 */
export async function severedTransaction(
  sql: postgres.Sql,
  server: FakePostgres,
): Promise<unknown> {
  server.severOn(/^insert/i);
  return sql
    .begin(async (tx) => {
      await tx`select 1`;
      await tx`insert into step_results values (1)`;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
}
