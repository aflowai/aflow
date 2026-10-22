import {
  PlanNodeCreateInputSchema,
  PlanNodeDependInputSchema,
  PlanNodeLearnInputSchema,
  PlanNodeLinkInputSchema,
  PlanNodeUpdateInputSchema,
  type PlanNodeCreateOutput,
  type PlanNodeDependOutput,
  type PlanNodeLearnOutput,
  type PlanNodeLinkOutput,
  type PlanNodeUpdateOutput,
} from '@aflow/schemas';
import {
  createPlanNode,
  dependPlanNode,
  learnOnPlanNode,
  linkPlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '@aflow/cybernetic-runtime';
import { sessionUser } from '../sessionUser.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

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

export async function handlePlanNodeDepend(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeDependInputSchema, startTime);
  if (!input) return;
  const result = await dependPlanNode(planWriteContext(args), input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeDependOutput = {
    node: result.node,
    ...(result.dependency !== undefined ? { dependency: result.dependency } : {}),
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeLearn(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeLearnInputSchema, startTime);
  if (!input) return;
  const result = await learnOnPlanNode(planWriteContext(args), input, {
    sessionId: args.context.runId,
  });
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeLearnOutput = { learning: result.learning, superseded: result.superseded };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeLink(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeLinkInputSchema, startTime);
  if (!input) return;
  const result = await linkPlanNode(planWriteContext(args), input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeLinkOutput = { link: result.link };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
