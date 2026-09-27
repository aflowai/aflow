/**
 * The D7 authority boundary: golden-dataset writes are operator-only — an
 * agent principal (service principal) is rejected at the route regardless of
 * space grants, a human principal's write flows to the shared write core with
 * the server-stamped actor, undecidable cases come back as 422 with typed
 * diagnostics, and labels are stamped (labeledBy, partition 'exemplar') by
 * the server, never the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerGoldenDatasetRoutes } from './goldenDataset.js';
import { applyOperatorGoldenCaseWrite } from '../../services/operatorGoldenDatasetWrite.js';
import {
  getEvalBatchById,
  getTrialRow,
  loadGoldenDatasetBundle,
  resolveLabelQueueItemForSubject,
} from '@aflow/cybernetic-runtime';

vi.mock('../../services/operatorGoldenDatasetWrite.js', () => ({
  applyOperatorGoldenCaseWrite: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadGoldenDatasetBundle: vi.fn(),
  getTrialRow: vi.fn(),
  getEvalBatchById: vi.fn(),
  resolveLabelQueueItemForSubject: vi.fn(async () => 0),
}));

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const CASE_ID = '00000000-0000-4000-8000-0000000000cc';

const MINIMAL_CASE = {
  title: 'Wrong ticker pauses at triage',
  stratum: { scenario: 'bad-input', direction: 'should_succeed', tier: 'capability' },
  trigger: { inputs: { ticker: 'NVDA' } },
  fixture: { tier: 'live', learnings: 'none' },
  expectations: [{ kind: 'terminal', runStatus: 'completed' }],
  rubrics: [],
  provenance: { source: 'curated', workflowRevision: 3 },
};

interface FakeDb {
  db: unknown;
  labelInserts: Array<Record<string, unknown>>;
}

function makeFakeDb(): FakeDb {
  const labelInserts: FakeDb['labelInserts'] = [];
  const tx: Record<string, unknown> = {
    execute: async () => undefined,
    insert: () => ({
      values(values: Record<string, unknown>) {
        labelInserts.push(values);
        return {
          returning: () => Promise.resolve([{ id: '00000000-0000-4000-8000-0000000000dd' }]),
        };
      },
    }),
  };
  const db: Record<string, unknown> = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return { db, labelInserts };
}

async function buildTestApp(opts: {
  isServicePrincipal: boolean;
  db?: unknown;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: opts.db ?? {} };

  app.addHook('onRequest', async (request) => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: USER_ID,
      authMethod: 'test',
      isServicePrincipal: opts.isServicePrincipal,
    };
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
    (request as unknown as { requireSpace: () => Promise<unknown> }).requireSpace = async () => ({
      spaceId: SPACE_ID,
    });
  });

  await app.register(
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
    async (scope) => {
      registerGoldenDatasetRoutes(scope);
    },
    { prefix: '/v1/spaces' },
  );
  await app.ready();
  return app;
}

const writeMock = vi.mocked(applyOperatorGoldenCaseWrite);
const bundleMock = vi.mocked(loadGoldenDatasetBundle);
const trialRowMock = vi.mocked(getTrialRow);
const batchHeadMock = vi.mocked(getEvalBatchById);

beforeEach(() => {
  writeMock.mockReset();
  bundleMock.mockReset();
  trialRowMock.mockReset();
  batchHeadMock.mockReset();
});

describe('operator-only boundary (agent principals rejected)', () => {
  const calls: Array<{
    method: 'POST' | 'PUT' | 'DELETE';
    url: string;
    body?: Record<string, unknown>;
  }> = [
    {
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases`,
      body: { case: MINIMAL_CASE },
    },
    {
      method: 'PUT',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases/${CASE_ID}`,
      body: { case: MINIMAL_CASE },
    },
    {
      method: 'DELETE',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases/${CASE_ID}`,
    },
    {
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      body: {
        runId: 'run_1',
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The judge passed a fabricated citation.',
      },
    },
  ];

  it('rejects every write route for a service-principal caller, before any write-core call', async () => {
    const fake = makeFakeDb();
    const app = await buildTestApp({ isServicePrincipal: true, db: fake.db });
    for (const call of calls) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        ...(call.body !== undefined ? { payload: call.body } : {}),
      });
      expect(response.statusCode, call.url).toBe(403);
      expect(response.json()).toMatchObject({ error: 'operator_only' });
    }
    expect(writeMock).not.toHaveBeenCalled();
    expect(fake.labelInserts).toEqual([]);
    await app.close();
  });
});

describe('operator (human) writes', () => {
  it('routes a case add to the write core with the server-stamped operator id', async () => {
    writeMock.mockResolvedValue({
      ok: true,
      datasetId: '00000000-0000-4000-8000-0000000000d5',
      caseId: CASE_ID,
      datasetVersion: 1,
      revisionId: '00000000-0000-4000-8000-0000000000e1',
      advisories: [],
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases`,
      payload: { case: MINIMAL_CASE, expectedDatasetVersion: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, datasetVersion: 1, caseId: CASE_ID });
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'add',
        slug: 'daily-metrics',
        spaceId: SPACE_ID,
        operatorUserId: USER_ID,
        expectedDatasetVersion: 0,
      }),
    );
    await app.close();
  });

  it('surfaces undecidable-case rejections as 422 with the typed diagnostics', async () => {
    writeMock.mockResolvedValue({
      ok: false,
      status: 422,
      code: 'undecidable_case',
      detail: 'fix the diagnostics',
      diagnostics: [
        {
          code: 'case_field_not_produced',
          severity: 'error',
          detail: "Output check binds to field 'score' the task never produces.",
        },
      ],
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases/${CASE_ID}`,
      payload: { case: MINIMAL_CASE },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'undecidable_case',
      diagnostics: [{ code: 'case_field_not_produced', severity: 'error' }],
    });
    await app.close();
  });

  it('maps a stale precondition to 409', async () => {
    writeMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'version_conflict',
      detail: 'reload and retry',
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/golden-cases/${CASE_ID}?expectedDatasetVersion=3`,
    });
    expect(response.statusCode).toBe(409);
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'remove', caseId: CASE_ID, expectedDatasetVersion: 3 }),
    );
    await app.close();
  });

  it('label submit stamps labeledBy and partition server-side — the caller cannot supply either', async () => {
    const fake = makeFakeDb();
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The judge passed a fabricated citation.',
        // Attempted spoofs — unknown keys are stripped by the body schema.
        partition: 'validation',
        labeledByUserId: '99999999-9999-4999-8999-999999999999',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(fake.labelInserts).toHaveLength(1);
    expect(fake.labelInserts[0]).toMatchObject({
      spaceId: SPACE_ID,
      runId: 'run_1',
      criterionId: 'insight_quality',
      verdict: 'fail',
      partition: 'exemplar',
      labeledByUserId: USER_ID,
    });
    await app.close();
  });

  it('defaults the suite path from the route slug — a label no per-criterion read can find is lost', async () => {
    const fake = makeFakeDb();
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The judge passed a fabricated citation.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(fake.labelInserts[0]).toMatchObject({
      evalSuitePath: '/evals/daily-metrics/suite.json',
    });
    await app.close();
  });

  it('reads the judge verdict off the trial row, never off the caller', async () => {
    const fake = makeFakeDb();
    batchHeadMock.mockResolvedValueOnce({
      spaceId: SPACE_ID,
      workflowSlug: 'daily-metrics',
    } as never);
    trialRowMock.mockResolvedValueOnce({
      runId: 'run_1',
      resultsJson: {
        fractionPassed: 1,
        expectationResults: [],
        pendingRubrics: [],
        rubricResults: [
          {
            status: 'judged',
            criterionId: 'insight_quality',
            scopeKey: 'goal',
            verdict: 'pass',
            score: 0.9,
            rationale: 'Reads as well sourced.',
            judgeVersion: 'jv-1',
          },
        ],
      },
    });
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        batchId: '00000000-0000-4000-8000-0000000000b1',
        caseRevisionId: '00000000-0000-4000-8000-0000000000c1',
        trial: 1,
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The citation it accepted does not exist.',
        // A caller-asserted judge verdict would make agreement unmeasurable.
        judgeLabel: 'fail',
        judgeScore: '0.1',
        judgeVersion: 'jv-spoof',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(fake.labelInserts[0]).toMatchObject({
      verdict: 'fail',
      judgeLabel: 'pass',
      judgeScore: '0.9',
      // The caller named 'jv-spoof'; the stored slot's judge is what is filed.
      judgeVersion: 'jv-1',
      partition: 'exemplar',
    });
    await app.close();
  });

  it("refuses another space's batch instead of copying its judge into this one", async () => {
    // The ids arrive in the body and a trial read is tenant-scoped, so nothing
    // below this check would have noticed the batch belongs elsewhere.
    const fake = makeFakeDb();
    batchHeadMock.mockResolvedValueOnce({
      spaceId: '00000000-0000-4000-8000-00000000beef',
      workflowSlug: 'daily-metrics',
    } as never);
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        batchId: '00000000-0000-4000-8000-0000000000b1',
        caseRevisionId: '00000000-0000-4000-8000-0000000000c1',
        trial: 1,
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'Filed against a batch this space does not own.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(trialRowMock).not.toHaveBeenCalled();
    expect(fake.labelInserts[0]?.['judgeLabel']).toBeUndefined();
    await app.close();
  });

  it('clears the queue item its own subject would have collided with', async () => {
    // A judged failure already has a pending exemplar item for this subject.
    // Both carry the same identity, so the bench's submit would 409 later and
    // leave a row nobody can clear.
    const fake = makeFakeDb();
    batchHeadMock.mockResolvedValueOnce({
      spaceId: SPACE_ID,
      workflowSlug: 'daily-metrics',
    } as never);
    trialRowMock.mockResolvedValueOnce({ runId: 'run_1', resultsJson: {} } as never);
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        batchId: '00000000-0000-4000-8000-0000000000b1',
        caseRevisionId: '00000000-0000-4000-8000-0000000000c1',
        trial: 1,
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'pass',
        critique: 'The judge failed a reply that answers the criterion.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(vi.mocked(resolveLabelQueueItemForSubject)).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.objectContaining({
        batchId: '00000000-0000-4000-8000-0000000000b1',
        trial: 1,
        criterionId: 'insight_quality',
        partition: 'exemplar',
      }),
    );
    await app.close();
  });

  it('refuses a judge verdict from a trial that ran a different run', async () => {
    // The run is named separately from the trial, so without this the label
    // would carry one run's id beside another run's judge.
    const fake = makeFakeDb();
    batchHeadMock.mockResolvedValueOnce({
      spaceId: SPACE_ID,
      workflowSlug: 'daily-metrics',
    } as never);
    trialRowMock.mockResolvedValueOnce({ runId: 'run_other', resultsJson: {} } as never);
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        batchId: '00000000-0000-4000-8000-0000000000b1',
        caseRevisionId: '00000000-0000-4000-8000-0000000000c1',
        trial: 1,
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The run named here is not the one that trial ran.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(fake.labelInserts[0]?.['judgeLabel']).toBeUndefined();
    await app.close();
  });

  it('still records the operator verdict when the judged slot cannot be found', async () => {
    const fake = makeFakeDb();
    batchHeadMock.mockResolvedValueOnce({
      spaceId: SPACE_ID,
      workflowSlug: 'daily-metrics',
    } as never);
    trialRowMock.mockResolvedValueOnce(null);
    const app = await buildTestApp({ isServicePrincipal: false, db: fake.db });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/workflows/daily-metrics/eval-labels`,
      payload: {
        runId: 'run_1',
        batchId: '00000000-0000-4000-8000-0000000000b1',
        caseRevisionId: '00000000-0000-4000-8000-0000000000c1',
        trial: 1,
        criterionId: 'insight_quality',
        scopeKey: 'goal',
        verdict: 'fail',
        critique: 'The citation it accepted does not exist.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(fake.labelInserts[0]).toMatchObject({ verdict: 'fail' });
    expect(fake.labelInserts[0]?.['judgeLabel']).toBeUndefined();
    await app.close();
  });
});

describe('GET /:spaceId/workflows/:slug/golden-dataset', () => {
  const GET_URL = `/v1/spaces/${SPACE_ID}/workflows/my-skill/golden-dataset`;
  const DATASET_ID = '00000000-0000-4000-8000-0000000000d0';

  it('returns a null dataset instead of erroring when none exists yet', async () => {
    bundleMock.mockResolvedValueOnce({ ok: false, code: 'dataset_not_found' });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'GET', url: GET_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dataset: null, cases: [], drafts: [], unreadable: [] });
    await app.close();
  });

  it('returns the bundle — active cases at the resolved version plus drafts', async () => {
    bundleMock.mockResolvedValueOnce({
      ok: true,
      bundle: {
        dataset: {
          datasetId: DATASET_ID,
          spaceId: SPACE_ID,
          workflowSlug: 'my-skill',
          datasetVersion: 3,
        },
        resolvedVersion: 3,
        cases: [
          {
            revisionId: '00000000-0000-4000-8000-0000000000e1',
            caseId: CASE_ID,
            datasetId: DATASET_ID,
            addedInVersion: 1,
            status: 'active',
            case: { ...MINIMAL_CASE, caseId: CASE_ID, datasetId: DATASET_ID },
          },
        ],
        drafts: [],
        unreadable: [
          {
            revisionId: '00000000-0000-4000-8000-0000000000f1',
            caseId: '00000000-0000-4000-8000-0000000000f2',
            title: 'A case whose claim names nothing',
            reason: 'does not declare requirement r1',
            addedInVersion: 1,
            removedInVersion: null,
            status: 'active',
          },
        ],
      },
    } as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'GET', url: GET_URL });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      dataset: { datasetVersion: number } | null;
      resolvedVersion: number;
      cases: unknown[];
      unreadable: { caseId: string; reason: string }[];
    }>();
    expect(body.dataset?.datasetVersion).toBe(3);
    // A row that refuses a launch has to be reachable from the listing that
    // omits it, or the operator cannot find what is blocking them.
    expect(body.unreadable).toEqual([
      {
        revisionId: '00000000-0000-4000-8000-0000000000f1',
        caseId: '00000000-0000-4000-8000-0000000000f2',
        title: 'A case whose claim names nothing',
        reason: 'does not declare requirement r1',
      },
    ]);
    expect(body.resolvedVersion).toBe(3);
    expect(body.cases).toHaveLength(1);
    await app.close();
  });

  it('404s a version beyond the dataset head with the current head named', async () => {
    bundleMock.mockResolvedValueOnce({ ok: false, code: 'version_not_found', currentVersion: 3 });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'GET', url: `${GET_URL}?version=9` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'dataset_version_not_found' });
    await app.close();
  });
});
