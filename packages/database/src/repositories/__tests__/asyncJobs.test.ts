import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  ASYNC_JOB_TERMINAL_STATES,
  AsyncJobStateSchema,
  deriveAsyncJobKey,
  isAsyncJobTerminal,
  type AsyncJobIdentity,
  type TenantId,
} from '@aflow/schemas';
import type { TenantContext } from '../../tenant.js';
import { asyncJobs, type AsyncJobRow } from '../../schema/tenant.js';
import {
  ASYNC_JOB_IN_FLIGHT_STATES,
  createAsyncJobRepository,
  toAsyncJobRecord,
  type AsyncJobRepository,
  type AsyncJobReservation,
} from '../asyncJobs.js';

const TENANT: TenantContext = {
  tenantId: 'a0000000-0000-0000-0000-000000000001' as unknown as TenantId,
  schemaName: 't_a0000000000000000000000000000001',
};

const ROW: AsyncJobRow = {
  jobKey: deriveAsyncJobKey({
    runId: 'run-1',
    logicalExecutionId: 'step-1',
    attempt: 0,
    operationId: 'ai.image.generate',
    provider: 'acme',
    inputHash: 'hash-1',
  }),
  runId: 'run-1',
  logicalExecutionId: 'step-1',
  attempt: 0,
  operationId: 'ai.image.generate',
  provider: 'acme',
  model: null,
  state: 'reserved',
  replayGuarantee: { kind: 'idempotency_key', field: 'X-Request-Id' },
  clientRequestId: 'client-1',
  inputHash: 'hash-1',
  providerJobId: null,
  pollCount: 0,
  lastError: null,
  costCurrency: null,
  costMicros: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:01.000Z'),
};

const IDENTITY: AsyncJobIdentity = {
  runId: 'run-1',
  logicalExecutionId: 'step-1',
  attempt: 0,
  operationId: 'ai.image.generate',
  provider: 'acme',
  inputHash: 'hash-1',
};

const RESERVATION: AsyncJobReservation = {
  identity: IDENTITY,
  replayGuarantee: { kind: 'idempotency_key', field: 'X-Request-Id' },
};

const JOB_KEY = deriveAsyncJobKey(IDENTITY);

const COLUMN_KEYS = Object.keys(getTableColumns(asyncJobs)) as Array<keyof AsyncJobRow>;

/** One row as the driver hands it over: positional, and bigint/text unparsed. */
function driverRow(overrides: Partial<Record<keyof AsyncJobRow, unknown>> = {}): unknown[] {
  const row: Record<string, unknown> = { ...ROW, ...overrides };
  return COLUMN_KEYS.map((key) => row[key]);
}

interface Captured {
  query: string;
  params: readonly unknown[];
}

/**
 * A real drizzle instance over a fake postgres-js client: statements are built
 * and rendered for real, nothing reaches a database.
 */
function fakeRepository(results: unknown[][][]): {
  repo: AsyncJobRepository;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const queue = [...results];
  const client = Object.assign(
    () => {
      throw new Error('tagged-template query is not expected');
    },
    {
      unsafe: (query: string, params: readonly unknown[]) => {
        // The repository owns its transaction, so every call opens with a
        // search_path statement. Keeping it out of `captured` lets the
        // assertions index the statements the repository actually issues.
        if (query.includes('search_path'))
          return Object.assign(Promise.resolve([]), {
            values: () => Promise.resolve([]),
          });
        captured.push({ query, params });
        const rows = queue.shift() ?? [];
        const pending = Promise.resolve(rows);
        return Object.assign(pending, { values: () => Promise.resolve(rows) });
      },
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
      options: { parsers: {}, serializers: {} },
    },
  );
  const db = drizzle(client as unknown as postgres.Sql);
  return { repo: createAsyncJobRepository(db, TENANT), captured };
}

describe('toAsyncJobRecord', () => {
  it('maps a reserved row and omits every absent optional', () => {
    const record = toAsyncJobRecord(ROW);
    expect(record).toEqual({
      jobKey: JOB_KEY,
      runId: 'run-1',
      logicalExecutionId: 'step-1',
      attempt: 0,
      operationId: 'ai.image.generate',
      provider: 'acme',
      state: 'reserved',
      replayGuarantee: { kind: 'idempotency_key', field: 'X-Request-Id' },
      clientRequestId: 'client-1',
      inputHash: 'hash-1',
      pollCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    expect('model' in record).toBe(false);
    expect('providerJobId' in record).toBe(false);
    expect('lastError' in record).toBe(false);
    expect('actualCost' in record).toBe(false);
  });

  it('carries the populated optionals', () => {
    const record = toAsyncJobRecord({
      ...ROW,
      model: 'render-v2',
      state: 'succeeded',
      providerJobId: 'provider-77',
      pollCount: 4,
      lastError: 'transient timeout',
      costCurrency: 'USD',
      costMicros: 4_200_000,
    });
    expect(record.model).toBe('render-v2');
    expect(record.providerJobId).toBe('provider-77');
    expect(record.pollCount).toBe(4);
    expect(record.lastError).toBe('transient timeout');
    expect(record.actualCost).toEqual({ currency: 'USD', micros: 4_200_000 });
  });

  it('treats a zero cost as a reported cost, not an absent one', () => {
    const record = toAsyncJobRecord({
      ...ROW,
      state: 'succeeded',
      costCurrency: 'EUR',
      costMicros: 0,
    });
    expect(record.actualCost).toEqual({ currency: 'EUR', micros: 0 });
  });

  it('leaves actualCost absent when the provider reported no cost', () => {
    const record = toAsyncJobRecord({ ...ROW, state: 'failed', lastError: 'upstream 500' });
    expect('actualCost' in record).toBe(false);
  });

  it('carries the unknown_terminal guarantee through', () => {
    const record = toAsyncJobRecord({
      ...ROW,
      state: 'unknown',
      replayGuarantee: { kind: 'unknown_terminal' },
    });
    expect(record.replayGuarantee).toEqual({ kind: 'unknown_terminal' });
  });

  it('refuses a row whose state is not part of the lifecycle', () => {
    expect(() => toAsyncJobRecord({ ...ROW, state: 'in_progress' as never })).toThrow();
  });

  it('refuses a row whose replay guarantee does not parse', () => {
    expect(() =>
      toAsyncJobRecord({ ...ROW, replayGuarantee: { kind: 'idempotent' } as never }),
    ).toThrow();
  });
});

describe('reserveJob', () => {
  it('reports created when the insert produced the row', async () => {
    const { repo, captured } = fakeRepository([[driverRow()]]);
    const result = await repo.reserveJob(RESERVATION);
    expect(result.created).toBe(true);
    expect(result.record.jobKey).toBe(JOB_KEY);
    expect(result.record.state).toBe('reserved');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.query).toContain('on conflict ("job_key") do nothing');
    expect(captured[0]!.params).toContain('{"kind":"idempotency_key","field":"X-Request-Id"}');
  });

  it('returns the prior row, not a second job, when the key already exists', async () => {
    const prior = driverRow({ state: 'submitted', providerJobId: 'provider-77', pollCount: 3 });
    const { repo, captured } = fakeRepository([[], [prior]]);
    const result = await repo.reserveJob(RESERVATION);
    expect(result.created).toBe(false);
    expect(result.record.state).toBe('submitted');
    expect(result.record.providerJobId).toBe('provider-77');
    expect(result.record.pollCount).toBe(3);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.query).toContain('from "async_jobs"');
    expect(captured[1]!.params).toContain(JOB_KEY);
  });

  it('fails loudly when a conflicted key is not readable back', async () => {
    const { repo } = fakeRepository([[], []]);
    await expect(repo.reserveJob(RESERVATION)).rejects.toThrow(/not readable/);
  });
});

describe('identity', () => {
  it('derives the same key for the same work and a different one per attempt', () => {
    expect(deriveAsyncJobKey(IDENTITY)).toBe(deriveAsyncJobKey({ ...IDENTITY }));
    // A legitimate new attempt must be able to buy a new job.
    expect(deriveAsyncJobKey({ ...IDENTITY, attempt: 1 })).not.toBe(JOB_KEY);
  });

  it('separates work that differs in any identity field', () => {
    const vary: Array<Partial<AsyncJobIdentity>> = [
      { runId: 'run-2' },
      { logicalExecutionId: 'step-2' },
      { operationId: 'ai.media.video' },
      { provider: 'other' },
      { model: 'render-v2' },
      { inputHash: 'hash-2' },
    ];
    for (const patch of vary) {
      expect(deriveAsyncJobKey({ ...IDENTITY, ...patch })).not.toBe(JOB_KEY);
    }
  });

  it('refuses a conflicting row that is not the same work', async () => {
    // Same derived key, different stored identity: returning it would hand this
    // caller somebody else's provider job.
    const foreign = driverRow({ runId: 'run-2' });
    const { repo } = fakeRepository([[], [foreign]]);
    await expect(repo.reserveJob(RESERVATION)).rejects.toThrow(/different runId/);
  });
});

describe('reconcileUnknownJob', () => {
  it('only resolves a job that is ambiguous', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(
      await repo.reconcileUnknownJob(JOB_KEY, 'succeeded', {
        reconciledBy: 'operator:ana',
        providerJobId: 'provider-77',
        actualCost: { currency: 'USD', micros: 1_000 },
      }),
    ).toBe(true);
    expect(captured[0]!.query).toContain('"state" = $');
    expect(captured[0]!.params).toContain('unknown');
    expect(captured[0]!.params).toContain('provider-77');
  });

  it('reports false when the job is no longer unknown', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.reconcileUnknownJob(JOB_KEY, 'failed', { reconciledBy: 'sweep' })).toBe(
      false,
    );
  });

  it('cannot be used to re-settle a job that already has an outcome', async () => {
    // The guard is `state = 'unknown'`; nothing else is reachable from here.
    const { repo, captured } = fakeRepository([[]]);
    await repo.reconcileUnknownJob(JOB_KEY, 'succeeded', { reconciledBy: 'operator:ana' });
    const stateParams = captured[0]!.params.filter((p) => typeof p === 'string');
    expect(stateParams).toContain('unknown');
    for (const settled of ['succeeded', 'failed'] as const) {
      expect(captured[0]!.query).not.toContain(`"state" = '${settled}'`);
    }
  });
});

describe('compare-and-set transitions', () => {
  // The double-pay hole: `submitting -> submitting` is a replay of a call that
  // may already have reached the provider, so state alone is not exclusive.
  it('lets a deduped route re-enter submitting, guarded on the stored guarantee', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.markSubmitting(JOB_KEY, 'submitting')).toBe(true);
    expect(captured[0]!.query).toContain(`->>'kind' = 'idempotency_key'`);
  });

  it('does not put the guarantee in the guard for a first submit', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    await repo.markSubmitting(JOB_KEY, 'reserved');
    expect(captured[0]!.query).not.toContain('idempotency_key');
  });

  it('advances to submitting only from the state the caller observed', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.markSubmitting(JOB_KEY, 'reserved')).toBe(true);
    expect(captured[0]!.query).toContain(
      'where ("async_jobs"."job_key" = $2 and "async_jobs"."state" = $3)',
    );
    expect(captured[0]!.params).toEqual(['submitting', JOB_KEY, 'reserved']);
  });

  it('accepts submitting as its own predecessor for a deduped replay', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.markSubmitting(JOB_KEY, 'submitting')).toBe(true);
    expect(captured[0]!.params).toEqual(['submitting', JOB_KEY, 'submitting']);
  });

  it('reports false when no row matched the expected state', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.markSubmitting(JOB_KEY, 'reserved')).toBe(false);
  });

  it('records the provider job id only over a submitting row', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.markSubmitted(JOB_KEY, 'provider-77')).toBe(true);
    expect(captured[0]!.params).toEqual(['submitted', 'provider-77', JOB_KEY, 'submitting']);
  });

  it('reports false when the submitted transition lost the race', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.markSubmitted(JOB_KEY, 'provider-77')).toBe(false);
  });

  it('increments poll_count only from a state that already has a provider job', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.recordPoll(JOB_KEY)).toBe(true);
    expect(captured[0]!.query).toContain('"poll_count" = "async_jobs"."poll_count" + 1');
    expect(captured[0]!.params).toEqual(['polling', JOB_KEY, 'submitted', 'polling']);
  });

  it('reports false when a poll found no live row', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.recordPoll(JOB_KEY)).toBe(false);
  });

  it('settles only a job that has not already settled', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(
      await repo.markTerminal(JOB_KEY, 'succeeded', {
        actualCost: { currency: 'USD', micros: 4_200_000 },
      }),
    ).toBe(true);
    const { params } = captured[0]!;
    expect(params.slice(0, 5)).toEqual(['succeeded', null, 'USD', 4_200_000, JOB_KEY]);
    // Derived, not a literal: the point is that no terminal state ever enters
    // the guard, so a settled job cannot be re-settled.
    expect(params.slice(5)).toEqual(
      AsyncJobStateSchema.options.filter((state) => !isAsyncJobTerminal(state)),
    );
    for (const terminal of ASYNC_JOB_TERMINAL_STATES) {
      expect(params.slice(5)).not.toContain(terminal);
    }
  });

  it('writes the failure reason and leaves cost null', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]]]);
    expect(await repo.markTerminal(JOB_KEY, 'failed', { lastError: 'upstream 500' })).toBe(true);
    expect(captured[0]!.params.slice(0, 5)).toEqual([
      'failed',
      'upstream 500',
      null,
      null,
      JOB_KEY,
    ]);
  });

  it('reports false when the job had already settled', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.markTerminal(JOB_KEY, 'unknown')).toBe(false);
  });

  it('guards every mutating statement on the current state and stamps updated_at', async () => {
    const { repo, captured } = fakeRepository([[[JOB_KEY]], [[JOB_KEY]], [[JOB_KEY]], [[JOB_KEY]]]);
    await repo.markSubmitting(JOB_KEY, 'reserved');
    await repo.markSubmitted(JOB_KEY, 'provider-77');
    await repo.recordPoll(JOB_KEY);
    await repo.markTerminal(JOB_KEY, 'succeeded');
    expect(captured).toHaveLength(4);
    for (const { query } of captured) {
      expect(query).toMatch(/"async_jobs"\."state" (=|in) /);
      expect(query).toContain('"updated_at" = now()');
      expect(query).toContain('returning "job_key"');
    }
  });
});

describe('reads', () => {
  it('returns null for a job key that has no row', async () => {
    const { repo } = fakeRepository([[]]);
    expect(await repo.getJob(JOB_KEY)).toBeNull();
  });

  it('converts the bigint cost column the driver hands over as text', async () => {
    const { repo } = fakeRepository([
      [driverRow({ state: 'succeeded', costCurrency: 'USD', costMicros: '4200000' })],
    ]);
    const record = await repo.getJob(JOB_KEY);
    expect(record?.actualCost).toEqual({ currency: 'USD', micros: 4_200_000 });
    expect(typeof record?.actualCost?.micros).toBe('number');
  });

  // Not filtered by attempt: jobKey is frozen at first insert, so a stored
  // attempt goes stale on retry and would blind discovery exactly then.
  it('scopes the live list to the unit of work and the in-flight states', async () => {
    const { repo, captured } = fakeRepository([[driverRow({ state: 'polling', pollCount: 2 })]]);
    const records = await repo.listLiveJobsForExecution('run-1', 'step-1');
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('polling');
    expect(records[0]?.pollCount).toBe(2);
    expect(captured[0]!.params).toEqual(['run-1', 'step-1', 'submitting', 'submitted', 'polling']);
    expect(captured[0]!.params).not.toContain(0);
    expect(captured[0]!.query).toContain('order by "async_jobs"."created_at" asc');
  });
});

describe('ASYNC_JOB_IN_FLIGHT_STATES', () => {
  it('excludes reserved and every terminal state', () => {
    expect(ASYNC_JOB_IN_FLIGHT_STATES).toEqual(['submitting', 'submitted', 'polling']);
    const rest = AsyncJobStateSchema.options.filter(
      (state) => !ASYNC_JOB_IN_FLIGHT_STATES.includes(state),
    );
    expect(rest).toEqual(['reserved', ...ASYNC_JOB_TERMINAL_STATES]);
  });
});
