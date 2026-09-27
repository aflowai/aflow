/**
 * The eval-batch kill switch (Plan 269 D17): cancellation exists only as
 * operator REST — agent principals are rejected at the boundary, a
 * cancellable batch flips to 'cancelling' for the engine to drain,
 * re-cancelling is idempotent, and a terminal batch refuses with its
 * status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerEvalBatchRoutes } from './evalBatches.js';
import {
  buildEvalBatchDetail,
  buildEvalBatchList,
  buildEvalTrialDetail,
  computeEvalBatchPreflightEstimate,
  getEvalBatchHead,
  launchEvalBatch,
  requestEvalBatchCancel,
  resolveEvalBatchComparison,
} from '@aflow/cybernetic-runtime';

vi.mock('@aflow/cybernetic-runtime', () => ({
  buildEvalBatchDetail: vi.fn(),
  buildEvalBatchList: vi.fn(),
  buildEvalTrialDetail: vi.fn(),
  computeEvalBatchPreflightEstimate: vi.fn(),
  getEvalBatchHead: vi.fn(),
  launchEvalBatch: vi.fn(),
  requestEvalBatchCancel: vi.fn(),
  resolveEvalBatchComparison: vi.fn(),
}));

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const BATCH_ID = '00000000-0000-4000-8000-0000000000cf';
const DATASET_ID = '00000000-0000-4000-8000-0000000000d0';
const SLUG = 'my-skill';

const headMock = vi.mocked(getEvalBatchHead);
const cancelMock = vi.mocked(requestEvalBatchCancel);
const detailMock = vi.mocked(buildEvalBatchDetail);
const trialDetailMock = vi.mocked(buildEvalTrialDetail);
const listMock = vi.mocked(buildEvalBatchList);
const launchMock = vi.mocked(launchEvalBatch);
const compareMock = vi.mocked(resolveEvalBatchComparison);
const preflightMock = vi.mocked(computeEvalBatchPreflightEstimate);

const HEAD_VIEW = {
  batchId: BATCH_ID,
  workflowSlug: SLUG,
  workflowRevision: 3,
  datasetId: DATASET_ID,
  datasetVersion: 2,
  status: 'completed' as const,
  trialsPerCase: 1,
  caseCount: 4,
  costCeilingCents: 500,
  costSpentCents: 12,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const RUN_OUTPUT = {
  batchId: BATCH_ID,
  workflowSlug: SLUG,
  workflowRevision: 3,
  datasetId: DATASET_ID,
  datasetVersion: 2,
  caseCount: 4,
  trialsPerCase: 3,
  totalTrials: 12,
  status: 'queued' as const,
  preflight: {
    perRunMedianCents: 10,
    sampleSize: 5,
    estimatedCostCents: 120,
    costCeilingCents: 500,
  },
  summary: 'Queued eval batch.',
};

async function buildTestApp(opts: { isServicePrincipal: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };

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
      registerEvalBatchRoutes(scope);
    },
    { prefix: '/v1/spaces' },
  );
  await app.ready();
  return app;
}

const CANCEL_URL = `/v1/spaces/${SPACE_ID}/eval-batches/${BATCH_ID}/cancel`;

beforeEach(() => {
  headMock.mockReset();
  cancelMock.mockReset();
  detailMock.mockReset();
  listMock.mockReset();
  launchMock.mockReset();
  compareMock.mockReset();
  preflightMock.mockReset();
});

describe('POST /:spaceId/eval-batches/:batchId/cancel', () => {
  it('rejects a service-principal caller before any store call', async () => {
    const app = await buildTestApp({ isServicePrincipal: true });
    const response = await app.inject({ method: 'POST', url: CANCEL_URL });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'operator_only' });
    expect(headMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flips a running batch to cancelling', async () => {
    headMock.mockResolvedValueOnce({ id: BATCH_ID, status: 'running' } as never);
    cancelMock.mockResolvedValueOnce(true);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'POST', url: CANCEL_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: 'cancelling' });
    expect(cancelMock).toHaveBeenCalledWith({}, TENANT_ID, {
      spaceId: SPACE_ID,
      batchId: BATCH_ID,
    });
    await app.close();
  });

  it('404s for a batch outside this space', async () => {
    headMock.mockResolvedValueOnce(null);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'POST', url: CANCEL_URL });
    expect(response.statusCode).toBe(404);
    expect(cancelMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('re-cancelling an already-cancelling batch is idempotent', async () => {
    headMock
      .mockResolvedValueOnce({ id: BATCH_ID, status: 'cancelling' } as never)
      .mockResolvedValueOnce({ id: BATCH_ID, status: 'cancelling' } as never);
    cancelMock.mockResolvedValueOnce(false);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'POST', url: CANCEL_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: 'cancelling' });
    await app.close();
  });

  it('409s a terminal batch with its status', async () => {
    headMock
      .mockResolvedValueOnce({ id: BATCH_ID, status: 'completed' } as never)
      .mockResolvedValueOnce({ id: BATCH_ID, status: 'completed' } as never);
    cancelMock.mockResolvedValueOnce(false);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({ method: 'POST', url: CANCEL_URL });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'not_cancellable', status: 'completed' });
    await app.close();
  });
});

describe('GET /:spaceId/eval-batches (+ /:batchId)', () => {
  it('lists batches through the shared view assembly', async () => {
    listMock.mockResolvedValueOnce([HEAD_VIEW]);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-batches?workflowSlug=${SLUG}&limit=5`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ batches: [HEAD_VIEW] });
    expect(listMock).toHaveBeenCalledWith({}, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      limit: 5,
    });
    await app.close();
  });

  it('returns the batch detail and 404s an unknown batch', async () => {
    detailMock
      .mockResolvedValueOnce({
        batch: HEAD_VIEW,
        provenanceManifest: {
          workflow: { slug: SLUG, revision: 3, configHash: 'abc' },
          dataset: { datasetId: DATASET_ID, datasetVersion: 2 },
          subjectModels: [],
          platform: {},
          caseFixtureHashes: {},
          caseContentHashes: {},
          agentVersions: {},
          sealedSources: {},
          graderVersion: 'grader-v1',
          judgeVersions: {},
        },
        caseResults: [],
      })
      .mockResolvedValueOnce(null);
    const app = await buildTestApp({ isServicePrincipal: false });

    const found = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-batches/${BATCH_ID}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ batch: { batchId: BATCH_ID }, caseResults: [] });

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-batches/${BATCH_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'batch_not_found' });
    await app.close();
  });
});

describe('GET /:spaceId/eval-batches/:batchId/comparison', () => {
  const COMPARISON = {
    batchA: {
      batchId: DATASET_ID,
      datasetVersion: 2,
      workflowRevision: 2,
      trialsPerCase: 1,
      status: 'completed' as const,
    },
    batchB: {
      batchId: BATCH_ID,
      datasetVersion: 2,
      workflowRevision: 3,
      trialsPerCase: 1,
      status: 'completed' as const,
    },
    identicalDatasetVersion: true,
    identicalTrialsPerCase: true,
    pairedCases: 4,
    bootstrapResamples: 1000,
    flips: [],
    excluded: { added: [], removed: [], edited: [], undecided: [], unresolvedRevisionIds: [] },
    changedDimensions: [],
    uncertaintyNote: 'n=4 paired cases — small; intervals are wide.',
  };

  it('defaults to the baseline form and returns the comparison', async () => {
    compareMock.mockResolvedValueOnce({
      ok: true,
      comparison: COMPARISON,
      baselineBatchId: DATASET_ID,
      graduationCandidates: [],
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-batches/${BATCH_ID}/comparison`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      comparison: { pairedCases: 4 },
      baselineBatchId: DATASET_ID,
    });
    expect(compareMock).toHaveBeenCalledWith({}, TENANT_ID, SPACE_ID, {
      batchId: BATCH_ID,
      against: 'baseline',
    });
    await app.close();
  });

  it('maps an explicit reference to the pair form and refusals to 409', async () => {
    compareMock.mockResolvedValueOnce({
      ok: false,
      code: 'EVAL_BATCH_NOT_TERMINAL',
      message: 'still arriving',
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-batches/${BATCH_ID}/comparison?againstBatchId=${DATASET_ID}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'EVAL_BATCH_NOT_TERMINAL' });
    expect(compareMock).toHaveBeenCalledWith({}, TENANT_ID, SPACE_ID, {
      batchIdA: DATASET_ID,
      batchIdB: BATCH_ID,
    });
    await app.close();
  });
});

describe('POST /:spaceId/workflows/:slug/eval-batches (launch)', () => {
  const LAUNCH_URL = `/v1/spaces/${SPACE_ID}/workflows/${SLUG}/eval-batches`;

  it('rejects a service-principal caller before the launcher runs', async () => {
    const app = await buildTestApp({ isServicePrincipal: true });
    const response = await app.inject({
      method: 'POST',
      url: LAUNCH_URL,
      payload: { costCeilingCents: 500 },
    });
    expect(response.statusCode).toBe(403);
    expect(launchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('launches with the path slug and the operator stamped as creator', async () => {
    launchMock.mockResolvedValueOnce({ ok: true, output: RUN_OUTPUT });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'POST',
      url: LAUNCH_URL,
      payload: { trialsPerCase: 3, costCeilingCents: 500 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ batchId: BATCH_ID, status: 'queued' });
    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db: {},
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        input: { trialsPerCase: 3, costCeilingCents: 500, workflowSlug: SLUG },
        createdByUserId: USER_ID,
        // The judge probe is a closure over the request's tenant and space;
        // asserting it is supplied is the contract, its identity is not.
        probeJudgeCredential: expect.any(Function),
      }),
    );
    await app.close();
  });

  it('refuses a launch whose dataset is only partly readable, rather than measuring the rest', async () => {
    // A read that survives a malformed row keeps one bad case from failing
    // every batch; running anyway would report a case count quietly short of
    // the suite, with nothing downstream able to tell.
    launchMock.mockResolvedValueOnce({
      ok: false,
      code: 'EVAL_BATCH_UNREADABLE_CASE',
      message: "1 case(s) in 'cs-desk-conversation' cannot be read",
    });
    const app = await buildTestApp({ isServicePrincipal: false });

    const res = await app.inject({
      method: 'POST',
      url: LAUNCH_URL,
      payload: { costCeilingCents: 500 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'EVAL_BATCH_UNREADABLE_CASE' });
  });

  it('maps launcher refusals onto teaching statuses', async () => {
    launchMock
      .mockResolvedValueOnce({
        ok: false,
        code: 'EVAL_BATCH_COST_PREFLIGHT_EXCEEDS_CEILING',
        message: 'estimate exceeds ceiling',
      })
      .mockResolvedValueOnce({
        ok: false,
        code: 'EVAL_BATCH_WORKFLOW_NOT_FOUND',
        message: 'no such skill',
      });
    const app = await buildTestApp({ isServicePrincipal: false });

    const exceeded = await app.inject({
      method: 'POST',
      url: LAUNCH_URL,
      payload: { costCeilingCents: 1 },
    });
    expect(exceeded.statusCode).toBe(422);
    expect(exceeded.json()).toMatchObject({ error: 'EVAL_BATCH_COST_PREFLIGHT_EXCEEDS_CEILING' });

    const missing = await app.inject({
      method: 'POST',
      url: LAUNCH_URL,
      payload: { costCeilingCents: 500 },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /:spaceId/workflows/:slug/eval-batch-preflight', () => {
  it('echoes the estimate for the requested trial count', async () => {
    preflightMock.mockResolvedValueOnce({
      ok: true,
      caseCount: 4,
      resolvedVersion: 2,
      preflight: {
        perRunMedianCents: 10,
        sampleSize: 5,
        estimatedCostCents: 120,
        exceedsCeiling: false,
      },
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/workflows/${SLUG}/eval-batch-preflight?trialsPerCase=3`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      caseCount: 4,
      resolvedVersion: 2,
      perRunMedianCents: 10,
      sampleSize: 5,
      estimatedCostCents: 120,
    });
    expect(preflightMock).toHaveBeenCalledWith({}, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      trialsPerCase: 3,
      datasetVersion: undefined,
    });
    await app.close();
  });

  it('404s when no dataset exists to estimate against', async () => {
    preflightMock.mockResolvedValueOnce({
      ok: false,
      code: 'EVAL_DATASET_NOT_FOUND',
      message: 'no dataset',
    });
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/workflows/${SLUG}/eval-batch-preflight`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'EVAL_DATASET_NOT_FOUND' });
    await app.close();
  });
});
