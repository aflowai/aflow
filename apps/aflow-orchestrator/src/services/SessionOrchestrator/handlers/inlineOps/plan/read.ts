import {
  PlanNodeGetInputSchema,
  PlanNodeListInputSchema,
  type PlanNodeGetOutput,
  type PlanNodeListOutput,
} from '@aflow/schemas';
import { getPlanNode, listPlanNodes } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

export async function handlePlanNodeGet(args: InlineHandlerArgs, startTime: number): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeGetInputSchema, startTime);
  if (!input) return;
  const result = await getPlanNode(planReadContext(args), input.nodeId);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeGetOutput = {
    node: result.node,
    children: result.children,
    childrenTotal: result.childrenTotal,
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeList(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeListInputSchema, startTime);
  if (!input) return;
  const result = await listPlanNodes(planReadContext(args), input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeListOutput = { nodes: result.nodes, truncated: result.truncated };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
