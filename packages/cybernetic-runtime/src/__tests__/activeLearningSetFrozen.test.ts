/**
 * Frozen-mode stationarity (Plan 269 D5): a run carrying `evalBatchId`
 * reads NO live learning state — the run-scoped selector returns the empty
 * set without touching the durable store, candidates, or campaign series.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetRunLearningScope = vi.fn();
const mockListTerminalRunLearnings = vi.fn();
vi.mock('../ledger/queries.js', () => ({
  getRunLearningScope: (...a: unknown[]) => mockGetRunLearningScope(...a),
  listTerminalRunLearningsForCampaign: (...a: unknown[]) => mockListTerminalRunLearnings(...a),
}));

const mockLoadSpaceDirectives = vi.fn();
vi.mock('../modelResolution.js', () => ({
  loadSpaceDirectives: (...a: unknown[]) => mockLoadSpaceDirectives(...a),
}));

const mockCountDurable = vi.fn();
const mockListDurable = vi.fn();
vi.mock('../coachLearningsStore.js', () => ({
  countDurableCoachLearnings: (...a: unknown[]) => mockCountDurable(...a),
  listDurableCoachLearnings: (...a: unknown[]) => mockListDurable(...a),
}));

const mockGetCampaignById = vi.fn();
vi.mock('../campaigns.js', () => ({
  getCampaignById: (...a: unknown[]) => mockGetCampaignById(...a),
  getCampaignScoreSeries: vi.fn().mockResolvedValue([]),
  listCampaigns: vi.fn().mockResolvedValue([]),
}));

vi.mock('../candidateLearnings.js', () => ({
  listCandidatesByCampaign: vi.fn().mockResolvedValue([]),
}));

import { selectActiveLearningSetForRun } from '../activeLearningSet.js';

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSpaceDirectives.mockResolvedValue(null);
  mockCountDurable.mockResolvedValue(0);
  mockListDurable.mockResolvedValue([]);
  mockGetCampaignById.mockResolvedValue(null);
});

describe('selectActiveLearningSetForRun — frozen mode', () => {
  it('a run with evalBatchId set injects nothing and reads no live state', async () => {
    mockGetRunLearningScope.mockResolvedValueOnce({
      campaignId: 'camp-1',
      evalBatchId: 'batch-1',
    });

    const result = await selectActiveLearningSetForRun({
      db,
      tenantId: 't',
      spaceId: 's',
      skillSlug: 'daily-metrics',
      runId: 'run-frozen',
    });

    expect(result).toEqual({ selected: [], omittedDueToBudget: 0, consolidationDue: false });
    expect(mockLoadSpaceDirectives).not.toHaveBeenCalled();
    expect(mockListDurable).not.toHaveBeenCalled();
    expect(mockGetCampaignById).not.toHaveBeenCalled();
  });

  it('a production run (evalBatchId null) reads through as before', async () => {
    mockGetRunLearningScope.mockResolvedValueOnce({ campaignId: null, evalBatchId: null });

    const result = await selectActiveLearningSetForRun({
      db,
      tenantId: 't',
      spaceId: 's',
      skillSlug: 'daily-metrics',
      runId: 'run-prod',
    });

    expect(result.selected).toEqual([]);
    expect(mockLoadSpaceDirectives).toHaveBeenCalledOnce();
    expect(mockListDurable).toHaveBeenCalledOnce();
  });
});
