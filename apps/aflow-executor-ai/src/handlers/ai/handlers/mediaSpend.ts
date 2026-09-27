/**
 * The media handlers' only route to a cost figure.
 *
 * `resolveMediaSpend` prices against the client's own catalog; these two
 * wrappers name the billable quantity each media kind actually delivered, so a
 * handler never has to decide what "the quantity" is.
 */
import type { AsyncJobCost, MediaRenderedFormat } from '@aflow/schemas';
import {
  resolveMediaSpend,
  settledMediaSpend,
  type AIClient,
  type GenerateImageResponse,
  type GenerateVideoResponse,
  type MediaQuantity,
  type MediaSpend,
} from '@aflow/ai-client';

export interface MediaQuoteParams {
  client: AIClient;
  modelKey: string;
  provider: string;
  /** The model id the route resolved, for the breakdown this quote discards. */
  model: string;
  quantity: MediaQuantity;
}

/**
 * What a render is priced at BEFORE it is dispatched, against the catalog in
 * effect at that moment. Absent when the catalog carries no rate for the
 * quantity, or when the request never named the quantity — a quote nobody can
 * compute is left off rather than reported as zero.
 */
export function mediaQuote(params: MediaQuoteParams): AsyncJobCost | undefined {
  return resolveMediaSpend({
    catalog: params.client.modelCatalog,
    modelId: params.modelKey,
    reportedModel: params.model,
    provider: params.provider,
    quantity: params.quantity,
  }).actualCost;
}

export function imageSpend(
  client: AIClient,
  modelKey: string,
  response: GenerateImageResponse,
): MediaSpend {
  return resolveMediaSpend({
    catalog: client.modelCatalog,
    modelId: modelKey,
    reportedModel: response.model,
    provider: response.provider,
    quantity: { imageCount: response.images.length },
  });
}

export interface VideoSpendParams {
  client: AIClient;
  modelKey: string;
  response: GenerateVideoResponse;
  /**
   * What each delivered clip's own container states, in candidate order. A route
   * that clamps a 12s request to 8s bills and delivers 8, so the length the file
   * holds is the billable one — not the length the request asked for.
   */
  rendered: MediaRenderedFormat[];
  /**
   * The length the render was asked for. Priced only for a clip whose container
   * states none: an unreadable container leaves this as the sole figure there
   * is, and pricing nothing would report a paid render as free.
   */
  requestedSeconds: number | undefined;
}

export function videoSpend(params: VideoSpendParams): MediaSpend {
  // A figure the provider reports is what it actually billed. Pricing it again
  // from the catalog would replace a fact with a transcription of a rate card,
  // and the two disagree the moment the vendor moves a price.
  const reported = params.response.reportedCost;
  if (reported !== undefined) {
    return settledMediaSpend({
      provider: params.response.provider,
      reportedModel: params.response.model,
      actualCost: reported,
    });
  }

  const seconds = params.rendered.reduce(
    (total, format) => total + (format.durationSeconds ?? params.requestedSeconds ?? 0),
    0,
  );
  return resolveMediaSpend({
    catalog: params.client.modelCatalog,
    modelId: params.modelKey,
    reportedModel: params.response.model,
    provider: params.response.provider,
    quantity: { videoDurationSeconds: seconds },
  });
}
