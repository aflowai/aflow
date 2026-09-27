import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Campaign } from '@aflow/schemas';
import { configureLogging } from '@aflow/observability';

const mockGetRunCampaignId = vi.fn();
const mockGetCampaignById = vi.fn();
const mockEnsureActiveCampaign = vi.fn();
const mockUpdateRunMetadata = vi.fn();

vi.mock('../campaigns.js', () => ({
  getCampaignById: (...args: unknown[]) => mockGetCampaignById(...args),
  getActiveCampaign: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
  endCampaign: vi.fn(),
  ensureActiveCampaign: (...args: unknown[]) => mockEnsureActiveCampaign(...args),
  listCampaigns: vi.fn(),
  updateCampaignConfig: vi.fn(),
  clearCampaignMemoEntries: vi.fn(),
}));

vi.mock('../ledger/queries.js', () => ({
  getRunCampaignId: (...args: unknown[]) => mockGetRunCampaignId(...args),
}));

vi.mock('../ledger/runs.js', () => ({
  updateRunMetadata: (...args: unknown[]) => mockUpdateRunMetadata(...args),
}));

vi.mock('../skill.js', () => ({
  resolveSkillForWorkflow: vi.fn().mockResolvedValue({
    manifest: {
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' },
    },
  }),
}));

vi.mock('../candidateLearnings.js', () => ({
  writeCandidateLearnings: vi.fn().mockResolvedValue([]),
}));

vi.mock('@aflow/database', () => ({
  resolveWorkflowForStart: vi.fn().mockResolvedValue(null),
}));

import { prepareRunScoring } from '../scoreFinalize.js';

const DB = {} as unknown as PostgresJsDatabase;
const CAMPAIGN: Campaign = {
  campaignId: '33333333-3333-3333-3333-333333333333',
  spaceId: '22222222-2222-2222-2222-222222222222',
  workflowSlug: 'kaggle-competition-optimizer',
  goalRef: 'kaggle-competition-optimizer:numeric:lbValue:maximize:abc',
  scoreMetricKey: 'lbValue',
  direction: 'maximize',
  config: { competitionSlug: 'titanic' },
  status: 'active',
  startedAt: '2026-06-11T00:00:00.000Z',
};

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prepareRunScoring (Plan 195 §4.5 cutover)', () => {
  it('reads run.campaignId and returns the linked campaign', async () => {
    mockGetRunCampaignId.mockResolvedValue(CAMPAIGN.campaignId);
    mockGetCampaignById.mockResolvedValue(CAMPAIGN);

    const result = await prepareRunScoring({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-1',
      taskResults: [],
    });

    expect(mockGetRunCampaignId).toHaveBeenCalledWith(DB, 't-1', 'run-1');
    expect(mockGetCampaignById).toHaveBeenCalledWith(DB, 't-1', CAMPAIGN.campaignId);
    expect(result.campaign).toEqual(CAMPAIGN);
  });

  it('NEVER creates campaigns or patches campaignId at scoring time', async () => {
    mockGetRunCampaignId.mockResolvedValue(CAMPAIGN.campaignId);
    mockGetCampaignById.mockResolvedValue(CAMPAIGN);

    await prepareRunScoring({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-1',
      taskResults: [],
    });

    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(mockUpdateRunMetadata).not.toHaveBeenCalled();
  });

  it('returns campaign: null (no creation) when a numeric-goal run carries no campaignId', async () => {
    mockGetRunCampaignId.mockResolvedValue(null);

    const result = await prepareRunScoring({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-2',
      taskResults: [],
    });

    expect(result.campaign).toBeNull();
    expect(result.goal).toEqual({ type: 'numeric', metricKey: 'lbValue', direction: 'maximize' });
    expect(mockGetCampaignById).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });
});

describe('grep gate — acceptance 4b', () => {
  it('scoreFinalize.ts contains no ensureActiveCampaign call', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../scoreFinalize.ts'), 'utf8');
    expect(source.includes('ensureActiveCampaign')).toBe(false);
  });
});
