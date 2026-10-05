import {
  PlanNodeCreateInputSchema,
  PlanNodeUpdateInputSchema,
  type PlanNodeCreateOutput,
  type PlanNodeUpdateOutput,
} from '@aflow/schemas';
import { createPlanNode, updatePlanNode, type PlanWriteContext } from '@aflow/cybernetic-runtime';
import { getDatabase } from '@aflow/database';
import { getSessionStateSafe } from '@aflow/redis';
import { readDurableSessionCreatedBy } from '../../../../cybernetic/harness/helpers.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

/** Hot state can be gone after a terminal flush, so the durable session row answers then. */
async function sessionUser(args: InlineHandlerArgs): Promise<string | undefined> {
  const { tenantId, runId } = args.context;
  const state = await getSessionStateSafe(args.redis, tenantId, runId);
  return (
    (state.ok ? state.state.createdBy : undefined) ??
    (await readDurableSessionCreatedBy(getDatabase(), tenantId, runId))
  );
}

function planWriteContext(args: InlineHandlerArgs): PlanWriteContext {
  return {
    ...planReadContext(args),
    redis: args.redis,
    tenantId: args.context.tenantId as string,
  };
}

export async function handlePlanNodeCreate(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeCreateInputSchema, startTime);
  if (!input) return;
  const createdBy = await sessionUser(args);
  const result = await createPlanNode(
    { ...planWriteContext(args), ...(createdBy !== undefined ? { createdBy } : {}) },
    input,
  );
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeCreateOutput = { node: result.node };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeUpdate(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeUpdateInputSchema, startTime);
  if (!input) return;
  const result = await updatePlanNode(planWriteContext(args), input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeUpdateOutput = { node: result.node };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
