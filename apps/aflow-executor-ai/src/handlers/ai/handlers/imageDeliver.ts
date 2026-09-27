/**
 * What the two image operations do with a finished render: file it, record how
 * it was made, and return references. Both go through here so a generation and
 * an edit are stored, addressed and receipted identically.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  deriveAsyncJobKey,
  mediaRenderParameters,
  type AsyncJobCost,
  type MediaBoundEntity,
} from '@aflow/schemas';
import type { GenerateImageResponse, MediaSpend } from '@aflow/ai-client';
import {
  deliverMediaProduction,
  type MediaCandidateBytes,
  type MediaPersistenceTarget,
} from './mediaPersist.js';
import { probeRenderedFormat } from './mediaProbe.js';
import { mediaCapabilityRoute, mediaRequestIdentity } from './mediaRequestIdentity.js';

export interface DeliverImagesParams {
  ctx: ExecutorContext;
  target: MediaPersistenceTarget;
  /** The model id the route resolved and ran. */
  model: string;
  /** The model key the caller named, absent when the route default applied. */
  requestedModel: string | undefined;
  /** Every field the provider acted on — the request identity is hashed from it. */
  requestFields: Record<string, unknown>;
  prompt: string;
  boundEntityVersions: MediaBoundEntity[];
  /** What the catalog priced this request at before it was dispatched. */
  quoted: AsyncJobCost | undefined;
  response: GenerateImageResponse;
  spend: MediaSpend;
}

export async function deliverImages(params: DeliverImagesParams): Promise<StepResult> {
  const { ctx, response, spend } = params;
  const requestKey = deriveAsyncJobKey(
    mediaRequestIdentity(ctx, {
      provider: response.provider,
      model: params.model,
      request: params.requestFields,
    }),
  );

  const candidates: MediaCandidateBytes[] = response.images.map((image) => ({
    bytes: Buffer.from(image.data, 'base64'),
    mimeType: image.mimeType,
    ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
    // An image route regenerates from a prompt and a source image; it holds no
    // asset of ours to continue from, so there is no handle to expire.
    providerNative: { status: 'none', reason: 'route_issues_none' },
  }));

  return await deliverMediaProduction({
    ctx,
    target: params.target,
    kind: 'image',
    candidates,
    spend,
    failureDetails: { requestKey },
    receipt: {
      execution: {
        runId: ctx.runId,
        logicalExecutionId: ctx.logicalExecutionId,
        attempt: ctx.job.attempt,
        requestKey,
      },
      request: {
        prompt: params.prompt,
        parameters: mediaRenderParameters(params.requestFields),
        boundEntityVersions: params.boundEntityVersions,
      },
      provider: response.provider,
      model: response.model,
      capabilityRoute: mediaCapabilityRoute(ctx, {
        provider: response.provider,
        model: params.model,
        requestedModel: params.requestedModel,
      }),
      cost: {
        ...(params.quoted !== undefined ? { quoted: params.quoted } : {}),
        ...(spend.actualCost !== undefined ? { actual: spend.actualCost } : {}),
      },
      // Candidates of one request share the receipt, and a route renders them
      // to one size — the first one is what the whole set was delivered at.
      rendered:
        candidates[0] === undefined ? {} : probeRenderedFormat('image', candidates[0].bytes),
      createdAt: new Date().toISOString(),
    },
  });
}
