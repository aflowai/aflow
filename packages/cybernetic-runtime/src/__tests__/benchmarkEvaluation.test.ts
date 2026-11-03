/**
 * Plan 341 D6 — a benchmark attempt is recorded through Plan 269's one
 * evaluation writer and through nothing else, with the official harness's
 * verdict in the benchmark slot, and only on a benchmark run in the
 * measurement space.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkAttemptResult } from '@aflow/schemas';

const SPACE = '00000000-0000-0000-0000-0000000000b1';
const OTHER_SPACE = '00000000-0000-0000-0000-0000000000b2';

const state: {
  spaces: Map<string, { metadata: unknown; archivedAt: Date | null }>;
  runs: Map<string, { spaceId: string; evalBatchId: string | null; metadata: unknown }>;
} = { spaces: new Map(), runs: new Map() };
const writerCalls: unknown[] = [];
const ledgerCalls: Array<{ op: string; params: unknown }> = [];

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@aflow/database', () => {
  const spaces = { id: 'spaces.id', metadata: 'spaces.metadata', archivedAt: 'archived_at' };
  const workflowRuns = { runId: 'workflow_runs.run_id' };
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: (filter: { value: string }) => ({
          limit: () =>
            Promise.resolve(
              table === spaces
                ? [state.spaces.get(filter.value)].filter(Boolean)
                : [state.runs.get(filter.value)].filter(Boolean),
            ),
        }),
      }),
    }),
    update: () => ({
      set: (values: { metadata: { values: unknown[] } }) => ({
        where: (filter: { value: string }) => ({
          returning: () => {
            const space = state.spaces.get(filter.value);
            if (!space) return Promise.resolve([]);
            const patch = JSON.parse(String(values.metadata.values[1])) as Record<string, unknown>;
            space.metadata = { ...((space.metadata as object | null) ?? {}), ...patch };
            return Promise.resolve([{ id: filter.value }]);
          },
        }),
      }),
    }),
  };
  return {
    spaces,
    workflowRuns,
    createTenantContext: (tenantId: string) => ({ tenantId }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (handle: unknown) => unknown) =>
      cb(tx),
  };
});

vi.mock('../ledger/runs.js', () => ({
  recordRunStart: vi.fn(async (_db: unknown, _tenantId: string, params: unknown) => {
    ledgerCalls.push({ op: 'start', params });
  }),
  completeRun: vi.fn(async (_db: unknown, _tenantId: string, params: unknown) => {
    ledgerCalls.push({ op: 'complete', params });
    return true;
  }),
}));

vi.mock('../runEvaluationEnvelope.js', () => ({
  writeRunEvaluationEnvelope: vi.fn(async (_db: unknown, tenantId: string, params: unknown) => {
    writerCalls.push({ tenantId, params });
    return { written: true };
  }),
}));

const {
  BENCHMARK_RUN_METADATA_KEY,
  BENCHMARK_SPACE_METADATA_KEY,
  benchmarkEvaluationWrite,
  createBareHarnessRun,
  designateMeasurementSpace,
  writeBenchmarkAttemptEvaluation,
} = await import('../benchmarkEvaluation.js');

const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = 'run_proving_ground_1';
const db = {} as never;

function attempt(over: Partial<BenchmarkAttemptResult> = {}): BenchmarkAttemptResult {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: 'instance_example__repo-abc123',
    arm: 'loop',
    passed: true,
    failureClass: null,
    tokens: 120_000,
    costUsd: 1.25,
    wallTimeMs: 600_000,
    patchBytes: 2_048,
    harnessRevision: 'a1b2c3d',
    ...over,
  };
}

const measurement = { [BENCHMARK_SPACE_METADATA_KEY]: { benchmark: 'swe-bench-pro' } };

beforeEach(() => {
  writerCalls.length = 0;
  ledgerCalls.length = 0;
  state.spaces = new Map([
    [SPACE, { metadata: measurement, archivedAt: null }],
    [OTHER_SPACE, { metadata: { team: 'full-circle' }, archivedAt: null }],
  ]);
  state.runs = new Map([[RUN_ID, { spaceId: SPACE, evalBatchId: null, metadata: {} }]]);
});

describe('benchmarkEvaluationWrite', () => {
  it('fills the benchmark slot only, never the decision or the summary', () => {
    const write = benchmarkEvaluationWrite(
      attempt({ passed: false, failureClass: 'tests_failed' }),
    );
    expect(write).toEqual({
      kind: 'benchmark',
      benchmark: attempt({ passed: false, failureClass: 'tests_failed' }),
    });
  });

  it('refuses an attempt whose verdict and failure class disagree', () => {
    expect(() =>
      benchmarkEvaluationWrite(attempt({ passed: true, failureClass: 'tests_failed' })),
    ).toThrow(/failure class exactly when it did not pass/);
    expect(() => benchmarkEvaluationWrite(attempt({ passed: false, failureClass: null }))).toThrow(
      /failure class exactly when it did not pass/,
    );
  });
});

describe('writeBenchmarkAttemptEvaluation', () => {
  it('lands in the one writer, on the tenant and run the caller names', async () => {
    const result = await writeBenchmarkAttemptEvaluation(db, TENANT, {
      runId: RUN_ID,
      spaceId: SPACE,
      attempt: attempt(),
    });
    expect(result).toEqual({ written: true });
    expect(writerCalls).toEqual([
      {
        tenantId: TENANT,
        params: { runId: RUN_ID, write: { kind: 'benchmark', benchmark: attempt() } },
      },
    ]);
  });

  it('writes nothing on a run that is not in this tenant', async () => {
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: 'run_mistyped',
        spaceId: SPACE,
        attempt: attempt(),
      }),
    ).rejects.toThrow(/not in this tenant/);
    expect(writerCalls).toEqual([]);
  });

  it('writes nothing on a run outside the named measurement space', async () => {
    state.runs.set(RUN_ID, { spaceId: OTHER_SPACE, evalBatchId: null, metadata: {} });
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: RUN_ID,
        spaceId: SPACE,
        attempt: attempt(),
      }),
    ).rejects.toThrow(/not in the measurement space/);
    expect(writerCalls).toEqual([]);
  });

  it('writes nothing where the named space is not the measurement space', async () => {
    state.runs.set(RUN_ID, { spaceId: OTHER_SPACE, evalBatchId: null, metadata: {} });
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: RUN_ID,
        spaceId: OTHER_SPACE,
        attempt: attempt(),
      }),
    ).rejects.toThrow(/is not a measurement space/);
    expect(writerCalls).toEqual([]);
  });

  it('writes nothing on an eval-batch trial', async () => {
    state.runs.set(RUN_ID, { spaceId: SPACE, evalBatchId: 'batch_1', metadata: {} });
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: RUN_ID,
        spaceId: SPACE,
        attempt: attempt(),
      }),
    ).rejects.toThrow(/eval-batch trial/);
    expect(writerCalls).toEqual([]);
  });

  it('writes nothing on a run marked as another task or arm', async () => {
    state.runs.set(RUN_ID, {
      spaceId: SPACE,
      evalBatchId: null,
      metadata: {
        [BENCHMARK_RUN_METADATA_KEY]: {
          benchmark: 'swe-bench-pro',
          instanceId: 'instance_other',
          arm: 'bare_harness',
        },
      },
    });
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: RUN_ID,
        spaceId: SPACE,
        attempt: attempt({ arm: 'bare_harness' }),
      }),
    ).rejects.toThrow(/marked as another attempt/);
    expect(writerCalls).toEqual([]);
  });

  it('writes a bare-harness verdict only on a run the runner marked', async () => {
    await expect(
      writeBenchmarkAttemptEvaluation(db, TENANT, {
        runId: RUN_ID,
        spaceId: SPACE,
        attempt: attempt({ arm: 'bare_harness' }),
      }),
    ).rejects.toThrow(/carries no benchmark marker/);
    expect(writerCalls).toEqual([]);
  });
});

describe('createBareHarnessRun', () => {
  const span = {
    startedAt: new Date('2026-11-02T10:00:00.000Z'),
    completedAt: new Date('2026-11-02T10:10:00.000Z'),
  };

  it('creates a marked run in the measurement space, terminal at once, that then takes the verdict', async () => {
    const bare = attempt({ arm: 'bare_harness' });
    const { runId } = await createBareHarnessRun(db, TENANT, {
      spaceId: SPACE,
      attempt: bare,
      ...span,
    });
    expect(ledgerCalls).toEqual([
      {
        op: 'start',
        params: expect.objectContaining({
          spaceId: SPACE,
          runId,
          workflowSlug: 'swe-bench-pro-bare-harness',
          startedAt: span.startedAt,
          metadata: {
            [BENCHMARK_RUN_METADATA_KEY]: {
              benchmark: 'swe-bench-pro',
              instanceId: bare.instanceId,
              arm: 'bare_harness',
            },
          },
        }),
      },
      {
        op: 'complete',
        params: {
          runId,
          completedAt: span.completedAt,
          status: 'completed',
          totalTokens: 120_000,
          totalCostCents: 125,
        },
      },
    ]);
    expect(writerCalls).toEqual([
      {
        tenantId: TENANT,
        params: { runId, write: { kind: 'decision', decision: 'no_suite' } },
      },
    ]);

    const start = ledgerCalls[0]?.params as { metadata: unknown };
    state.runs.set(runId, { spaceId: SPACE, evalBatchId: null, metadata: start.metadata });
    await writeBenchmarkAttemptEvaluation(db, TENANT, { runId, spaceId: SPACE, attempt: bare });
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls[1]).toMatchObject({ params: { runId, write: { kind: 'benchmark' } } });
  });

  it('records an agent that timed out as a failed run', async () => {
    await createBareHarnessRun(db, TENANT, {
      spaceId: SPACE,
      attempt: attempt({
        arm: 'bare_harness',
        passed: false,
        failureClass: 'agent_timeout',
        tokens: null,
        costUsd: null,
      }),
      ...span,
    });
    expect(ledgerCalls[1]?.params).toMatchObject({
      status: 'failed',
      failure: { reason: 'benchmark_agent_timeout' },
    });
  });

  it('creates no run outside the measurement space', async () => {
    await expect(
      createBareHarnessRun(db, TENANT, {
        spaceId: OTHER_SPACE,
        attempt: attempt({ arm: 'bare_harness' }),
        ...span,
      }),
    ).rejects.toThrow(/is not a measurement space/);
    expect(ledgerCalls).toEqual([]);
  });

  it('creates no run for a loop arm, whose run the loop starts', async () => {
    await expect(
      createBareHarnessRun(db, TENANT, { spaceId: SPACE, attempt: attempt(), ...span }),
    ).rejects.toThrow(/bare-harness arm only/);
    expect(ledgerCalls).toEqual([]);
  });
});

describe('designateMeasurementSpace', () => {
  it('marks the named space and keeps its other metadata', async () => {
    await designateMeasurementSpace(db, TENANT, { spaceId: OTHER_SPACE });
    expect(state.spaces.get(OTHER_SPACE)?.metadata).toEqual({
      team: 'full-circle',
      ...measurement,
    });
  });

  it('refuses a space that is not in the tenant, or is no UUID', async () => {
    await expect(
      designateMeasurementSpace(db, TENANT, { spaceId: '00000000-0000-0000-0000-0000000000ff' }),
    ).rejects.toThrow(/not in this tenant/);
    await expect(
      designateMeasurementSpace(db, TENANT, { spaceId: 'proving-ground' }),
    ).rejects.toThrow(/not a UUID/);
  });
});
