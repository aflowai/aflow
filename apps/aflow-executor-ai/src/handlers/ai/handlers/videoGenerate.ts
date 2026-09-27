/**
 * ai.media.video - Video generation (multi-provider via AIClient).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { AiVideoGenerateInput } from '@aflow/schemas';
import type { HandlerDeps } from './types.js';
import { runVideoJob } from './videoJobRunner.js';

export async function handleVideoGenerate(
  ctx: ExecutorContext,
  params: AiVideoGenerateInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  return await runVideoJob(
    ctx,
    {
      modelKey: params.model,
      boundEntityVersions: [],
      request: {
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        durationSeconds: params.durationSeconds,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
      },
    },
    deps,
    'Video generation failed',
  );
}
