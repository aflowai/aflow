/**
 * GET /:spaceId/workflows/:slug/campaigns/:campaignId — workflow-scope boundary.
 *
 * The detail URL is workflow-scoped, so a campaign belonging to another
 * workflow (even in the same space) must 404 — `spaceId` alone is not enough.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Campaign } from '@aflow/schemas';

const mockGetCampaignInSpace = vi.fn();
const mockGetCampaignScoreSeries = vi.fn();
const mockListCampaigns = vi.fn();
const mockBuildCampaignView = vi.fn();
const mockStartCampaign = vi.fn();
const mockUpdateCampaign = vi.fn();
const mockEndCampaignInSpace = vi.fn();
const mockMaybeTriggerCampaignEndReview = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  getCampaignInSpace: (...a: unknown[]) => mockGetCampaignInSpace(...a),
  getCampaignScoreSeries: (...a: unknown[]) => mockGetCampaignScoreSeries(...a),
  listCampaigns: (...a: unknown[]) => mockListCampaigns(...a),
  buildCampaignView: (...a: unknown[]) => mockBuildCampaignView(...a),
  summarizeScoreSeries: () => ({ scoredRunCount: 0 }),
  recentSeriesTail: () => [],
  startCampaign: (...a: unknown[]) => mockStartCampaign(...a),
  updateCampaign: (...a: unknown[]) => mockUpdateCampaign(...a),
  endCampaignInSpace: (...a: unknown[]) => mockEndCampaignInSpace(...a),
  maybeTriggerCampaignEndReview: (...a: unknown[]) => mockMaybeTriggerCampaignEndReview(...a),
}));

const { registerWorkflowCampaignRoutes } = await import('./campaigns.js');

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const CAMPAIGN_ID = '00000000-0000-4000-8000-0000000000cc';

function makeCampaign(workflowSlug: string): Campaign {
  return {
    campaignId: CAMPAIGN_ID,
    spaceId: SPACE_ID,
    workflowSlug,
    goalRef: 'ref-1',
    scoreMetricKey: 'accuracy',
    direction: 'maximize',
    status: 'active',
    startedAt: '2026-06-22T00:00:00.000Z',
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = { db: {} as never, redis: {} as never };

  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: '00000000-0000-4000-8000-000000000001' });
  });

  registerWorkflowCampaignRoutes(app);
  await app.ready();
  return app;
}

describe('GET /:spaceId/workflows/:slug/campaigns/:campaignId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404s when the campaign belongs to a different workflow in the same space', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('other-skill'));
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NotFound' });
    expect(mockGetCampaignScoreSeries).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s when the campaign does not exist', async () => {
    mockGetCampaignInSpace.mockResolvedValue(null);
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}`,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the campaign when its workflowSlug matches the URL', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('my-skill'));
    mockGetCampaignScoreSeries.mockResolvedValue([]);
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      campaign: { campaignId: CAMPAIGN_ID, workflowSlug: 'my-skill' },
      scoreSummary: { scoredRunCount: 0 },
      recentSeries: [],
    });
    await app.close();
  });
});

describe('POST /:spaceId/workflows/:slug/campaigns (start)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a campaign and echoes created', async () => {
    mockStartCampaign.mockResolvedValue({
      ok: true,
      created: true,
      campaign: makeCampaign('my-skill'),
    });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns`,
      payload: { config: { competitionSlug: 'titanic', targetScore: 0.8 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { campaignId: CAMPAIGN_ID }, created: true });
    await app.close();
  });

  it('maps an engine error code to its HTTP status (404 for SKILL_NOT_FOUND)', async () => {
    mockStartCampaign.mockResolvedValue({
      ok: false,
      code: 'SKILL_NOT_FOUND',
      message: 'no skill owns this slug',
    });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'SKILL_NOT_FOUND' });
    await app.close();
  });

  it('maps CAMPAIGN_CONFIG_CONFLICT to 409 and carries details through', async () => {
    mockStartCampaign.mockResolvedValue({
      ok: false,
      code: 'CAMPAIGN_CONFIG_CONFLICT',
      message: 'active campaign exists',
      details: { campaignId: CAMPAIGN_ID, changedKeys: ['targetScore'] },
    });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns`,
      payload: { config: { competitionSlug: 'titanic', targetScore: 0.9 } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'CAMPAIGN_CONFIG_CONFLICT',
      details: { changedKeys: ['targetScore'] },
    });
    await app.close();
  });
});

describe('PATCH / end — workflow-scope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCH 404s when the campaign belongs to a different workflow', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('other-skill'));
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'PATCH',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}`,
      payload: { config: { targetScore: 0.9 } },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('PATCH updates when the workflow matches', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('my-skill'));
    mockUpdateCampaign.mockResolvedValue({
      ok: true,
      campaign: makeCampaign('my-skill'),
      changedKeys: ['targetScore'],
    });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'PATCH',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}`,
      payload: { config: { targetScore: 0.9 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changedKeys: ['targetScore'] });
    await app.close();
  });

  it('end 404s when the campaign belongs to a different workflow', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('other-skill'));
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}/end`,
      payload: { reason: 'explicit' },
    });

    expect(res.statusCode).toBe(404);
    expect(mockEndCampaignInSpace).not.toHaveBeenCalled();
    await app.close();
  });

  it('end returns the ended campaign and dispatches the synthesis review when THIS call ended it', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('my-skill'));
    mockEndCampaignInSpace.mockResolvedValue({
      ok: true,
      campaign: { ...makeCampaign('my-skill'), status: 'ended', endedReason: 'explicit' },
      endedNow: true,
    });
    mockMaybeTriggerCampaignEndReview.mockResolvedValue('coach-session-1');
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}/end`,
      payload: { reason: 'explicit' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { status: 'ended' } });
    expect(mockMaybeTriggerCampaignEndReview).toHaveBeenCalledOnce();
    expect(mockMaybeTriggerCampaignEndReview.mock.calls[0]![0]).toMatchObject({
      tenantId: '00000000-0000-4000-8000-000000000001',
      spaceId: SPACE_ID,
      workflowSlug: 'my-skill',
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
    });
    await app.close();
  });

  it('an already-ended campaign (idempotent reply) does NOT re-dispatch', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('my-skill'));
    mockEndCampaignInSpace.mockResolvedValue({
      ok: true,
      campaign: { ...makeCampaign('my-skill'), status: 'ended', endedReason: 'explicit' },
      endedNow: false,
    });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}/end`,
      payload: { reason: 'explicit' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    await app.close();
  });

  it('a failing dispatch is best-effort — the end still succeeds', async () => {
    mockGetCampaignInSpace.mockResolvedValue(makeCampaign('my-skill'));
    mockEndCampaignInSpace.mockResolvedValue({
      ok: true,
      campaign: { ...makeCampaign('my-skill'), status: 'ended', endedReason: 'explicit' },
      endedNow: true,
    });
    mockMaybeTriggerCampaignEndReview.mockRejectedValue(new Error('control stream down'));
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: `/${SPACE_ID}/workflows/my-skill/campaigns/${CAMPAIGN_ID}/end`,
      payload: { reason: 'explicit' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { status: 'ended' } });
    await app.close();
  });
});
