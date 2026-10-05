/**
 * The orchestrator survives the database dropping a connection under a write.
 *
 * postgres.js answers that drop with a TypeError thrown from an immediate — its
 * own ROLLBACK, written to the socket the close cleared — which reaches the
 * process as an uncaught exception and used to end the orchestrator. Vitest
 * owns a worker's uncaught exceptions, so here the client's immediates hand
 * whatever they throw to the handler `index.ts` installs on the process, which
 * is the path the throw takes there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReplaceablePool, type ReplaceablePool } from '@aflow/database';
import {
  deliverImmediateThrowsTo,
  fakeClient,
  fakePostgres,
  severedTransaction,
  type FakePostgres,
} from '@aflow/database/testing';

import { createUncaughtExceptionHandler } from '../uncaughtException.js';

const logger = { warn: vi.fn(), error: vi.fn() };
const exit = vi.fn();
const handle = createUncaughtExceptionHandler({ logger, consumerName: 'orchestrator-test', exit });

let server: FakePostgres;
let pool: ReplaceablePool | undefined;
let restoreImmediates: (() => void) | undefined;

beforeEach(() => {
  server = fakePostgres();
  logger.warn.mockReset();
  logger.error.mockReset();
  exit.mockReset();
});

afterEach(async () => {
  restoreImmediates?.();
  restoreImmediates = undefined;
  await pool?.sql.end({ timeout: 0 });
  pool = undefined;
});

describe('a connection the database drops under a write', () => {
  it('leaves the orchestrator running, and its next query on a fresh connection', async () => {
    restoreImmediates = deliverImmediateThrowsTo(handle);
    pool = createReplaceablePool(() => fakeClient(server));
    const { sql } = pool;
    await sql`select 1`;

    const failure = await severedTransaction(sql, server);

    expect(failure).toMatchObject({ code: 'CONNECTION_CLOSED' });
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('replaced the client'),
        expect.objectContaining({ replacedClients: '1' }),
      );
    });
    expect(exit).not.toHaveBeenCalled();

    const after = await sql`select 1`;
    expect(after.command).toBe('SELECT');
    expect(server.connections).toBe(2);
  });

  // Why recovery replaces the client rather than only surviving the throw:
  // the dropped connection keeps the bytes it never sent, and every reconnect
  // queues its startup behind them. Should postgres.js stop doing this, this
  // fails, and the replacement is no longer needed.
  it('wedges the client’s own connection when nothing replaces it', async () => {
    const thrown: unknown[] = [];
    restoreImmediates = deliverImmediateThrowsTo((error) => thrown.push(error));
    const sql = fakeClient(server);
    try {
      await sql`select 1`;
      await severedTransaction(sql, server);
      await vi.waitFor(() => {
        expect(thrown).toHaveLength(1);
      });

      await expect(sql`select 1`).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

describe('any other uncaught exception', () => {
  it('ends the orchestrator, as before, and replaces nothing', () => {
    pool = createReplaceablePool(() => fakeClient(server));

    handle(new TypeError("Cannot read properties of undefined (reading 'shardId')"));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('exiting'),
      expect.any(TypeError),
      expect.objectContaining({ consumerName: 'orchestrator-test' }),
    );
  });
});
