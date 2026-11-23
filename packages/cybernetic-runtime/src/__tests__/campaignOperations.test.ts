import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import {
  SkillCampaignContractSchema,
  registerCampaignStartCheck,
  registerCampaignStartMigration,
  registerRuntimeValidator,
  registerValidator,
  type Campaign,
  type CampaignStartMigrationContext,
} from '@aflow/schemas';
import { buildCampaignRequiredErrorDetails } from '../campaignConfig.js';

const mockGetCampaignInSpace = vi.fn();
const mockEndCampaign = vi.fn();
const mockGetCampaignById = vi.fn();
const mockResolveSkillForWorkflow = vi.fn();
const mockGetActiveCampaign = vi.fn();
const mockEnsureActiveCampaign = vi.fn();
const mockUpdateCampaignConfig = vi.fn();

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
    updateCampaignConfig: (...a: unknown[]) => mockUpdateCampaignConfig(...a),
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
      startedBy: 'campaign_start',
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
        startedBy: 'campaign_start',
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
      startedBy: 'campaign_start',
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
      startedBy: 'campaign_start',
    });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_CONFIG_INVALID' });
  });
});

describe('startCampaign — goal admission', () => {
  const OBJECTIVE_GOAL = {
    type: 'objective' as const,
    criteria: [{ id: 'cycle-done', description: 'The trading cycle completes.' }],
  };
  const CONTRACT = {
    fields: {
      accountId: { schema: { type: 'string', minLength: 1 }, identity: true, label: 'Account' },
    },
  };

  it('starts a process campaign for an objective-goal contracted skill', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: { goal: OBJECTIVE_GOAL, campaign: CONTRACT },
    });
    mockGetActiveCampaign.mockResolvedValue(null);
    mockEnsureActiveCampaign.mockImplementation((_db, _t, p) =>
      Promise.resolve(
        campaign({
          workflowSlug: 'daily-trading-cycle',
          goalRef: p.goalRef,
          scoreMetricKey: p.scoreMetricKey,
          direction: p.direction,
          config: p.config,
        }),
      ),
    );

    const r = await startCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'daily-trading-cycle',
      config: { accountId: 'acct-1' },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.created).toBe(true);
    expect(r.campaign).toMatchObject({
      workflowSlug: 'daily-trading-cycle',
      scoreMetricKey: 'completion',
      direction: 'maximize',
      config: { accountId: 'acct-1' },
    });
    const ensureParams = mockEnsureActiveCampaign.mock.calls[0]![2] as Record<string, unknown>;
    expect(ensureParams['goalRef']).toMatch(/^daily-trading-cycle:objective:.+$/);
  });

  it('updates a mutable field on an objective-goal campaign', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: {
        goal: OBJECTIVE_GOAL,
        campaign: {
          fields: {
            ...CONTRACT.fields,
            budget: { schema: { type: 'number' }, mutable: true, label: 'Budget' },
          },
        },
      },
    });
    mockGetCampaignInSpace.mockResolvedValue(
      campaign({
        workflowSlug: 'daily-trading-cycle',
        scoreMetricKey: 'completion',
        direction: 'maximize',
        config: { accountId: 'acct-1', budget: 1 },
      }),
    );
    const updated = campaign({ config: { accountId: 'acct-1', budget: 2 } });
    mockUpdateCampaignConfig.mockResolvedValue(updated);

    const r = await updateCampaign(DB, TENANT, {
      spaceId: SPACE,
      campaignId: 'x',
      config: { budget: 2 },
    });
    expect(r).toEqual({ ok: true, campaign: updated, changedKeys: ['budget'] });
  });

  it('refuses an objective-goal skill without a campaign contract', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({ manifest: { goal: OBJECTIVE_GOAL } });
    const r = await startCampaign(DB, TENANT, { spaceId: SPACE, slug: 'daily-trading-cycle' });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_CONTRACT_MISSING' });
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('refuses a subjective-goal skill as not numeric or objective', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: { goal: { type: 'subjective', rubric: 'Reads well.' }, campaign: CONTRACT },
    });
    const r = await startCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'essay',
      config: { accountId: 'acct-1' },
    });
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_GOAL_NOT_NUMERIC_OR_OBJECTIVE' });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.message).toContain('not numeric or objective');
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });
});

const BOUNDED_RULE = 'test.campaign-floor-under-ceiling';
const RUNTIME_RULE = 'test.campaign-runtime-rule';
registerValidator(
  BOUNDED_RULE,
  z
    .object({ floor: z.number(), ceiling: z.number() })
    .refine((c) => c.floor <= c.ceiling, { path: ['floor'], message: 'floor exceeds ceiling' }),
);
registerRuntimeValidator(RUNTIME_RULE, () => Promise.resolve([]));

const BOUNDED_FIELDS = {
  floor: { schema: { type: 'number' }, label: 'Floor' },
  ceiling: { schema: { type: 'number' }, label: 'Ceiling' },
};

describe('campaign contract rules', () => {
  const NUMERIC_GOAL = {
    type: 'numeric' as const,
    metricKey: 'accuracy',
    direction: 'maximize' as const,
  };
  const withContract = (validatorRefs: string[]) =>
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: { goal: NUMERIC_GOAL, campaign: { fields: BOUNDED_FIELDS, validatorRefs } },
    });

  it('workflow.campaign.update runs the rule over the merged config', async () => {
    withContract([BOUNDED_RULE]);
    mockGetCampaignInSpace.mockResolvedValue(campaign({ config: { floor: 1, ceiling: 5 } }));
    const refused = await updateCampaign(DB, TENANT, {
      spaceId: SPACE,
      campaignId: 'x',
      config: { floor: 9 },
    });
    expect(refused).toMatchObject({ ok: false, code: 'CAMPAIGN_CONFIG_INVALID' });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.details).toEqual({
      issues: [{ field: 'floor', code: 'RULE_VIOLATION', detail: 'floor exceeds ceiling' }],
    });
    expect(mockUpdateCampaignConfig).not.toHaveBeenCalled();

    const updated = campaign({ config: { floor: 4, ceiling: 5 } });
    mockUpdateCampaignConfig.mockResolvedValue(updated);
    const accepted = await updateCampaign(DB, TENANT, {
      spaceId: SPACE,
      campaignId: 'x',
      config: { floor: 4 },
    });
    expect(accepted).toEqual({ ok: true, campaign: updated, changedKeys: ['floor'] });
  });

  it('an unregistered rule refuses campaign start and update', async () => {
    const started = await createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'my-skill',
      goal: NUMERIC_GOAL,
      contract: { fields: BOUNDED_FIELDS, validatorRefs: ['test.not-registered'] },
      config: { floor: 1, ceiling: 5 },
      startedBy: 'campaign_start',
    });
    expect(started).toMatchObject({
      ok: false,
      code: 'CAMPAIGN_CONFIG_INVALID',
      details: { issues: [expect.objectContaining({ code: 'RULE_VIOLATION' })] },
    });
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();

    withContract(['test.not-registered']);
    mockGetCampaignInSpace.mockResolvedValue(campaign({ config: { floor: 1, ceiling: 5 } }));
    const updated = await updateCampaign(DB, TENANT, {
      spaceId: SPACE,
      campaignId: 'x',
      config: { floor: 2 },
    });
    expect(updated).toMatchObject({ ok: false, code: 'CAMPAIGN_CONFIG_INVALID' });
    expect(mockUpdateCampaignConfig).not.toHaveBeenCalled();
  });

  it('skill validation refuses a campaign rule that is unregistered or a runtime validator', () => {
    const parse = (validatorRefs: string[]) =>
      SkillCampaignContractSchema.safeParse({ fields: BOUNDED_FIELDS, validatorRefs });
    expect(parse([BOUNDED_RULE]).success).toBe(true);
    for (const ref of ['test.campaign-floor-under-cieling', RUNTIME_RULE]) {
      const result = parse([BOUNDED_RULE, ref]);
      expect(result.success, ref).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.path)).toEqual([['validatorRefs', 1]]);
      }
    }
  });
});

const MOVING_MIGRATION = 'test.archive-earlier-docs';
const REFUSING_MIGRATION = 'test.refuse-start';
const movingMigration = vi.fn((_ctx: CampaignStartMigrationContext) =>
  Promise.resolve({
    ok: true as const,
    moved: [{ fromPath: '/live/a.json', toPath: '/archive/a.json' }],
  }),
);
registerCampaignStartMigration(MOVING_MIGRATION, (ctx) => movingMigration(ctx));
registerCampaignStartMigration(REFUSING_MIGRATION, () =>
  Promise.resolve({ ok: false, message: 'another campaign still holds the ledger.' }),
);

describe('campaign start migrations', () => {
  const NUMERIC_GOAL = {
    type: 'numeric' as const,
    metricKey: 'accuracy',
    direction: 'maximize' as const,
  };
  const create = (startMigrations: string[], startedBy: 'campaign_start' | 'run_start') =>
    createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'my-skill',
      goal: NUMERIC_GOAL,
      contract: { fields: BOUNDED_FIELDS, startMigrations },
      config: { floor: 1, ceiling: 5 },
      startedBy,
    });

  it('runs before the campaign is created and reports every doc it moved', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    const created = campaign({ config: { floor: 1, ceiling: 5 } });
    mockEnsureActiveCampaign.mockImplementation(() => {
      expect(movingMigration).toHaveBeenCalledTimes(1);
      return Promise.resolve(created);
    });
    const r = await create([MOVING_MIGRATION], 'campaign_start');
    expect(r).toEqual({
      ok: true,
      campaign: created,
      created: true,
      migrations: [
        {
          migrationRef: MOVING_MIGRATION,
          movedCount: 1,
          moved: [{ fromPath: '/live/a.json', toPath: '/archive/a.json' }],
        },
      ],
    });
    expect(movingMigration.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: 'my-skill',
      config: { floor: 1, ceiling: 5 },
    });
  });

  it('runs no migration when the campaign already exists', async () => {
    mockGetActiveCampaign.mockResolvedValue(campaign({ config: { floor: 1, ceiling: 5 } }));
    const r = await create([MOVING_MIGRATION], 'campaign_start');
    expect(r).toMatchObject({ ok: true, created: false, migrations: [] });
    expect(movingMigration).not.toHaveBeenCalled();
  });

  it('a refused or unregistered migration creates no campaign', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    for (const ref of [REFUSING_MIGRATION, 'test.not-registered-migration']) {
      const r = await create([MOVING_MIGRATION, ref], 'campaign_start');
      expect(r, ref).toMatchObject({
        ok: false,
        code: 'CAMPAIGN_START_MIGRATION_REFUSED',
        details: { migrationRef: ref },
      });
    }
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('workflow.run.start cannot create a campaign whose start migrates the space', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    const r = await create([MOVING_MIGRATION], 'run_start');
    expect(r).toMatchObject({ ok: false, code: 'CAMPAIGN_START_REQUIRED' });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.message).toContain('workflow.campaign.start');
    expect(movingMigration).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(
      buildCampaignRequiredErrorDetails('my-skill', {
        fields: BOUNDED_FIELDS,
        startMigrations: [MOVING_MIGRATION],
      }).suggestedAction,
    ).toMatchObject({ op: 'workflow.campaign.start', args: { slug: 'my-skill' } });
  });

  it('skill validation refuses an unregistered migration', () => {
    const parse = (startMigrations: string[]) =>
      SkillCampaignContractSchema.safeParse({ fields: BOUNDED_FIELDS, startMigrations });
    expect(parse([MOVING_MIGRATION]).success).toBe(true);
    const result = parse([MOVING_MIGRATION, 'test.not-registered-migration']);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toEqual([['startMigrations', 1]]);
    }
  });
});

const PASSING_CHECK = 'test.check-passes';
const REFUSING_CHECK = 'test.check-refuses';
registerCampaignStartCheck(PASSING_CHECK, () => Promise.resolve({ ok: true }));
registerCampaignStartCheck(REFUSING_CHECK, () =>
  Promise.resolve({
    ok: false,
    message: 'the feed gives ZZZZ no bars.',
    details: { universeGaps: [{ symbol: 'ZZZZ', sessions: 0 }] },
  }),
);

describe('campaign start checks', () => {
  const NUMERIC_GOAL = {
    type: 'numeric' as const,
    metricKey: 'accuracy',
    direction: 'maximize' as const,
  };
  const create = (startChecks: string[]) =>
    createContractedCampaign(DB, TENANT, {
      spaceId: SPACE,
      slug: 'my-skill',
      goal: NUMERIC_GOAL,
      contract: { fields: BOUNDED_FIELDS, startChecks, startMigrations: [MOVING_MIGRATION] },
      config: { floor: 1, ceiling: 5 },
      startedBy: 'campaign_start',
    });

  it('a refused or unregistered check creates no campaign and moves no doc', async () => {
    mockGetActiveCampaign.mockResolvedValue(null);
    const r = await create([PASSING_CHECK, REFUSING_CHECK]);
    expect(r).toMatchObject({
      ok: false,
      code: 'CAMPAIGN_START_CHECK_REFUSED',
      details: { checkRef: REFUSING_CHECK, universeGaps: [{ symbol: 'ZZZZ', sessions: 0 }] },
    });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.message).toContain('the feed gives ZZZZ no bars.');
    expect(await create(['test.not-registered-check'])).toMatchObject({
      ok: false,
      code: 'CAMPAIGN_START_CHECK_REFUSED',
    });
    expect(movingMigration).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('skill validation refuses an unregistered check', () => {
    const result = SkillCampaignContractSchema.safeParse({
      fields: BOUNDED_FIELDS,
      startChecks: [PASSING_CHECK, 'test.not-registered-check'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toEqual([['startChecks', 1]]);
    }
  });
});
