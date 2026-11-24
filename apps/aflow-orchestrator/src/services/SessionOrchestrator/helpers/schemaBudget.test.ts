import { describe, expect, it } from 'vitest';
import { fitPromotionsToSchemaBudget, type SchemaBudgetMeasure } from './schemaBudget.js';

const budget: SchemaBudgetMeasure = {
  maxTokens: 1000,
  pinnedTokens: 700,
  pinnedToolIds: ['memory.store.get'],
  committedTokens: 700,
};

const candidate = (toolId: string, tokens: number) => ({ toolId, surfaceToolId: toolId, tokens });

describe('fitPromotionsToSchemaBudget', () => {
  it('admits promotions in order while they fit and refuses the rest with the numbers', () => {
    const fit = fitPromotionsToSchemaBudget(budget, [
      candidate('a', 200),
      candidate('b', 150),
      candidate('c', 100),
    ]);
    expect(fit.admitted).toEqual(['a', 'c']);
    expect(fit.budget.committedTokens).toBe(1000);
    expect(fit.refused).toEqual([{ toolId: 'b', reason: expect.any(String) }]);
    const reason = fit.refused[0]!.reason;
    expect(reason).toMatch(/^schema_budget: this tool needs about 150 schema tokens\./);
    expect(reason).toContain('900 of the 1000-token budget: 700 pinned and 200 promoted this turn');
    expect(reason).toContain('It lands once 50 more tokens are free.');
    expect(reason).toContain('Promote it again on the next turn');
  });

  it('counts promotions admitted earlier in the turn', () => {
    const fit = fitPromotionsToSchemaBudget({ ...budget, committedTokens: 950 }, [
      candidate('a', 100),
    ]);
    expect(fit.admitted).toEqual([]);
    expect(fit.refused[0]!.reason).toContain('700 pinned and 250 promoted this turn');
  });

  it('names the operator as the only remedy when the tool cannot fit beside the pinned tier', () => {
    const fit = fitPromotionsToSchemaBudget(budget, [candidate('huge', 400)]);
    const reason = fit.refused[0]!.reason;
    expect(reason).toContain('Only the operator can free that room');
    expect(reason).not.toContain('Promote it again');
  });

  it('admits a tool the pinned tier already carries at no cost', () => {
    const fit = fitPromotionsToSchemaBudget({ ...budget, committedTokens: 1000 }, [
      candidate('memory.store.get', 300),
    ]);
    expect(fit.admitted).toEqual(['memory.store.get']);
    expect(fit.budget.committedTokens).toBe(1000);
  });
});
