import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunDeriver } from '@aflow/schemas';
import { gatherMarketRegime } from '@aflow/platform-artifacts';
import { TRADING_MARKET_REGIME_DERIVER } from '../scheduling/tradingMarketRegime.js';

vi.mock('@aflow/platform-artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/platform-artifacts')>()),
  gatherMarketRegime: vi.fn(),
}));

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
