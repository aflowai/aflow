/**
 * The alpaca-thesis-trading bundle once held its agents to 640 rules (244
 * the platform enforced, 396 written in prose), and for two days no trade
 * was made. The redesign cut it to the strategy's definition of a trade,
 * the broker's requirements and what the account can express. This guard
 * stops the count growing back: a new rule raises a ceiling here, on
 * purpose, in review.
 */
import { describe, expect, it } from 'vitest';
import { tradingRuleCensus } from './tradingRuleCensus.js';

const CEILINGS = {
  machineRules: 157,
  proseRules: 222,
  'daily-trading-cycle': 75,
  'strategy-desk': 4,
};

describe('the alpaca-thesis-trading rule census', () => {
  const census = tradingRuleCensus();
  const machine = (skill: string) => {
    const s = census.skills.find((c) => c.skill === skill)!;
    return s.derivedFrom + s.conditionals + s.validators + s.decideRules + s.campaignRules;
  };

  it('holds no more rules than the redesign left', () => {
    expect(census.machineRules).toBeLessThanOrEqual(CEILINGS.machineRules);
    expect(census.proseRules).toBeLessThanOrEqual(CEILINGS.proseRules);
  });

  it('keeps the cycle and the desk to the rules a trade needs', () => {
    expect(machine('daily-trading-cycle')).toBeLessThanOrEqual(CEILINGS['daily-trading-cycle']);
    expect(machine('strategy-desk')).toBeLessThanOrEqual(CEILINGS['strategy-desk']);
  });
});
