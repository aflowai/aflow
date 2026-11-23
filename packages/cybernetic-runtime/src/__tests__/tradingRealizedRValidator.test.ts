/**
 * A resolved thesis's realized R is recomputed from the doc's own prices, and
 * any other value is refused, so each arm's expectancy is measured.
 */
import { describe, expect, it } from 'vitest';
import { getRuntimeValidator } from '@aflow/schemas';
import {
  expectedRealizedR,
  realizedRIssues,
  TRADING_REALIZED_R_VALIDATOR_REF,
} from '../scheduling/tradingRealizedRValidator.js';
import type { ThesisLedgerDoc } from '../scheduling/tradingArmTable.js';

const PATH = '/portfolio/theses/resolved/aapl-1.json';

function resolvedDoc(fields: Record<string, unknown>): ThesisLedgerDoc {
  return {
    path: PATH,
    content: JSON.stringify({
      thesisId: 'aapl-1',
      regimeName: 'momentum-breakouts-1',
      hypothesisId: 'breakout',
      direction: 'long',
      outcome: 'confirmed',
      entryFillPrice: 100,
      invalidationLevel: 95,
      closeOrder: { fillState: 'filled', filledAvgPrice: 110 },
      ...fields,
    }),
  };
}

const record = (realizedR: unknown) => ({
  resolvedDocPaths: [PATH],
  cycleDoc: { thesesResolved: [{ thesisId: 'aapl-1', realizedR }] },
});

describe('trading.realized-r', () => {
  it('is registered', () => {
    expect(getRuntimeValidator(TRADING_REALIZED_R_VALIDATOR_REF)).not.toBeNull();
  });

  it('recomputes R from the entry fill, the invalidation level and the close fill', () => {
    expect(expectedRealizedR(JSON.parse(resolvedDoc({}).content!)).value).toBeCloseTo(2);
    const short = {
      direction: 'short',
      invalidationLevel: 105,
      closeOrder: { filledAvgPrice: 95 },
    };
    expect(expectedRealizedR(JSON.parse(resolvedDoc(short).content!)).value).toBeCloseTo(1);
    expect(expectedRealizedR({ outcome: 'entry_failed' }).value).toBeNull();
  });

  it('accepts the recomputed value, and refuses another one on the doc or the cycle doc', () => {
    expect(realizedRIssues(record(2), [resolvedDoc({ realizedR: 2 })])).toEqual([]);
    const [onDoc] = realizedRIssues(record(2.5), [resolvedDoc({ realizedR: 2.5 })]);
    expect(onDoc!.message).toContain('give 2.0000. Rewrite it with realizedR 2.0000.');
    const [onCycle] = realizedRIssues(record(1.5), [resolvedDoc({ realizedR: 2 })]);
    expect(onCycle).toMatchObject({ path: ['cycleDoc', 'thesesResolved', 0, 'realizedR'] });
  });

  it('refuses a value where a price is unknown, and a null where every price is known', () => {
    const pending = resolvedDoc({
      closeOrder: { fillState: 'pending', filledAvgPrice: null },
      realizedR: 2,
    });
    const [estimated] = realizedRIssues(record(2), [pending]);
    expect(estimated!.message).toContain(
      'must carry realizedR null: its close has no filledAvgPrice yet',
    );
    expect(
      realizedRIssues(record(null), [
        resolvedDoc({ closeOrder: { filledAvgPrice: null }, realizedR: null }),
      ]),
    ).toEqual([]);
    expect(realizedRIssues(record(null), [resolvedDoc({ realizedR: null })])).toHaveLength(1);
  });
});
