import type { z } from 'zod';
import { getDatabase } from '@aflow/database';
import {
  createPlanNodeStore,
  type PlanOpError,
  type PlanReadContext,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepError, readInlineOpInput } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';

export function planReadContext(args: InlineHandlerArgs): PlanReadContext {
  return {
    store: createPlanNodeStore(getDatabase(), args.context.tenantId as string),
    spaceId: requireSpaceId(args.context),
  };
}

/**
 * Parsed here, not only against the catalog's JSON Schema at scheduling: that
 * form cannot carry a refinement, and "done needs an outcome" is one.
 */
export async function parsePlanInput<Output>(
  args: InlineHandlerArgs,
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  startTime: number,
): Promise<Output | null> {
  const parsed = schema.safeParse((await readInlineOpInput(args)) ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  await emitStepError(
    args,
    'PLAN_NODE_INVALID_INPUT',
    `Invalid input for ${args.stepDef.operation}: ${issues}`,
    startTime,
    'validation',
  );
  return null;
}

/** A refusal from the plan engine — not found, stale, a cycle — is the caller's to correct. */
export async function emitPlanError(
  args: InlineHandlerArgs,
  error: PlanOpError,
  startTime: number,
): Promise<void> {
  await emitStepError(
    args,
    error.code,
    error.message,
    startTime,
    'validation',
    false,
    error.details,
  );
}
