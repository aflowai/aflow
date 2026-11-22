/**
 * The Performance Review's pooled sample is the ledger's count: the period
 * read reports it, and this rule refuses any other number.
 */
import { describe, expect, it } from 'vitest';
import { getRuntimeValidator } from '@aflow/schemas';
import {
  pooledSampleIssues,
  pooledSampleOf,
  TRADING_POOLED_SAMPLE_VALIDATOR_REF,
} from '../scheduling/tradingPooledSampleValidator.js';
import type { ThesisLedgerDoc } from '../scheduling/tradingArmTable.js';

const REGIME = 'momentum-breakouts-1';

function resolved(thesisId: string, outcome: string, regimeName = REGIME): ThesisLedgerDoc {
  return {
    path: `/portfolio/theses/resolved/${thesisId}.json`,
    content: JSON.stringify({ thesisId, regimeName, hypothesisId: 'breakout', outcome }),
  };
}

const LEDGER: ThesisLedgerDoc[] = [
  resolved('aapl-1', 'confirmed'),
  resolved('aapl-2', 'falsified'),
  resolved('msft-1', 'expired'),
  resolved('msft-2', 'tactical_exit'),
  // An entry that never filled is no sample point.
  resolved('spy-1', 'entry_failed'),
  // Another campaign's resolution counts for that campaign alone.
  resolved('old-1', 'confirmed', 'momentum-0'),
  {
    path: '/portfolio/theses/open/aapl-3.json',
    content: JSON.stringify({ thesisId: 'aapl-3', regimeName: REGIME, hypothesisId: 'breakout' }),
  },
];

describe('trading.pooled-sample', () => {
  it('is registered', () => {
    expect(getRuntimeValidator(TRADING_POOLED_SAMPLE_VALIDATOR_REF)).not.toBeNull();
  });

  it('counts the filled resolutions of the campaign the read names', () => {
    expect(pooledSampleOf(LEDGER, REGIME)).toBe(4);
    expect(pooledSampleOf(LEDGER, 'momentum-0')).toBe(1);
  });

  it('refuses a count the ledger does not give, and names the count', () => {
    expect(pooledSampleIssues({ regimeName: REGIME, pooledN: 4 }, LEDGER)).toEqual([]);
    const [issue] = pooledSampleIssues({ regimeName: REGIME, pooledN: 31 }, LEDGER);
    expect(issue).toMatchObject({ path: ['pooledN'] });
    expect(issue!.message).toContain('Set pooledN to 4.');
    // A count that includes the unfilled entry is refused too.
    expect(pooledSampleIssues({ regimeName: REGIME, pooledN: 5 }, LEDGER)).toHaveLength(1);
  });
});
