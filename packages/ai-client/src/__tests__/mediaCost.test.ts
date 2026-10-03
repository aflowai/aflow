/**
 * A media cost of zero is a claim about money. These pin the difference
 * between "this cost nothing" and "nobody knows what this cost".
 */
import { describe, expect, it } from 'vitest';
import { createDefaultModelCatalog } from '../catalog.js';
import { resolveMediaSpend } from '../mediaCost.js';

const catalog = createDefaultModelCatalog();

const VEO = 'veo-3.1-generate-preview';
const IMAGE = 'grok-imagine-image-2.0';

describe('resolveMediaSpend', () => {
  it('prices video against the catalog per-second rate', () => {
    const spend = resolveMediaSpend({
      catalog,
      modelId: VEO,
      reportedModel: VEO,
      provider: 'google',
      quantity: { videoDurationSeconds: 8 },
    });
    expect(spend.usageBreakdown.costBasis).toBe('priced');
    expect(spend.usageBreakdown.totalCostUsd).toBeCloseTo(3.2, 6);
    expect(spend.usageBreakdown.mediaCostUsd).toBeCloseTo(3.2, 6);
    expect(spend.actualCost).toEqual({ currency: 'USD', micros: 3_200_000 });
  });

  it('prices images against the catalog per-image rate', () => {
    const spend = resolveMediaSpend({
      catalog,
      modelId: IMAGE,
      reportedModel: IMAGE,
      provider: 'openai',
      quantity: { imageCount: 3 },
    });
    expect(spend.usageBreakdown.costBasis).toBe('priced');
    expect(spend.usageBreakdown.totalCostUsd).toBeGreaterThan(0);
    expect(spend.actualCost?.micros).toBeGreaterThan(0);
  });

  it('marks an unknown quantity unpriced and carries no cost at all', () => {
    const spend = resolveMediaSpend({
      catalog,
      modelId: VEO,
      reportedModel: VEO,
      provider: 'google',
      quantity: {},
    });
    expect(spend.usageBreakdown.costBasis).toBe('unpriced');
    expect(spend.usageBreakdown.totalCostUsd).toBe(0);
    // A zero-valued cost would reconcile as "free"; absence is the honest record.
    expect(spend.actualCost).toBeUndefined();
  });

  it('marks a model the catalog cannot price unpriced, not free', () => {
    const spend = resolveMediaSpend({
      catalog,
      modelId: 'some-model-nobody-registered',
      reportedModel: 'some-model-nobody-registered',
      provider: 'openrouter',
      quantity: { videoDurationSeconds: 12 },
    });
    expect(spend.usageBreakdown.costBasis).toBe('unpriced');
    expect(spend.actualCost).toBeUndefined();
  });

  it('never reports a zero cost without saying so', () => {
    const spend = resolveMediaSpend({
      catalog,
      modelId: VEO,
      reportedModel: VEO,
      provider: 'google',
      quantity: { videoDurationSeconds: 0 },
    });
    expect(spend.usageBreakdown.totalCostUsd).toBe(0);
    expect(spend.usageBreakdown.costBasis).toBe('unpriced');
  });
});
