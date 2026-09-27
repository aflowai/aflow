/**
 * What a video render is billed for.
 *
 * A route clamps the ask, so the request is not the quantity: the receipt
 * records what the delivered container states, and pricing anything else would
 * put `cost.actual` and `rendered.durationSeconds` on one receipt describing
 * different clips.
 */
import { describe, it, expect } from 'vitest';
import type { MediaRenderedFormat } from '@aflow/schemas';
import type { AIClient, GenerateVideoResponse } from '@aflow/ai-client';
import { mediaQuote, videoSpend } from './mediaSpend.js';

const PRICE_PER_SECOND_USD = 0.4;
const MICROS_PER_UNIT = 1_000_000;

function client(): AIClient {
  return {
    modelCatalog: {
      getModel: () => ({ pricing: { videoPerSecond: PRICE_PER_SECOND_USD } }),
      calculateCost: (_model: string, usage: { videoDurationSeconds?: number }) => ({
        mediaCost: PRICE_PER_SECOND_USD * (usage.videoDurationSeconds ?? 0),
        currency: 'USD',
      }),
    },
  } as unknown as AIClient;
}

function response(): GenerateVideoResponse {
  return { videos: [], provider: 'google', model: 'veo-3.1-generate-preview' } as never;
}

function micros(seconds: number): number {
  return Math.round(PRICE_PER_SECOND_USD * seconds * MICROS_PER_UNIT);
}

function priceOf(rendered: MediaRenderedFormat[], requestedSeconds: number | undefined) {
  return videoSpend({
    client: client(),
    modelKey: 'veo-3.1',
    response: response(),
    rendered,
    requestedSeconds,
  });
}

describe('videoSpend', () => {
  it('bills the length the delivered clip states, not the one the request asked for', () => {
    const spend = priceOf([{ durationSeconds: 8 }], 12);
    expect(spend.actualCost?.micros).toBe(micros(8));
    expect(spend.actualCost?.micros).not.toBe(micros(12));
  });

  it('sums the candidates a request delivered', () => {
    const spend = priceOf([{ durationSeconds: 8 }, { durationSeconds: 8.04 }], 12);
    expect(spend.actualCost?.micros).toBe(micros(16.04));
  });

  it('falls back to the requested length only for a container that states none', () => {
    const spend = priceOf([{ durationSeconds: 8 }, {}], 12);
    expect(spend.actualCost?.micros).toBe(micros(20));
  });

  it('reports unknown spend rather than a free render when nothing states a length', () => {
    const spend = priceOf([{}], undefined);
    expect(spend.actualCost).toBeUndefined();
    expect(spend.usageBreakdown.costBasis).toBe('unpriced');
  });
});

describe('videoSpend on a route that reports what it billed', () => {
  function reportedSpend(micros: number, rendered: MediaRenderedFormat[]) {
    return videoSpend({
      client: client(),
      modelKey: 'veo-3.1',
      response: { ...response(), reportedCost: { currency: 'USD', micros } },
      rendered,
      requestedSeconds: undefined,
    });
  }

  it('bills the figure the provider reported, not the one the catalog derives', () => {
    // The catalog would price this clip at 8 × $0.40; the provider says $0.42.
    const spend = reportedSpend(420_000, [{ durationSeconds: 8 }]);
    expect(spend.actualCost).toEqual({ currency: 'USD', micros: 420_000 });
    expect(spend.usageBreakdown.totalCostUsd).toBeCloseTo(0.42);
    expect(spend.usageBreakdown.costBasis).toBe('priced');
  });

  it('prices a render whose container states no length, which the catalog could not', () => {
    const spend = reportedSpend(420_000, [{}]);
    expect(spend.actualCost?.micros).toBe(420_000);
    expect(spend.usageBreakdown.costBasis).toBe('priced');
  });
});

describe('mediaQuote', () => {
  it('prices the ask before dispatch, which a clamped delivery is then billed under', () => {
    const quoted = mediaQuote({
      client: client(),
      modelKey: 'veo-3.1',
      provider: 'google',
      model: 'veo-3.1-generate-preview',
      quantity: { videoDurationSeconds: 12 },
    });
    expect(quoted?.micros).toBe(micros(12));
    expect(priceOf([{ durationSeconds: 8 }], 12).actualCost?.micros).toBe(micros(8));
  });

  it('leaves the quote off when the request named no quantity to price', () => {
    expect(
      mediaQuote({
        client: client(),
        modelKey: 'veo-3.1',
        provider: 'google',
        model: 'veo-3.1-generate-preview',
        quantity: {},
      }),
    ).toBeUndefined();
  });
});
