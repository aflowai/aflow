/**
 * ai.media.edit_image - Image editing (multi-provider via AIClient).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError } from '@aflow/executor-runtime';
import { validationError } from '@aflow/executor-runtime';
import type { TenantId, StepExecutionId, AiImageEditInput, MediaBoundEntity } from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { DEFAULT_AI_MODELS } from '@aflow/ai-client';
import type { HandlerDeps } from './types.js';
import { imageSpend, mediaQuote } from './mediaSpend.js';
import { resolveMediaPersistence } from './mediaPersist.js';
import { MediaSourceResolver } from './mediaSourceRef.js';
import { deliverImages } from './imageDeliver.js';

export async function handleImageEdit(
  ctx: ExecutorContext,
  params: AiImageEditInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    // Resolved before the provider is called: a render whose bytes have nowhere
    // to land is refused rather than paid for and dropped.
    const persistence = resolveMediaPersistence(ctx, deps);
    if (!persistence.ok) return await failureWithError(ctx, persistence.error);

    const modelKey = params.model ?? DEFAULT_AI_MODELS.image;
    const client = await getAIClientForContext(ctx, modelKey);

    const model = client.resolveModelId(modelKey);
    const adapter = await client.getAdapter(modelKey);

    if (!adapter.editImage) {
      return await failureWithError(
        ctx,
        validationError(`Provider for model "${model}" does not support image editing`),
      );
    }

    const sources = new MediaSourceResolver(ctx, persistence.target);
    const boundEntityVersions: MediaBoundEntity[] = [];

    const image = await sources.resolve({
      ref: params.imageRef,
      role: 'source',
      field: 'imageRef',
    });
    if (!image.ok) return await failureWithError(ctx, image.error);
    if (image.source.bound) boundEntityVersions.push(image.source.bound);

    let maskData: string | undefined;
    let maskMimeType: string | undefined;
    if (params.maskRef !== undefined) {
      const mask = await sources.resolve({
        ref: params.maskRef,
        role: 'mask',
        field: 'maskRef',
      });
      if (!mask.ok) return await failureWithError(ctx, mask.error);
      maskData = mask.source.data;
      maskMimeType = mask.source.mimeType;
      if (mask.source.bound) boundEntityVersions.push(mask.source.bound);
    }

    const renderFields = {
      prompt: params.prompt,
      imageData: image.source.data,
      imageMimeType: image.source.mimeType,
      maskData,
      maskMimeType,
      size: params.size,
      n: params.n,
      aspectRatio: params.aspectRatio,
    };

    const quoted = mediaQuote({
      client,
      modelKey,
      provider: adapter.provider,
      model,
      // An omitted `n` renders one image. Passing it through undefined makes the
      // quantity unknown, and an unknown quantity is unpriced — the ordinary
      // single-image call would report that nothing priced it.
      quantity: { imageCount: params.n ?? 1 },
    });

    const response = await adapter.editImage({
      ...renderFields,
      model,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    return await deliverImages({
      ctx,
      target: persistence.target,
      model,
      requestedModel: params.model,
      requestFields: renderFields,
      prompt: params.prompt,
      boundEntityVersions,
      quoted,
      response,
      spend: imageSpend(client, modelKey, response),
    });
  } catch (error) {
    return await deps.handleError(ctx, 'Image editing failed', error);
  }
}
