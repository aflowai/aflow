/**
 * The queue submit boundary: agent principals are rejected outright, and the
 * label a submit produces carries the QUEUE ITEM's partition/stream fields —
 * the request body can never choose a partition (the D10 seam). The pending
 * listing carries the rubric and the judge's evidence (a human labeling from
 * different evidence than the judge saw confounds the scorecard) while still
 * withholding the judge's answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerEvalLabelQueueRoutes } from './evalLabelQueue.js';
import { insertEvalLabelRow } from '../../services/evalLabelWrite.js';
import {
  buildLabelQueueSubjectViews,
  getLabelQueueItemById,
  resolveLabelQueueItem,
  listLabelQueueItems,
} from '@aflow/cybernetic-runtime';

vi.mock('../../services/evalLabelWrite.js', () => ({
  insertEvalLabelRow: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getLabelQueueItemById: vi.fn(),
    resolveLabelQueueItem: vi.fn(),
    listLabelQueueItems: vi.fn(),
    buildLabelQueueSubjectViews: vi.fn(),
  };
});

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const ITEM_ID = '00000000-0000-4000-8000-0000000000e1';
const LABEL_ID = '00000000-0000-4000-8000-0000000000dd';
const BATCH_ID = '00000000-0000-4000-8000-0000000000b1';
const REV_ID = '00000000-0000-4000-8000-0000000000c1';

const PENDING_VALIDATION_ITEM = {
  id: ITEM_ID,
  spaceId: SPACE_ID,
  batchId: BATCH_ID,
  caseRevisionId: REV_ID,
  trial: 2,
  runId: 'run-7',
  criterionId: 'clarity',
  scopeKey: 'case_local',
  partition: 'validation',
  source: 'random_slice',
  inclusionProbability: '0.250000',
  judgeVersion: 'jv-1',
  status: 'pending',
  labelId: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  resolvedAt: null,
};

const retrieveSpy = vi.fn<(ref: string) => Promise<unknown>>();

async function buildTestApp(opts: {
  isServicePrincipal: boolean;
  withPayloadStore?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = {
    db: {},
    ...(opts.withPayloadStore === true ? { payloadStore: { retrieve: retrieveSpy } } : {}),
  };

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
      registerEvalLabelQueueRoutes(scope);
    },
    { prefix: '/v1/spaces' },
  );
  await app.ready();
  return app;
}

const insertMock = vi.mocked(insertEvalLabelRow);
const getItemMock = vi.mocked(getLabelQueueItemById);
const resolveMock = vi.mocked(resolveLabelQueueItem);
const listMock = vi.mocked(listLabelQueueItems);
const viewsMock = vi.mocked(buildLabelQueueSubjectViews);

beforeEach(() => {
  insertMock.mockReset();
  getItemMock.mockReset();
  resolveMock.mockReset();
  listMock.mockReset();
  viewsMock.mockReset();
  viewsMock.mockResolvedValue(new Map());
  retrieveSpy.mockReset();
});

describe('operator-only boundary', () => {
  it('rejects agent principals on list, label, and dismiss before touching anything', async () => {
    const app = await buildTestApp({ isServicePrincipal: true });
    const calls = [
      { method: 'GET' as const, url: `/v1/spaces/${SPACE_ID}/eval-label-queue` },
      {
        method: 'POST' as const,
        url: `/v1/spaces/${SPACE_ID}/eval-label-queue/${ITEM_ID}/label`,
        payload: { verdict: 'pass', critique: 'Looks correct.' },
      },
      {
        method: 'POST' as const,
        url: `/v1/spaces/${SPACE_ID}/eval-label-queue/${ITEM_ID}/dismiss`,
      },
    ];
    for (const call of calls) {
      const response = await app.inject(call);
      expect(response.statusCode, call.url).toBe(403);
      expect(response.json()).toMatchObject({ error: 'operator_only' });
    }
    expect(insertMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('list — the pre-label surface never reveals the judge verdict', () => {
  function listEntry(overrides: Record<string, unknown>): unknown {
    return {
      item: { ...PENDING_VALIDATION_ITEM, ...overrides },
      workflowSlug: 'summarize-weekly',
      caseTitle: 'Case A',
    };
  }

  it('withholds every stream field while pending — the enriched and the drawn row look alike', async () => {
    listMock.mockResolvedValue([
      listEntry({ id: ITEM_ID, source: 'judge_fail', partition: 'exemplar' }),
      listEntry({
        id: '00000000-0000-4000-8000-0000000000e2',
        source: 'judge_disagreement',
        partition: 'exemplar',
      }),
      listEntry({ id: '00000000-0000-4000-8000-0000000000e3', source: 'random_slice' }),
    ] as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=pending`,
    });
    expect(response.statusCode).toBe(200);
    const items = (
      response.json() as {
        items: Array<{
          source: string | null;
          partition: string | null;
          inclusionProbability: number | null;
        }>;
      }
    ).items;
    expect(items.map((i) => i.source)).toEqual([null, null, null]);
    expect(items.map((i) => i.partition)).toEqual([null, null, null]);
    expect(items.map((i) => i.inclusionProbability)).toEqual([null, null, null]);
    await app.close();
  });

  it('a resolved listing carries the full stream — the record returns after labeling', async () => {
    listMock.mockResolvedValue([
      listEntry({ source: 'judge_fail', partition: 'exemplar', status: 'labeled' }),
    ] as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=labeled`,
    });
    expect(response.statusCode).toBe(200);
    const items = (
      response.json() as {
        items: Array<{ source: string; partition: string; inclusionProbability: number | null }>;
      }
    ).items;
    expect(items.map((i) => i.source)).toEqual(['judge_fail']);
    expect(items.map((i) => i.partition)).toEqual(['exemplar']);
    expect(items[0]?.inclusionProbability).toBe(0.25);
    await app.close();
  });

  it('a pending item carries the rubric and the judge’s evidence, and still no judge answer', async () => {
    listMock.mockResolvedValue([
      listEntry({ source: 'judge_fail', partition: 'exemplar' }),
    ] as never);
    viewsMock.mockResolvedValue(
      new Map([
        [
          ITEM_ID,
          {
            rubric: {
              criterionId: 'clarity',
              scopeKey: 'case_local',
              name: 'clarity',
              entries: [
                { criterion: 'Reads clearly', scale: 'binary' as const, description: 'No jargon.' },
              ],
            },
            evidence: {
              status: 'available' as const,
              taskSummaries: [{ taskId: 'write', status: 'completed', summary: 'Wrote it.' }],
              taskOutputs: [{ taskId: 'write', content: '{"summary":"Revenue was 4.2M."}' }],
              referenceOutput: 'Revenue was 4.2M.',
              unresolvedArtifacts: 0,
            },
          },
        ],
      ]),
    );

    const app = await buildTestApp({ isServicePrincipal: false, withPayloadStore: true });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=pending`,
    });
    expect(response.statusCode).toBe(200);
    const item = (response.json() as { items: Array<Record<string, unknown>> }).items[0]!;

    expect(item['rubric']).toMatchObject({ name: 'clarity' });
    expect(item['evidence']).toMatchObject({ status: 'available' });
    expect((item['evidence'] as { taskOutputs: unknown[] }).taskOutputs).toHaveLength(1);

    // The answer stays withheld on every axis the judge could leak through —
    // an exemplar row is minted only from a judged 'fail', so the stream
    // fields name the verdict as surely as the verdict would.
    expect(item['source']).toBeNull();
    expect(item['partition']).toBeNull();
    expect(item['inclusionProbability']).toBeNull();
    expect(Object.keys(item)).not.toContain('verdict');
    expect(Object.keys(item)).not.toContain('rationale');
    expect(Object.keys(item)).not.toContain('score');
    expect(JSON.stringify(item)).not.toContain('judge_fail');
    expect(JSON.stringify(item)).not.toContain('exemplar');

    // The judge's own evidence — rebuilt through the configured payload store.
    expect(viewsMock).toHaveBeenCalledTimes(1);
    const args = viewsMock.mock.calls[0]![0];
    expect(args.subjects).toEqual([
      {
        itemId: ITEM_ID,
        caseRevisionId: REV_ID,
        runId: 'run-7',
        criterionId: 'clarity',
        scopeKey: 'case_local',
        workflowSlug: 'summarize-weekly',
        // Carried so the hydrator can detect a rubric edited since grading.
        judgeVersion: 'jv-1',
      },
    ]);
    await args.retrievePayload?.('inline:abc');
    expect(retrieveSpy).toHaveBeenCalledWith('inline:abc');
    await app.close();
  });

  it('a reaped trial run still lists, carrying the typed marker instead of empty evidence', async () => {
    listMock.mockResolvedValue([listEntry({})] as never);
    viewsMock.mockResolvedValue(
      new Map([
        [
          ITEM_ID,
          {
            rubric: { criterionId: 'clarity', scopeKey: 'case_local', entries: [] },
            evidence: {
              status: 'unavailable' as const,
              reason: 'run_reaped' as const,
              detail: "Trial run 'run-7' is gone — its fixture space was reaped.",
            },
          },
        ],
      ]),
    );

    const app = await buildTestApp({ isServicePrincipal: false, withPayloadStore: true });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=pending`,
    });
    expect(response.statusCode).toBe(200);
    const item = (response.json() as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item['evidence']).toEqual({
      status: 'unavailable',
      reason: 'run_reaped',
      detail: "Trial run 'run-7' is gone — its fixture space was reaped.",
    });
    await app.close();
  });

  it('a resolved listing is a record, not a labeling surface — no evidence is rebuilt', async () => {
    listMock.mockResolvedValue([listEntry({ status: 'labeled' })] as never);
    const app = await buildTestApp({ isServicePrincipal: false, withPayloadStore: true });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=labeled`,
    });
    expect(response.statusCode).toBe(200);
    const item = (response.json() as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item['rubric']).toBeUndefined();
    expect(item['evidence']).toBeUndefined();
    expect(viewsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes the workflowSlug filter through to the store — the per-skill inbox', async () => {
    listMock.mockResolvedValue([] as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue?status=pending&workflowSlug=summarize-weekly`,
    });
    expect(response.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledWith(expect.anything(), TENANT_ID, {
      spaceId: SPACE_ID,
      status: 'pending',
      batchId: undefined,
      workflowSlug: 'summarize-weekly',
      limit: 50,
    });
    await app.close();
  });
});

describe('submit stamps the label from the queue item', () => {
  it('partition/subject/judgeVersion come from the ITEM; verdict/critique from the body; labeledBy server-stamped', async () => {
    getItemMock.mockResolvedValue(PENDING_VALIDATION_ITEM as never);
    insertMock.mockResolvedValue({ ok: true, id: LABEL_ID });
    resolveMock.mockResolvedValue(true);

    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue/${ITEM_ID}/label`,
      payload: {
        verdict: 'fail',
        critique: 'The summary fabricates a number.',
        // A hostile caller trying to choose its partition is simply not a field.
        partition: 'exemplar',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: ITEM_ID, labelId: LABEL_ID });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = insertMock.mock.calls[0]![2];
    expect(values).toMatchObject({
      spaceId: SPACE_ID,
      batchId: BATCH_ID,
      caseRevisionId: REV_ID,
      trial: 2,
      runId: 'run-7',
      criterionId: 'clarity',
      scopeKey: 'case_local',
      partition: 'validation',
      judgeVersion: 'jv-1',
      verdict: 'fail',
      critique: 'The summary fabricates a number.',
      labeledByUserId: USER_ID,
    });
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), TENANT_ID, {
      spaceId: SPACE_ID,
      itemId: ITEM_ID,
      status: 'labeled',
      labelId: LABEL_ID,
    });
    await app.close();
  });

  it('an already-resolved item is a 409 and inserts nothing', async () => {
    getItemMock.mockResolvedValue({ ...PENDING_VALIDATION_ITEM, status: 'labeled' } as never);
    const app = await buildTestApp({ isServicePrincipal: false });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/eval-label-queue/${ITEM_ID}/label`,
      payload: { verdict: 'pass', critique: 'fine' },
    });
    expect(response.statusCode).toBe(409);
    expect(insertMock).not.toHaveBeenCalled();
    await app.close();
  });
});
