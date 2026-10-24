import type { Redis } from 'ioredis';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';
import { emitStepError } from './helpers.js';
import type { InlineHandlerArgs } from './types.js';

export const INLINE_INPUT_READ_FAILED = 'WORKFLOW_INPUT_READ_FAILED';

/**
 * Read an inline handler's resolved input — the one reader every inline
 * handler goes through.
 *
 * An absent or empty ref is an op called with no input, so it reads as `{}`
 * and list ops keep their defaults. A PRESENT ref that cannot be read is a
 * different thing: running the op on `{}` would answer with defaults (a list
 * of everything, a validation error naming fields the caller did send) while
 * the real input sits unread. So it fails the step with the store's message
 * and answers `null`; the caller returns without emitting anything else.
 *
 * A guard test (`readInlineInput.guard.test.ts`) fails on any handler that
 * calls `payloadStore.retrieve` on its resolved input ref itself.
 */
export async function readInlineInput(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<Record<string, unknown> | null> {
  if (!args.resolvedInputRef) return {};
  let data: unknown;
  try {
    data = await args.payloadStore.retrieve(args.resolvedInputRef);
  } catch (err) {
    await emitStepError(
      args,
      INLINE_INPUT_READ_FAILED,
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
    return null;
  }
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

/** The handler args a positional-signature inline handler was called with. */
export function inlineArgsFromPositional(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): InlineHandlerArgs {
  return {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    scheduledAtMs,
    ...(parentStepExecutionId !== undefined ? { parentStepExecutionId } : {}),
  };
}
