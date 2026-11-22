import { describe, expect, it } from 'vitest';
import { DAILY_TRADING_CYCLE_CAMPAIGN } from '../skillCatalog/dailyTradingCycleCampaign.js';
import { READ_UNIVERSE_BARS_TASK } from '../skillCatalog/dailyTradingCycleGather.js';
import { MEMBER_LOOKBACK_SESSIONS } from '../skillCatalog/dailyTradingCycleRegime.js';
import {
  REGIME_BARS_FEED,
  REGIME_BARS_LOOKBACK_MS,
  UNIVERSE_COVERAGE_CHECK_REF,
  universeCoverageGaps,
  universeCoverageRefusal,
} from '../skillCatalog/dailyTradingCycleUniverse.js';

const sessions = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => ({
    t: `2026-06-${String(from + i).padStart(2, '0')}T04:00:00Z`,
  }));

describe('daily-trading-cycle universe check at campaign start', () => {
  it('the campaign starts behind the check', () => {
    expect(DAILY_TRADING_CYCLE_CAMPAIGN.startChecks).toEqual([UNIVERSE_COVERAGE_CHECK_REF]);
  });

  it('reads the window and feed the cycle’s universe read reads', () => {
    expect(READ_UNIVERSE_BARS_TASK.inputBindings.start.offsetMs).toBe(-REGIME_BARS_LOOKBACK_MS);
    expect(READ_UNIVERSE_BARS_TASK.inputTemplate.params.feed).toBe(REGIME_BARS_FEED);
  });

  it('names each member with fewer sessions than the breadth needs, in universe order', () => {
    const gaps = universeCoverageGaps(
      ['ZZZZ', 'AAPL', 'NEWCO'],
      { AAPL: sessions(MEMBER_LOOKBACK_SESSIONS), NEWCO: sessions(MEMBER_LOOKBACK_SESSIONS - 1) },
      '2026-07-14',
    );
    expect(gaps).toEqual([
      { symbol: 'ZZZZ', sessions: 0 },
      { symbol: 'NEWCO', sessions: MEMBER_LOOKBACK_SESSIONS - 1 },
    ]);
    const message = universeCoverageRefusal(gaps);
    expect(message).toContain('ZZZZ has no bars');
    expect(message).toContain(`NEWCO has ${String(MEMBER_LOOKBACK_SESSIONS - 1)} sessions`);
    expect(message).toContain('Drop these members from universe');
  });

  it('counts each session once, and none on or after the start day', () => {
    const bars = [...sessions(19), ...sessions(19), { t: '2026-07-14T04:00:00Z' }];
    expect(universeCoverageGaps(['AAPL'], { AAPL: bars }, '2026-07-14')).toEqual([
      { symbol: 'AAPL', sessions: 19 },
    ]);
  });
});
