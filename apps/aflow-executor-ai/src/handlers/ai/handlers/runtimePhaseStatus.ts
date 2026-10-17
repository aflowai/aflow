import type { ExecutorContext } from '@aflow/executor-runtime';
import type { RuntimePhase } from '@aflow/ai-client';

export function runtimePhaseLine(phase: RuntimePhase, modelName: string): string {
  switch (phase.phase) {
    case 'loading_model':
      return `Loading ${modelName} into memory…`;
    case 'reading_prompt':
      return 'Reading the conversation…';
  }
}

/**
 * Puts a local model's silent stretches on the step's `status` channel, where
 * the chat shows them in place of a bare spinner until the first token. Each
 * phase also slides the idle window: a load is the runtime working, not a
 * stall.
 */
export function reportRuntimePhases(
  ctx: ExecutorContext,
  modelName: string,
): (phase: RuntimePhase) => void {
  return (phase) => {
    ctx.reportProgress?.();
    ctx.emitLiveDelta('status', `${runtimePhaseLine(phase, modelName)}\n`).catch((err: unknown) => {
      ctx.log.warn('Live status delta dropped', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
