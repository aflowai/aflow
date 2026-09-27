import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: { value: unknown; found: boolean } = { value: null, found: true };
const updateCalls: unknown[] = [];

vi.mock('@aflow/database', () => ({
  workflowRuns: { runId: 'run_id', evaluationJson: 'evaluation_json' },
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: () => Promise.resolve(store.found ? [{ evaluationJson: store.value }] : []),
            }),
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
}));

const { writeRunEvaluationEnvelope, parseRunEvaluationEnvelope } =
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
});
