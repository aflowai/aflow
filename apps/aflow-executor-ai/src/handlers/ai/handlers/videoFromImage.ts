/**
 * ai.media.animate - Video from image (multi-provider via AIClient).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError } from '@aflow/executor-runtime';
import type { AiVideoFromImageInput, MediaBoundEntity } from '@aflow/schemas';
import type { ImageReferenceInput } from '@aflow/ai-client';
import type { HandlerDeps } from './types.js';
import { resolveMediaPersistence } from './mediaPersist.js';
import { MediaSourceResolver } from './mediaSourceRef.js';
import { runVideoJob } from './videoJobRunner.js';

export async function handleVideoFromImage(
  ctx: ExecutorContext,
  params: AiVideoFromImageInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  const label = 'Video from image failed';

  // The same refusal the runner makes before it submits, made before the frames
  // are read: a render with nowhere to file its bytes is refused, not paid for.
  const persistence = resolveMediaPersistence(ctx, deps);
  if (!persistence.ok) return await failureWithError(ctx, persistence.error);

  const sources = new MediaSourceResolver(ctx, persistence.target);
  const boundEntityVersions: MediaBoundEntity[] = [];
  const references: ImageReferenceInput[] = [];

  let lastFrameData: string | undefined;
  let lastFrameMimeType: string | undefined;
  let firstFrameData: string;
  let firstFrameMimeType: string;
  try {
    const firstFrame = await sources.resolve({
      ref: params.imageRef,
      role: 'first_frame',
      field: 'imageRef',
    });
    if (!firstFrame.ok) return await failureWithError(ctx, firstFrame.error);
    firstFrameData = firstFrame.source.data;
    firstFrameMimeType = firstFrame.source.mimeType;
    if (firstFrame.source.bound) boundEntityVersions.push(firstFrame.source.bound);

    if (params.lastFrameRef !== undefined) {
      const lastFrame = await sources.resolve({
        ref: params.lastFrameRef,
        role: 'last_frame',
        field: 'lastFrameRef',
      });
      if (!lastFrame.ok) return await failureWithError(ctx, lastFrame.error);
      lastFrameData = lastFrame.source.data;
      lastFrameMimeType = lastFrame.source.mimeType;
      if (lastFrame.source.bound) boundEntityVersions.push(lastFrame.source.bound);
    }

    for (const [index, reference] of (params.referenceRefs ?? []).entries()) {
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
  } catch (error) {
    return await deps.handleError(ctx, label, error);
  }

  return await runVideoJob(
    ctx,
    {
      modelKey: params.model,
      boundEntityVersions,
      request: {
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        imageData: firstFrameData,
        imageMimeType: firstFrameMimeType,
        lastFrameData,
        lastFrameMimeType,
        ...(references.length > 0 ? { references } : {}),
        durationSeconds: params.durationSeconds,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
      },
    },
    deps,
    label,
  );
}
