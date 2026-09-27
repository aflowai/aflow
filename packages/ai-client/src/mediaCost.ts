/**
 * The one cost path for generated media.
 *
 * Media bills on quantities the provider does not report back — seconds of
 * video, images produced — so the figure is only as good as the quantity the
 * caller can name. Every consumer of that figure (the step's usage breakdown
 * and the async job's durable cost) derives from this one call, because two
 * places computing money is two places to disagree about it.
 */
import type { StepUsageBreakdown, AsyncJobCost } from '@aflow/schemas';
import type { ModelCatalog } from './catalog.js';

const MICROS_PER_UNIT = 1_000_000;

export interface MediaQuantity {
  /** Images produced by this call. */
  imageCount?: number | undefined;
  /** Seconds of video produced. Absent when nobody knows the rendered length. */
  videoDurationSeconds?: number | undefined;
}

export interface MediaSpendInput {
  catalog: ModelCatalog;
  /** Catalog key or alias — the same string `calculateCost` is keyed on. */
  modelId: string;
  /** Model id as reported by the route, for the breakdown's own record. */
  reportedModel: string;
  provider: string;
  quantity: MediaQuantity;
}

export interface MediaSpend {
  /** The step result's `costJson`. Conforms to `StepUsageBreakdownSchema`. */
  usageBreakdown: StepUsageBreakdown;
  /**
   * The async job row's `actualCost`. Absent — never zero — when the spend is
   * unpriced, so the row keeps NULL money rather than a figure meaning "free".
   */
  actualCost?: AsyncJobCost;
}

function mediaUsageBreakdown(
  provider: string,
  model: string,
  mediaCostUsd: number,
  priced: boolean,
): StepUsageBreakdown {
  return {
    provider,
    model,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCostUsd: 0,
    completionCostUsd: 0,
    totalCostUsd: mediaCostUsd,
    mediaCostUsd,
    costBasis: priced ? 'priced' : 'unpriced',
  };
}

export interface SettledMediaSpendInput {
  /** Model id as reported by the route, for the breakdown's own record. */
  reportedModel: string;
  provider: string;
  /** What the durable row recorded when the work settled. */
  actualCost?: AsyncJobCost | undefined;
}

/**
 * The spend of work that already settled, read from what was recorded rather
 * than priced again. A catalog rate can change between the render and the
 * delivery of its result, and the money the step reports must be the money the
 * durable row holds.
 */
export function settledMediaSpend(input: SettledMediaSpendInput): MediaSpend {
  const { actualCost } = input;
  if (actualCost === undefined) {
    return { usageBreakdown: mediaUsageBreakdown(input.provider, input.reportedModel, 0, false) };
  }
  const mediaCostUsd = actualCost.micros / MICROS_PER_UNIT;
  return {
    usageBreakdown: mediaUsageBreakdown(input.provider, input.reportedModel, mediaCostUsd, true),
    actualCost,
  };
}

/**
 * A quantity is billable only when the catalog carries a rate for it AND the
 * caller knows the quantity. Either half missing makes the total a guess, and
 * the result says so rather than reporting a confident zero.
 */
export function resolveMediaSpend(input: MediaSpendInput): MediaSpend {
  const { catalog, modelId, reportedModel, provider, quantity } = input;
  const pricing = catalog.getModel(modelId)?.pricing;

  const imageCount =
    pricing?.imagePerImage !== undefined &&
    quantity.imageCount !== undefined &&
    quantity.imageCount > 0
      ? quantity.imageCount
      : undefined;
  const videoDurationSeconds =
    pricing?.videoPerSecond !== undefined &&
    quantity.videoDurationSeconds !== undefined &&
    quantity.videoDurationSeconds > 0
      ? quantity.videoDurationSeconds
      : undefined;

  const billable = imageCount !== undefined || videoDurationSeconds !== undefined;
  const breakdown = billable
    ? catalog.calculateCost(modelId, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        ...(imageCount !== undefined ? { imageCount } : {}),
        ...(videoDurationSeconds !== undefined ? { videoDurationSeconds } : {}),
      })
    : undefined;

  const mediaCostUsd = breakdown?.mediaCost ?? 0;
  const priced = breakdown !== undefined;

  const usageBreakdown = mediaUsageBreakdown(provider, reportedModel, mediaCostUsd, priced);

  if (breakdown === undefined) {
    return { usageBreakdown };
  }
  return {
    usageBreakdown,
    actualCost: {
      currency: breakdown.currency,
      micros: Math.round(mediaCostUsd * MICROS_PER_UNIT),
    },
  };
}
