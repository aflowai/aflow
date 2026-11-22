import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupValidator, type Campaign } from '@aflow/schemas';
import { listCampaigns } from '../campaigns.js';
import { loadWorkflowRunSlug } from '../scheduling/tradingCampaignArms.js';
import { TRADING_REGIME_CAPS_VALIDATOR_REF } from '../scheduling/tradingMarketRegime.js';

vi.mock('../campaigns.js', () => ({ listCampaigns: vi.fn() }));
vi.mock('../scheduling/tradingCampaignArms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scheduling/tradingCampaignArms.js')>()),
  loadWorkflowRunSlug: vi.fn(),
}));

const SLUG = 'daily-trading-cycle';
const REGIME_NAME = 'momentum-1';
const ctx = {
  tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
  spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
  workflowRunId: 'run-cycle-0714',
  db: {},
};

const RISK_OFF_CAPS = { risk_off: { maxGrossExposurePct: 20, biases: ['short'] } };

function campaign(workflowSlug: string, regimeCaps: unknown, regimeName = REGIME_NAME) {
  return { workflowSlug, config: { regimeName, regimeCaps } } as unknown as Campaign;
}

function decision(
  theses: Array<{ direction: 'long' | 'short' }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    regimeName: REGIME_NAME,
    marketState: 'risk_off',
    bias: theses.length === 0 ? null : (theses[0]?.direction ?? null),
    theses,
    projectedGrossExposurePct: 15,
    ...overrides,
  };
}

function validator() {
  const v = lookupValidator(TRADING_REGIME_CAPS_VALIDATOR_REF);
  if (v?.kind !== 'runtime') throw new Error('regime-caps validator is not a runtime validator');
  return v.fn;
}

beforeEach(() => {
  vi.mocked(loadWorkflowRunSlug).mockReset().mockResolvedValue(SLUG);
  vi.mocked(listCampaigns)
    .mockReset()
    .mockResolvedValue([campaign(SLUG, RISK_OFF_CAPS)]);
});

describe('trading.regime-caps', () => {
  it('holds a decision to the caps of the matching campaign', async () => {
    expect(await validator()(decision([{ direction: 'short' }]), ctx)).toEqual([]);
    expect(await validator()(decision([{ direction: 'long' }]), ctx)).toEqual([
      expect.objectContaining({ code: 'custom', path: ['theses', 0, 'direction'] }),
    ]);
    expect(
      await validator()(decision([{ direction: 'short' }], { projectedGrossExposurePct: 25 }), ctx),
    ).toEqual([expect.objectContaining({ path: ['projectedGrossExposurePct'] })]);
    expect(loadWorkflowRunSlug).toHaveBeenCalledWith(ctx.db, ctx.tenantId, ctx.workflowRunId);
  });

  it('refuses a thesis when the skill has no active campaign of that regimeName', async () => {
    vi.mocked(listCampaigns).mockResolvedValue([campaign(SLUG, RISK_OFF_CAPS, 'another-regime')]);
    expect(await validator()(decision([{ direction: 'short' }]), ctx)).toEqual([
      expect.objectContaining({
        path: ['regimeName'],
        message: expect.stringContaining(`no active campaign with the regimeName "${REGIME_NAME}"`),
      }),
    ]);
  });

  it('reads caps only from a campaign of the running skill', async () => {
    // Another skill in the space, a forked cycle among them, may run a campaign
    // of the same name. Its caps never hold this skill's decision.
    vi.mocked(listCampaigns).mockResolvedValue([campaign('forked-cycle', {})]);
    expect(await validator()(decision([{ direction: 'long' }]), ctx)).toEqual([
      expect.objectContaining({ path: ['regimeName'] }),
    ]);
    expect(listCampaigns).toHaveBeenCalledWith(ctx.db, ctx.tenantId, {
      spaceId: ctx.spaceId,
      workflowSlug: SLUG,
      status: 'active',
      limit: 100,
    });

    vi.mocked(listCampaigns).mockResolvedValue([
      campaign('forked-cycle', {}),
      campaign(SLUG, RISK_OFF_CAPS),
    ]);
    expect(await validator()(decision([{ direction: 'long' }]), ctx)).toEqual([
      expect.objectContaining({ path: ['theses', 0, 'direction'] }),
    ]);
  });

  it('refuses a thesis when the output comes from no readable workflow run', async () => {
    vi.mocked(loadWorkflowRunSlug).mockResolvedValue(null);
    expect(await validator()(decision([{ direction: 'short' }]), ctx)).toEqual([
      expect.objectContaining({ path: ['regimeName'] }),
    ]);
    const { workflowRunId: _none, ...withoutRun } = ctx;
    expect(await validator()(decision([{ direction: 'short' }]), withoutRun)).toEqual([
      expect.objectContaining({ path: ['regimeName'] }),
    ]);
    expect(listCampaigns).not.toHaveBeenCalled();
  });

  it('passes without reading a campaign when the decision opens no thesis', async () => {
    expect(await validator()(decision([]), ctx)).toEqual([]);
    expect(await validator()(decision([], { marketState: 'unavailable' }), ctx)).toEqual([]);
    expect(loadWorkflowRunSlug).not.toHaveBeenCalled();
    expect(listCampaigns).not.toHaveBeenCalled();
  });
});
