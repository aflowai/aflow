import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Campaign } from '@aflow/schemas';

const mockGetCampaignInSpace = vi.fn();
const mockEndCampaign = vi.fn();
const mockGetCampaignById = vi.fn();
const mockResolveSkillForWorkflow = vi.fn();
const mockGetActiveCampaign = vi.fn();
const mockEnsureActiveCampaign = vi.fn();

vi.mock('../campaignViews.js', async () => {
  const actual = await vi.importActual<typeof import('../campaignViews.js')>('../campaignViews.js');
  return { ...actual, getCampaignInSpace: (...a: unknown[]) => mockGetCampaignInSpace(...a) };
});
vi.mock('../campaigns.js', async () => {
  const actual = await vi.importActual<typeof import('../campaigns.js')>('../campaigns.js');
  return {
    ...actual,
    endCampaign: (...a: unknown[]) => mockEndCampaign(...a),
    getCampaignById: (...a: unknown[]) => mockGetCampaignById(...a),
    getActiveCampaign: (...a: unknown[]) => mockGetActiveCampaign(...a),
    ensureActiveCampaign: (...a: unknown[]) => mockEnsureActiveCampaign(...a),
  };
});
vi.mock('../skill.js', async () => {
  const actual = await vi.importActual<typeof import('../skill.js')>('../skill.js');
  return {
    ...actual,
    resolveSkillForWorkflow: (...a: unknown[]) => mockResolveSkillForWorkflow(...a),
  };
});

const { updateCampaign, endCampaignInSpace, startCampaign, createContractedCampaign } =
  await import('../campaignOperations.js');

const DB = {} as never;
const TENANT = 'tenant-1';
const SPACE = 'space-1';

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaignId: '00000000-0000-4000-8000-0000000000cc',
    spaceId: SPACE,
    workflowSlug: 'my-skill',
    goalRef: 'ref',
    scoreMetricKey: 'accuracy',
    direction: 'maximize',
    status: 'active',
    startedAt: '2026-06-22T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateCampaign — guards', () => {
  it('CAMPAIGN_NOT_FOUND when the campaign is not in the space', async () => {
    mockGetCampaignInSpace.mockResolvedValue(null);
    const r = await updateCampaign(DB, TENANT, { spaceId: SPACE, campaignId: 'x', config: {} });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_NOT_FOUND' });
  });

  it('CAMPAIGN_ENDED when the campaign has already ended', async () => {
    mockGetCampaignInSpace.mockResolvedValue(campaign({ status: 'ended' }));
    const r = await updateCampaign(DB, TENANT, { spaceId: SPACE, campaignId: 'x', config: {} });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_ENDED' });
  });
});

describe('endCampaignInSpace', () => {
  it('CAMPAIGN_NOT_FOUND when absent from the space', async () => {
    mockGetCampaignInSpace.mockResolvedValue(null);
    const r = await endCampaignInSpace(DB, TENANT, {
      spaceId: SPACE,
      campaignId: 'x',
      reason: 'explicit',
    });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_NOT_FOUND' });
    expect(mockEndCampaign).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-ended campaign returns unchanged without a write', async () => {
    const ended = campaign({ status: 'ended', endedReason: 'goal_met' });
    mockGetCampaignInSpace.mockResolvedValue(ended);
    const r = await endCampaignInSpace(DB, TENANT, {
      spaceId: SPACE,
      campaignId: ended.campaignId,
      reason: 'explicit',
    });
    expect(r).toEqual({ ok: true, campaign: ended, endedNow: false });
    expect(mockEndCampaign).not.toHaveBeenCalled();
  });

  it('ends an active campaign and returns the ended row with endedNow', async () => {
    mockGetCampaignInSpace.mockResolvedValue(campaign());
    const ended = campaign({ status: 'ended', endedReason: 'explicit' });
    mockEndCampaign.mockResolvedValue(ended);
    const r = await endCampaignInSpace(DB, TENANT, {
      spaceId: SPACE,
      campaignId: ended.campaignId,
      reason: 'explicit',
    });
    expect(r).toEqual({ ok: true, campaign: ended, endedNow: true });
    expect(mockEndCampaign).toHaveBeenCalledTimes(1);
  });

  it('CAS miss (concurrent end) re-reads for the idempotent reply', async () => {
    mockGetCampaignInSpace.mockResolvedValue(campaign());
    mockEndCampaign.mockResolvedValue(null);
    const reread = campaign({ status: 'ended', endedReason: 'budget' });
    mockGetCampaignById.mockResolvedValue(reread);
    const r = await endCampaignInSpace(DB, TENANT, {
      spaceId: SPACE,
      campaignId: reread.campaignId,
      reason: 'explicit',
    });
    expect(r).toEqual({ ok: true, campaign: reread, endedNow: false });
  });
});

describe('startCampaign — config-less skill', () => {
  it('rejects config for a skill with no campaign contract', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: { goal: { type: 'numeric', metricKey: 'accuracy', direction: 'maximize' } },
    });
    const r = await startCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'my-skill',
      config: { foo: 1 },
    });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_CONTRACT_MISSING' });
  });

  it('SKILL_NOT_FOUND when no skill owns the slug', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(null);
    const r = await startCampaign(DB, TENANT, { spaceId: SPACE, slug: 'nope' });
    expect(r).toMatchObject({ ok: false, code: 'SKILL_NOT_FOUND' });
  });
});

describe('createContractedCampaign — objective (process) goal', () => {
  const OBJECTIVE_GOAL = {
    type: 'objective' as const,
    criteria: [{ id: 'pr-opened', description: 'A PR is opened.' }],
  };
  const CONTRACT = {
    fields: {
      repoBindingId: {
        schema: { type: 'string', minLength: 1 },
        identity: true,
        label: 'Repo binding',
      },
    },
  };

  it('creates a process campaign with scoreMetricKey="completion" + direction="maximize"', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    mockEnsureActiveCampaign.mockImplementation((_db, _t, p) =>
      Promise.resolve(
        campaign({
          campaignId: '00000000-0000-4000-8000-0000000000aa',
          workflowSlug: 'open-pr-from-request',
          goalRef: p.goalRef,
          scoreMetricKey: p.scoreMetricKey,
          direction: p.direction,
          config: p.config,
        }),
      ),
    );

    const r = await createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'open-pr-from-request',
      goal: OBJECTIVE_GOAL,
      contract: CONTRACT,
      config: { repoBindingId: 'repo-binding-123' },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.created).toBe(true);
    expect(r.campaign.scoreMetricKey).toBe('completion');
    expect(r.campaign.direction).toBe('maximize');
    // The score columns passed to ensureActiveCampaign are NOT-NULL sentinels.
    const ensureParams = mockEnsureActiveCampaign.mock.calls[0]![2] as Record<string, unknown>;
    expect(ensureParams['scoreMetricKey']).toBe('completion');
    expect(ensureParams['direction']).toBe('maximize');
    // repoBindingId is an IDENTITY field → the goalRef carries a per-repo suffix.
    expect(ensureParams['goalRef']).toMatch(/^open-pr-from-request:objective:.+$/);
  });

  it('campaign-per-repo: two different repoBindingId values yield two DISTINCT campaigns', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    const goalRefs: string[] = [];
    mockEnsureActiveCampaign.mockImplementation((_db, _t, p) => {
      goalRefs.push(p.goalRef as string);
      return Promise.resolve(
        campaign({
          campaignId: '00000000-0000-4000-8000-0000000000cc',
          workflowSlug: 'open-pr-from-request',
          goalRef: p.goalRef,
          scoreMetricKey: p.scoreMetricKey,
          direction: p.direction,
          config: p.config,
        }),
      );
    });

    for (const repoBindingId of ['repo-a', 'repo-b']) {
      await createContractedCampaign(DB, TENANT, {
        spaceId: SPACE,
        slug: 'open-pr-from-request',
        goal: OBJECTIVE_GOAL,
        contract: CONTRACT,
        config: { repoBindingId },
      });
    }

    expect(goalRefs).toHaveLength(2);
    // Distinct identity ⇒ distinct goalRef ⇒ a separate campaign per repo (no
    // collision, no wrong-repo reuse).
    expect(goalRefs[0]).not.toBe(goalRefs[1]);
  });

  it('reuse-on-identity: an existing active process campaign returns created:false', async () => {
    const existing = campaign({
      campaignId: '00000000-0000-4000-8000-0000000000bb',
      workflowSlug: 'open-pr-from-request',
      goalRef: 'open-pr-from-request:objective',
      scoreMetricKey: 'completion',
      direction: 'maximize',
      config: { repoBindingId: 'repo-binding-123' },
    });
    mockGetActiveCampaign.mockResolvedValue(existing);

    const r = await createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'open-pr-from-request',
      goal: OBJECTIVE_GOAL,
      contract: CONTRACT,
      config: { repoBindingId: 'repo-binding-123' },
    });

    expect(r).toMatchObject({ ok: true, created: false });
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('CAMPAIGN_CONFIG_INVALID when a required contract field is missing', async () => {
    const r = await createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'open-pr-from-request',
      goal: OBJECTIVE_GOAL,
      contract: CONTRACT,
      config: {},
    });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_CONFIG_INVALID' });
  });
});
