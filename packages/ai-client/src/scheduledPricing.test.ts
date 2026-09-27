import { describe, it, expect } from 'vitest';
import { effectiveModelPricing, createDefaultModelCatalog } from './catalog.js';
import type { ModelPricing } from './types.js';

const PROMO: ModelPricing = {
  promptPer1M: 0.75,
  cachedPromptPer1M: 0.075,
  completionPer1M: 3.75,
  currency: 'USD',
  scheduled: {
    effectiveFrom: '2027-01-01T00:00:00Z',
    promptPer1M: 1.5,
    cachedPromptPer1M: 0.15,
    completionPer1M: 7.5,
  },
};

describe('effectiveModelPricing', () => {
  it('bills the introductory rate before the cutover', () => {
    const rates = effectiveModelPricing(PROMO, new Date('2026-12-31T23:59:59Z'));
    expect(rates.promptPer1M).toBe(0.75);
    expect(rates.completionPer1M).toBe(3.75);
    expect(rates.cachedPromptPer1M).toBe(0.075);
  });

  it('bills the successor rate from the cutover instant onward', () => {
    const rates = effectiveModelPricing(PROMO, new Date('2027-01-01T00:00:00Z'));
    expect(rates.promptPer1M).toBe(1.5);
    expect(rates.completionPer1M).toBe(7.5);
    expect(rates.cachedPromptPer1M).toBe(0.15);
  });

  it('leaves pricing without a scheduled change untouched', () => {
    const flat: ModelPricing = { promptPer1M: 5, completionPer1M: 30, currency: 'USD' };
    expect(effectiveModelPricing(flat, new Date('2030-01-01T00:00:00Z'))).toEqual(flat);
  });

  it('keeps the currency across the change', () => {
    expect(effectiveModelPricing(PROMO, new Date('2027-06-01T00:00:00Z')).currency).toBe('USD');
  });
});

describe('catalog cost uses the rate in force', () => {
  const catalog = createDefaultModelCatalog();

  // Pinned instants, not the wall clock: a test that reads "today" would start
  // failing on its own the morning the scheduled rate takes over, which is the
  // exact class of surprise this feature exists to remove.
  const DURING_PROMO = new Date('2026-08-21T00:00:00Z');
  const AFTER_PROMO = new Date('2027-02-01T00:00:00Z');

  it('prices a Flash call at the introductory rate during the promo', () => {
    const cost = catalog.calculateCost(
      'gemini-3.8-flash',
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      DURING_PROMO,
    );
    expect(cost?.promptCost).toBeCloseTo(0.75, 6);
  });

  it('prices the same call at the standard rate once the promo lapses', () => {
    const cost = catalog.calculateCost(
      'gemini-3.8-flash',
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      AFTER_PROMO,
    );
    expect(cost?.promptCost).toBeCloseTo(1.5, 6);
  });

  it('reaches the same schedule through the generic alias', () => {
    const usage = { promptTokens: 500_000, completionTokens: 100_000, totalTokens: 600_000 };
    for (const at of [DURING_PROMO, AFTER_PROMO]) {
      expect(catalog.calculateCost('flash', usage, at)?.totalCost).toBeCloseTo(
        catalog.calculateCost('gemini-3.8-flash', usage, at)?.totalCost ?? -1,
        6,
      );
    }
  });
});
