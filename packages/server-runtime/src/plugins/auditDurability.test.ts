import { describe, expect, it, vi } from 'vitest';
import { createAuditService } from './audit.js';

/**
 * Audit evidence is only evidence if its absence is impossible or counted.
 *
 * The three paths tested here each used to discard events with a log line: an
 * absent database, a row that would not insert, and a failing batch. A gap
 * produced that way is indistinguishable from nothing having happened, which is
 * the property an incident reconstruction depends on being false.
 */

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createAuditService>[1];

function event(overrides: Record<string, unknown> = {}) {
  return {
    actor: { userId: 'u1', kind: 'user', authMethod: 'jwt', tenantId: 't1' },
    category: 'resource' as const,
    action: 'thing.updated',
    outcome: 'success' as const,
    ...overrides,
  };
}

/**
 * A row that fails on its own content — SQLSTATE 23505, unique_violation.
 *
 * Named rather than generic, because which KIND of failure it is decides
 * whether the attempt budget is spent: a deterministic error will be there
 * again when the database comes back, a connection reset will not.
 */
function deterministicRowError(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

/** A db whose insert always rejects, counting attempts. */
function failingDb(makeError: () => Error = deterministicRowError): {
  db: unknown;
  attempts: () => number;
} {
  let n = 0;
  return {
    db: {
      insert: () => ({
        values: () => {
          n += 1;
          return Promise.reject(makeError());
        },
      }),
    },
    attempts: () => n,
  };
}

function okDb(): { db: unknown; rows: () => unknown[] } {
  const rows: unknown[] = [];
  return {
    db: {
      insert: () => ({
        values: (v: unknown) => {
          rows.push(v);
          return Promise.resolve();
        },
      }),
    },
    rows: () => rows,
  };
}

describe('audit durability', () => {
  /**
   * Retrying an already-written event is not a harmless duplicate: the row
   * carries its own id, so the retry violates the primary key, fails, exhausts
   * its attempts, and reports as lost a record that is sitting in the table.
   * The failure it produces is a false alarm about the thing it exists to
   * guarantee.
   */
  it('does not put already-written events back when something after the insert throws', async () => {
    const written: unknown[] = [];
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          written.push(v);
          return Promise.resolve();
        },
      }),
    };
    // The structured-log pass runs after every insert has succeeded. A
    // serializer that throws there must not reach the batch handler.
    const throwingLog = {
      info: () => {
        throw new Error('serializer blew up');
      },
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Parameters<typeof createAuditService>[1];

    const svc = createAuditService(() => db as never, throwingLog);
    svc.record(event({ action: 'a' }));
    svc.record(event({ action: 'b' }));
    await svc.flush();

    expect(written).toHaveLength(2);

    // Nothing is pending, so a second flush writes nothing more.
    await svc.flush();
    expect(written).toHaveLength(2);
    expect(svc.droppedEventCount).toBe(0);
  });

  it('retains events across a database outage and writes them when it returns', async () => {
    // One service, a db that is absent and then present — which is the actual
    // shape of the incident, and the only way to prove the event survived it.
    const live = okDb();
    let db: unknown = null;
    const svc = createAuditService(() => db as never, log);

    svc.record(event({ action: 'during.outage' }));
    await svc.flush();
    expect(live.rows()).toHaveLength(0);
    expect(svc.droppedEventCount).toBe(0);

    db = live.db;
    await svc.flush();

    expect(live.rows()).toHaveLength(1);
    expect(JSON.stringify(live.rows())).toContain('during.outage');
    expect(svc.droppedEventCount).toBe(0);
  });

  it('gives up on a single unwritable row rather than stalling the ones behind it', async () => {
    const { db, attempts } = failingDb();
    const svc = createAuditService(() => db as never, log);
    svc.record(event());

    // Retried, not abandoned on the first failure, and not forever.
    for (let i = 0; i < 10; i += 1) await svc.flush();

    expect(attempts()).toBeGreaterThan(1);
    expect(attempts()).toBeLessThanOrEqual(5);
    // The loss is a counted fact, not an absence.
    expect(svc.droppedEventCount).toBe(1);
  });

  it('counts what it drops, so the gap is a number somebody can alert on', async () => {
    const { db } = failingDb();
    const svc = createAuditService(() => db as never, log);
    svc.record(event());
    svc.record(event({ action: 'other.thing' }));
    for (let i = 0; i < 10; i += 1) await svc.flush();
    expect(svc.droppedEventCount).toBe(2);
  });

  it('writes a security event without waiting for the interval timer', async () => {
    const { db, rows } = okDb();
    const svc = createAuditService(() => db as never, log);
    svc.record(event({ category: 'security', action: 'auth.denied' }));
    // No flush() call and no timer — recording one is what schedules the write.
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('redacts a secret before it reaches the row', async () => {
    const { db, rows } = okDb();
    const svc = createAuditService(() => db as never, log);
    svc.record(event({ details: { apiKey: 'sk-live-should-not-persist', spaceId: 'sp1' } }));
    await svc.flush();
    expect(JSON.stringify(rows())).not.toContain('sk-live-should-not-persist');
    expect(JSON.stringify(rows())).toContain('sp1');
  });
  /**
   * The attempt budget is for a row that fails on its own content. A connection
   * reset is seen by every event in flight, so charging each of them an attempt
   * spends the whole budget inside one outage — at a one-second cadence, five
   * seconds of unreachable database would drop everything buffered, which is
   * the opposite of what the retry is for.
   */
  it('does not spend the attempt budget on a connection failure', async () => {
    let failing = true;
    const written: unknown[] = [];
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          if (failing) return Promise.reject(new Error('ECONNRESET'));
          written.push(v);
          return Promise.resolve();
        },
      }),
    };
    const svc = createAuditService(() => db as never, log);
    svc.record(event({ action: 'survives.outage' }));

    // Longer than the deterministic budget: a transient error must not consume it.
    for (let i = 0; i < 12; i += 1) await svc.flush();
    expect(svc.droppedEventCount).toBe(0);

    failing = false;
    await svc.flush();
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).toContain('survives.outage');
  });
});
