import { beforeEach, describe, expect, it, vi } from 'vitest';

const SPACE_ID = '00000000-0000-0000-0000-0000000000b1';
const store: { value: unknown; found: boolean; directives: unknown } = {
  value: null,
  found: true,
  directives: null,
};
const updateCalls: unknown[] = [];

vi.mock('@aflow/database', () => {
  const spaces = { id: 'id', directives: 'directives' };
  return {
    spaces,
    workflowRuns: { runId: 'run_id', evaluationJson: 'evaluation_json', spaceId: 'space_id' },
    createTenantContext: (tenantId: string) => ({ tenantId }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () =>
                table === spaces
                  ? Promise.resolve([{ directives: store.directives }])
                  : {
                      for: () =>
                        Promise.resolve(
                          store.found ? [{ evaluationJson: store.value, spaceId: SPACE_ID }] : [],
                        ),
                    },
            }),
          }),
        }),
        update: () => ({
          set: (v: { evaluationJson: unknown }) => ({
            where: () => {
              store.value = v.evaluationJson;
              updateCalls.push(v.evaluationJson);
              return Promise.resolve();
            },
          }),
        }),
      }),
  };
});

const { benchmarkVerdict, writeRunEvaluationEnvelope, parseRunEvaluationEnvelope } =
  await import('../runEvaluationEnvelope.js');

const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = '00000000-0000-0000-0000-0000000000a1';
const db = {} as never;

const ranWrite = (hash: string) =>
  ({
    kind: 'decision',
    decision: 'ran',
    suiteContentHash: hash,
    summary: {
      verdict: 'pass',
      scores: { overall: 1 },
      faultLayer: null,
      regressionDetected: false,
    },
  }) as const;

beforeEach(() => {
  store.value = null;
  store.found = true;
  store.directives = null;
  updateCalls.length = 0;
});

describe('writeRunEvaluationEnvelope', () => {
  it('unknown run: writes nothing', async () => {
    store.found = false;
    const res = await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'no_suite' },
    });
    expect(res.written).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('first decision write lands with decidedAt and the summary', async () => {
    const res = await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: ranWrite('sha256:aaa'),
    });
    expect(res.written).toBe(true);
    const envelope = parseRunEvaluationEnvelope(store.value);
    expect(envelope).toMatchObject({
      decision: 'ran',
      suiteContentHash: 'sha256:aaa',
      summary: { verdict: 'pass', scores: { overall: 1 } },
    });
    expect(envelope?.decidedAt).toBeTruthy();
  });

  it("idempotent on (runId, suiteContentHash): a repeated 'ran' with the same hash is a no-op", async () => {
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    const res = await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: ranWrite('sha256:aaa'),
    });
    expect(res.written).toBe(false);
    expect(updateCalls).toHaveLength(1);
  });

  it("a stored 'ran' is never downgraded: a late non-'ran' decision write is a no-op", async () => {
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    const res = await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'error', errorMessage: 'late hook refire' },
    });
    expect(res.written).toBe(false);
    expect(parseRunEvaluationEnvelope(store.value)?.decision).toBe('ran');
  });

  it("a 'ran' with a DIFFERENT suite hash replaces the stored decision", async () => {
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    const res = await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: ranWrite('sha256:bbb'),
    });
    expect(res.written).toBe(true);
    expect(parseRunEvaluationEnvelope(store.value)?.suiteContentHash).toBe('sha256:bbb');
  });

  it('a decision write preserves a previously written outcome slot', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: {
        kind: 'outcome',
        outcomeEvaluation: { outcomeResults: [{ outcomeId: 'o1', met: true }], allMet: true },
      },
    });
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    const envelope = parseRunEvaluationEnvelope(store.value);
    expect(envelope?.decision).toBe('ran');
    expect(envelope?.outcomeEvaluation).toEqual({
      outcomeResults: [{ outcomeId: 'o1', met: true }],
      allMet: true,
    });
  });

  it('an outcome write merges onto an existing decision envelope', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'operator_cancelled' },
    });
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: {
        kind: 'outcome',
        outcomeEvaluation: { outcomeResults: [], allMet: false },
      },
    });
    const envelope = parseRunEvaluationEnvelope(store.value);
    expect(envelope?.decision).toBe('operator_cancelled');
    expect(envelope?.outcomeEvaluation).toEqual({ outcomeResults: [], allMet: false });
  });

  const benchmark = {
    benchmark: 'swe-bench-pro',
    instanceId: 'instance_example__repo-abc123',
    arm: 'loop',
    passed: false,
    failureClass: 'tests_failed',
    tokens: null,
    costUsd: null,
    wallTimeMs: 1_000,
    patchBytes: 10,
    harnessRevision: 'a1b2c3d',
  } as const;
  const unscored = { ...benchmark, failureClass: 'harness_error' } as const;

  it('a suite verdict and a benchmark verdict on one run keep each other, in either order', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'benchmark', benchmark },
    });
    expect(parseRunEvaluationEnvelope(store.value)).toMatchObject({
      decision: 'ran',
      suiteContentHash: 'sha256:aaa',
      summary: { verdict: 'pass', scores: { overall: 1 } },
      benchmark,
    });

    store.value = null;
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'benchmark', benchmark },
    });
    await writeRunEvaluationEnvelope(db, TENANT, { runId: RUN_ID, write: ranWrite('sha256:aaa') });
    expect(parseRunEvaluationEnvelope(store.value)).toMatchObject({
      decision: 'ran',
      summary: { verdict: 'pass' },
      benchmark,
    });
  });

  it('a benchmark write onto a run in a space with no directives sets no decision', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'benchmark', benchmark },
    });
    const envelope = parseRunEvaluationEnvelope(store.value);
    expect(envelope?.benchmark).toEqual(benchmark);
    expect(envelope?.decision).toBeUndefined();
    expect(envelope?.summary).toBeUndefined();
  });

  it('refuses a benchmark write onto a run that still owes its decision, leaving the envelope NULL for the repair', async () => {
    store.directives = { goals: [] };
    await expect(
      writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark },
      }),
    ).rejects.toThrow(/has recorded no evaluation decision yet/);
    expect(store.value).toBeNull();
    expect(updateCalls).toHaveLength(0);

    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'error', errorMessage: 'hook died' },
    });
    expect(
      await writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark },
      }),
    ).toEqual({ written: true });
    expect(parseRunEvaluationEnvelope(store.value)).toMatchObject({ decision: 'error', benchmark });
  });

  it('a scored benchmark verdict is final for its harness revision, and an unscored one is not', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'benchmark', benchmark: unscored },
    });
    expect(
      await writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark },
      }),
    ).toEqual({ written: true });
    expect(
      await writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark: { ...benchmark, passed: true, failureClass: null } },
      }),
    ).toEqual({ written: false, storedBenchmark: benchmark });
    expect(
      await writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark: { ...benchmark, harnessRevision: 'ffffff0' } },
      }),
    ).toEqual({ written: true });
  });

  it('refuses a benchmark write naming another task or arm than the run holds', async () => {
    await writeRunEvaluationEnvelope(db, TENANT, {
      runId: RUN_ID,
      write: { kind: 'benchmark', benchmark },
    });
    await expect(
      writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark: { ...benchmark, instanceId: 'instance_other' } },
      }),
    ).rejects.toThrow(/cannot record/);
    await expect(
      writeRunEvaluationEnvelope(db, TENANT, {
        runId: RUN_ID,
        write: { kind: 'benchmark', benchmark: { ...benchmark, arm: 'bare_harness' } },
      }),
    ).rejects.toThrow(/cannot record/);
  });
});

describe('benchmarkVerdict', () => {
  it('counts a harness that gave no verdict as unscored, never as a fail', () => {
    const base = {
      benchmark: 'swe-bench-pro',
      instanceId: 'i',
      arm: 'loop',
      tokens: null,
      costUsd: null,
      wallTimeMs: 0,
      patchBytes: 0,
      harnessRevision: 'r',
    } as const;
    expect(benchmarkVerdict({ ...base, passed: true, failureClass: null })).toBe('pass');
    expect(benchmarkVerdict({ ...base, passed: false, failureClass: 'tests_failed' })).toBe('fail');
    expect(benchmarkVerdict({ ...base, passed: false, failureClass: 'agent_timeout' })).toBe(
      'fail',
    );
    for (const failureClass of [
      'materialize_failed',
      'image_unavailable',
      'harness_error',
    ] as const) {
      expect(benchmarkVerdict({ ...base, passed: false, failureClass })).toBe('unscored');
    }
  });
});
