import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunDeriver, lookupValidator, WorkflowTaskSchema } from '@aflow/schemas';
import { gatherMarketRegime } from '@aflow/platform-artifacts';
import { configureLogging } from '@aflow/observability';
import {
  runRegisteredOutputValidators,
  unregisteredValidatorIssue,
} from '../scheduling/runOutputValidators.js';
import { TRADING_MARKET_REGIME_DERIVER } from '../scheduling/tradingMarketRegime.js';

vi.mock('@aflow/platform-artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/platform-artifacts')>()),
  gatherMarketRegime: vi.fn(),
}));

configureLogging({ service: 'test', level: 'silent' });

const ARGS = { tradingDay: '2026-07-14', slot: 'open' };
const GATHERED = {
  tradingDay: '2026-07-14',
  slot: 'open',
  clock: {
    timestamp: '2026-07-14T09:37:00-04:00',
    isOpen: true,
    nextOpen: '2026-07-15T09:30:00-04:00',
    nextClose: '2026-07-14T16:00:00-04:00',
  },
  marketRegime: {
    asOf: '2026-07-13',
    state: 'mixed' as const,
    indexes: {
      SPY: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
      QQQ: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
      IWM: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
    },
    realizedVolPct: 0,
    breadth: { above: 0, total: 1, share: 0 },
  },
  read: { bindingId: 'alpaca-market-data-default' as const, asOf: '2026-07-13', count: 51 },
};

function deriver() {
  const fn = getRunDeriver(TRADING_MARKET_REGIME_DERIVER);
  if (!fn) throw new Error('trading.market-regime is not a registered run deriver');
  return fn;
}

beforeEach(() => {
  vi.mocked(gatherMarketRegime).mockReset();
});

describe('trading.market-regime', () => {
  it('is registered as a run deriver that computes the regime from its arguments', () => {
    vi.mocked(gatherMarketRegime).mockReturnValue({ ok: true, value: GATHERED });
    expect(deriver()(ARGS)).toEqual({ ok: true, value: GATHERED });
    expect(gatherMarketRegime).toHaveBeenCalledWith(ARGS);
  });

  it('passes the refusal through, so gather-regime fails and the cycle decides unavailable', () => {
    const refusal = { ok: false as const, message: 'read-index-bars produced no bars.' };
    vi.mocked(gatherMarketRegime).mockReturnValue(refusal);
    expect(deriver()({})).toEqual(refusal);
  });
});

describe('the trading.market-regime validatorRef a cycle before version 12 names', () => {
  const ctx = {
    tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
    spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
    workflowRunId: 'run-cycle-0714',
    db: {},
  };
  const V11_VALIDATOR_REF = 'trading.market-regime';
  const v11GatherRegime = {
    taskId: 'gather-regime',
    name: 'Gather market regime',
    type: 'agent',
    optional: true,
    goal: 'Gather the market regime from the index and universe reads.',
    outputContract: {
      schema: { type: 'object' },
      validatorRefs: [V11_VALIDATOR_REF],
    },
  };

  it('is no registered validator, so the skill check names it', () => {
    expect(lookupValidator(V11_VALIDATOR_REF)).toBeNull();
    const parsed = WorkflowTaskSchema.safeParse(v11GatherRegime);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join('\n')).toContain(
      '"trading.market-regime" is not a registered validator',
    );
  });

  it('refuses every gathered regime on submit, so the cycle decides unavailable', async () => {
    const issues = await runRegisteredOutputValidators(
      v11GatherRegime.outputContract.validatorRefs,
      { tradingDay: '2026-07-14', slot: 'open', marketRegime: GATHERED.marketRegime },
      ctx,
    );
    expect(issues).toEqual([unregisteredValidatorIssue(V11_VALIDATOR_REF)]);
    expect(gatherMarketRegime).not.toHaveBeenCalled();
  });
});
