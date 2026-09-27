/**
 * The per-trial attribution view (Plan 300 §5.6).
 *
 * Two invariants here are ones the view got wrong first, and both are silent
 * failures — a consumer reading the wrong answer with no error anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';

vi.mock('../evalBatchStore.js', () => ({
  getEvalBatchHead: vi.fn(),
  getGoldenCaseRevisionsByIds: vi.fn(),
  listTrialRows: vi.fn(),
  getTrialRow: vi.fn(),
  loadTrialRunSnapshot: vi.fn(),
  getEvalBaseline: vi.fn(),
  listEvalBatchMemberRevisionIds: vi.fn(),
  listEvalBatches: vi.fn(),
}));
vi.mock('../judgeScorecardBuild.js', () => ({ buildJudgeScorecardsForBatch: vi.fn() }));
vi.mock('../modelResolution.js', () => ({ loadSpaceDirectives: vi.fn() }));

import {
  getEvalBatchHead,
  getTrialRow,
  getGoldenCaseRevisionsByIds,
  listTrialRows,
  loadTrialRunSnapshot,
} from '../evalBatchStore.js';
import { buildEvalTrialDetail } from '../evalBatchView.js';

const DB = {} as PostgresJsDatabase;
const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '00000000-0000-4000-8000-0000000000a1';
const BATCH = '00000000-0000-4000-8000-0000000000cf';
const CASE = '00000000-0000-4000-8000-0000000000d1';
const PAUSE_REF = 'inline:pause';

const headMock = vi.mocked(getEvalBatchHead);
const rowMock = vi.mocked(getTrialRow);
const revisionsMock = vi.mocked(getGoldenCaseRevisionsByIds);
const snapshotMock = vi.mocked(loadTrialRunSnapshot);

function call(endpointId: string, ordinal: number) {
  return {
    simulationId: 'cs-desk',
    endpointId,
    responseStatus: 200,
    responseRef: null,
    deltaRef: null,
    ordinal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  headMock.mockResolvedValue({ id: BATCH } as never);
  revisionsMock.mockResolvedValue(new Map([[CASE, { case: { title: 'A case' } }]]) as never);
  rowMock.mockResolvedValue({
    caseRevisionId: CASE,
    trial: 1,
    disposition: 'graded',
    verdict: 'fail',
    runId: 'run-1',
    costCents: 3,
    resultsJson: {
      expectationResults: [
        { expectationIndex: 0, kind: 'simulation', passed: false, detail: 'never called' },
      ],
      fractionPassed: 0,
      fixtureTier: 'sealed',
      costObserved: true,
      pendingRubrics: [],
      rubricResults: [],
    },
  } as never);
  snapshotMock.mockResolvedValue({
    run: { status: 'paused', pausedPayloadRef: PAUSE_REF },
    tasks: [],
    // Journal order, and deliberately NOT ordinal order: the second call is a
    // different endpoint so its per-endpoint ordinal is also 0.
    simulationCalls: [
      call('payments_search', 0),
      call('orders_select', 0),
      call('payments_search', 1),
    ],
  } as never);
});

describe('buildEvalTrialDetail', () => {
  it('numbers the trajectory by journal position, not by the per-endpoint ordinal', async () => {
    // Sorting by `ordinal` interleaves endpoints and reports an order the run
    // never took — two of these three calls share ordinal 0.
    const detail = await buildEvalTrialDetail(DB, TENANT, {
      spaceId: SPACE,
      batchId: BATCH,
      caseRevisionId: CASE,
      trial: 1,
    });
    expect(detail?.trajectory.map((c) => [c.sequence, c.endpointId])).toEqual([
      [0, 'payments_search'],
      [1, 'orders_select'],
      [2, 'payments_search'],
    ]);
  });

  it('reports an unresolved reply as a ref rather than as silence', async () => {
    // "Said nothing" and "not fetched" lead to opposite conclusions, so the
    // reader without a payload store must be able to tell which it has.
    const detail = await buildEvalTrialDetail(DB, TENANT, {
      spaceId: SPACE,
      batchId: BATCH,
      caseRevisionId: CASE,
      trial: 1,
    });
    expect(detail?.reply).toBeUndefined();
    expect(detail?.replyRef).toBe(PAUSE_REF);
  });

  it('resolves the reply when given a payload store', async () => {
    const detail = await buildEvalTrialDetail(
      DB,
      TENANT,
      { spaceId: SPACE, batchId: BATCH, caseRevisionId: CASE, trial: 1 },
      { retrievePayload: () => Promise.resolve({ prompt: 'I could not find that payment.' }) },
    );
    expect(detail?.reply).toBe('I could not find that payment.');
  });

  it('keeps the trajectory when the payload fetch fails', async () => {
    // The trajectory is usually what the caller came for; a payload outage
    // must not cost it.
    const detail = await buildEvalTrialDetail(
      DB,
      TENANT,
      { spaceId: SPACE, batchId: BATCH, caseRevisionId: CASE, trial: 1 },
      { retrievePayload: () => Promise.reject(new Error('gcs down')) },
    );
    expect(detail?.trajectory).toHaveLength(3);
    expect(detail?.reply).toBeUndefined();
    expect(detail?.replyRef).toBe(PAUSE_REF);
  });

  it('returns null for a batch the space does not own', async () => {
    headMock.mockResolvedValue(null);
    await expect(
      buildEvalTrialDetail(DB, TENANT, {
        spaceId: SPACE,
        batchId: BATCH,
        caseRevisionId: CASE,
        trial: 1,
      }),
    ).resolves.toBeNull();
  });

  it('returns null for a trial the batch does not have', async () => {
    rowMock.mockResolvedValue(null);
    await expect(
      buildEvalTrialDetail(DB, TENANT, {
        spaceId: SPACE,
        batchId: BATCH,
        caseRevisionId: CASE,
        trial: 9,
      }),
    ).resolves.toBeNull();
  });
});
