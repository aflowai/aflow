import { readBindingEndpoint } from '@aflow/aflow-executor-api/binding-read';
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
  readMergedPullRequest,
  type PlanWriteContext,
} from '@aflow/cybernetic-runtime';
import { getSessionState } from '@aflow/redis';
import { getDatabase } from '@aflow/database';
import { sessionUser } from '../sessionUser.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

async function planWriteContext(args: InlineHandlerArgs): Promise<PlanWriteContext> {
  const read = planReadContext(args);
  const state = await getSessionState(args.redis, args.context.tenantId, args.context.runId).catch(
    () => null,
  );
  return {
    ...read,
    redis: args.redis,
    tenantId: args.context.tenantId as string,
    actorKind: 'agent',
    resident:
      !state ||
      state.trigger === 'schedule' ||
      (!['chat', 'voice'].includes(state.trigger ?? '') && state.activatedByPerson !== true),
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
    { ...(await planWriteContext(args)), ...(createdBy !== undefined ? { createdBy } : {}) },
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
  const result = await updatePlanNode(
    {
      ...(await planWriteContext(args)),
      readMergedPullRequest: (url, nodeId) =>
        readMergedPullRequest(
          getDatabase(),
          args.context.tenantId as string,
          planReadContext(args).spaceId,
          url,
          nodeId,
          {
            payloadStore: args.payloadStore,
            readBinding: async (bindingId, endpointId, params) => {
              const credentialOwnerId = await sessionUser(args);
              return readBindingEndpoint(
                {
                  db: getDatabase(),
                  redis: args.redis,
                  payloadStore: args.payloadStore,
                  tenantId: args.context.tenantId as string,
                  spaceId: planReadContext(args).spaceId,
                  runId: args.context.runId as string,
                  ...(credentialOwnerId ? { credentialOwnerId } : {}),
                },
                bindingId,
                endpointId,
                params,
              );
            },
          },
        ),
    },
    input,
  );
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeUpdateOutput = {
    node: result.node,
    ...(result.carrier ? { carrier: result.carrier } : {}),
    ...(result.carrierFailure ? { carrierFailure: result.carrierFailure } : {}),
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeDepend(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeDependInputSchema, startTime);
  if (!input) return;
  const result = await dependPlanNode(await planWriteContext(args), input);
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
  const result = await learnOnPlanNode(await planWriteContext(args), input, {
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
  const result = await linkPlanNode(await planWriteContext(args), input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  const output: PlanNodeLinkOutput = { link: result.link };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
