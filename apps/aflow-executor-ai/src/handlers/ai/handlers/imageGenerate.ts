/**
 * ai.media.image - Image generation (multi-provider via AIClient).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError } from '@aflow/executor-runtime';
import { validationError } from '@aflow/executor-runtime';
import type {
  TenantId,
  StepExecutionId,
  AiImageGenerateInput,
  MediaBoundEntity,
} from '@aflow/schemas';
import { IMAGE_MODELS } from '@aflow/schemas';
import { getAIClientForContext } from '../aiClient.js';
import { DEFAULT_AI_MODELS } from '@aflow/ai-client';
import type { AIClient, ImageReferenceInput } from '@aflow/ai-client';
import type { HandlerDeps } from './types.js';
import { imageSpend, mediaQuote } from './mediaSpend.js';
import { resolveMediaPersistence } from './mediaPersist.js';
import { MediaSourceResolver } from './mediaSourceRef.js';
import { deliverImages } from './imageDeliver.js';

/**
 * Model keys the agent can actually name, spelled the way the operation schema
 * spells them — a suggestion carrying a raw provider id would not round-trip
 * back into `model`.
 */
function referenceCapableModelKeys(client: AIClient): string[] {
  const selectable = new Set<string>(IMAGE_MODELS);
  return (
    client
      .listModels()
      // Reference-capable is not enough to be worth naming here: a video route
      // declares its own references too, and suggesting one to an image caller
      // offers a model that cannot answer the request at all.
      .filter(
        (model) =>
          model.capabilities.imageReferences !== undefined && model.capabilities.imageGeneration,
      )
      .map((model) => model.aliases?.find((alias) => selectable.has(alias)) ?? model.id)
  );
}

export async function handleImageGenerate(
  ctx: ExecutorContext,
  params: AiImageGenerateInput,
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

    if (!adapter.generateImage) {
      return await failureWithError(
        ctx,
        validationError(`Provider for model "${model}" does not support image generation`),
      );
    }

    const requested = params.referenceRefs ?? [];
    const limits = client.getModel(modelKey)?.capabilities.imageReferences;

    if (requested.length > 0 && limits === undefined) {
      const alternatives = referenceCapableModelKeys(client);
      return await failureWithError(
        ctx,
        validationError(
          `Model "${model}" generates from the prompt alone and would ignore the ${String(requested.length)} reference image(s), producing an image with none of the requested consistency. Set model to ${alternatives.map((key) => `"${key}"`).join(' or ')}, or drop referenceRefs.`,
        ),
      );
    }

    if (limits !== undefined) {
      for (const [role, limit] of Object.entries(limits)) {
        const count = requested.filter((reference) => reference.role === role).length;
        if (count > limit) {
          return await failureWithError(
            ctx,
            validationError(
              `Model "${model}" honours at most ${String(limit)} ${role} reference(s); ${String(count)} were supplied. The extra ones are ignored rather than blended, so drop them before generating.`,
            ),
          );
        }
      }
    }

    const sources = new MediaSourceResolver(ctx, persistence.target);
    const references: ImageReferenceInput[] = [];
    const boundEntityVersions: MediaBoundEntity[] = [];
    for (const [index, reference] of requested.entries()) {
      const resolved = await sources.resolve({
        ref: reference.ref,
        role: reference.role,
        label: reference.label,
        field: `referenceRefs[${String(index)}].ref`,
      });
      if (!resolved.ok) return await failureWithError(ctx, resolved.error);
      references.push({
        data: resolved.source.data,
        mimeType: resolved.source.mimeType,
        role: reference.role,
        ...(reference.label !== undefined ? { label: reference.label } : {}),
      });
      if (resolved.source.bound) boundEntityVersions.push(resolved.source.bound);
    }

    const renderFields = {
      prompt: params.prompt,
      ...(references.length > 0 ? { references } : {}),
      size: params.size,
      n: params.n,
      quality: params.quality,
      aspectRatio: params.aspectRatio,
      outputFormat: params.outputFormat,
      background: params.background,
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

    const response = await adapter.generateImage({
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
    return await deps.handleError(ctx, 'Image generation failed', error);
  }
}
