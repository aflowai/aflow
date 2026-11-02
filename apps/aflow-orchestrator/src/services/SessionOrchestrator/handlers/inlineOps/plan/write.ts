import {
  holdsPlanNodeWait,
  isPersonTrigger,
  PlanNodeCreateInputSchema,
  PlanNodeDependInputSchema,
  PlanNodeLearnInputSchema,
  PlanNodeLinkInputSchema,
  PlanNodeUpdateInputSchema,
  StepJobMessageSchema,
  type HeldWait,
  type PlanNode,
  type PlanNodeCreateOutput,
  type PlanNodeDependOutput,
  type PlanNodeLearnOutput,
  type PlanNodeLinkOutput,
  type PlanNodeUpdateOutput,
  type WaitRegistration,
} from '@aflow/schemas';
import {
  createPlanNode,
  dependPlanNode,
  learnOnPlanNode,
  linkPlanNode,
  updatePlanNode,
  restrictedPlanWriteAuthority,
  type PlanWriteContext,
} from '@aflow/cybernetic-runtime';
import { getDatabase } from '@aflow/database';
import { getSessionState, type SessionHotState } from '@aflow/redis';
import { dispatchOrWaitOnExecutor } from '../../../scheduling/executorWait.js';
import { sessionUser } from '../sessionUser.js';
import { requireSpaceId } from '../spaceScope.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';
import {
  endPlanNodeHold,
  holdForPlanNode,
  restorePlanNodeHold,
  type PlanNodeHoldTarget,
} from '../../../../waits/planNode.js';

async function readSessionState(args: InlineHandlerArgs): Promise<SessionHotState | null> {
  return getSessionState(args.redis, args.context.tenantId, args.context.runId).catch(() => null);
}

function writeContext(args: InlineHandlerArgs, state: SessionHotState | null): PlanWriteContext {
  return {
    ...planReadContext(args),
    redis: args.redis,
    tenantId: args.context.tenantId as string,
    actorKind: 'agent',
    resident: restrictedPlanWriteAuthority(state),
  };
}

async function planWriteContext(args: InlineHandlerArgs): Promise<PlanWriteContext> {
  return writeContext(args, await readSessionState(args));
}

/**
 * The session, where it is a conversation only a person starts (Plan 337 P4):
 * a node it writes links it, so the operator finds the talk from the node.
 * A scheduled wake or an API run links nothing.
 */
function operatorConversation(
  args: InlineHandlerArgs,
  state: SessionHotState | null,
): string | undefined {
  return state !== null && isPersonTrigger(state.trigger) ? args.context.runId : undefined;
}

function holdTarget(args: InlineHandlerArgs, nodeId: string): PlanNodeHoldTarget {
  return {
    tenantId: args.context.tenantId as string,
    spaceId: requireSpaceId(args.context),
    sessionId: args.context.runId as string,
    nodeId,
  };
}

function holdDeps(args: InlineHandlerArgs) {
  return { redis: args.redis, db: getDatabase() };
}

function warnHold(message: string, nodeId: string, error: unknown): void {
  console.warn(`[plan-node-wait] ${message}`, {
    nodeId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Release the wait this conversation holds on the node before a status write
 * by it is recorded. The write's own event then finds no wait of its own to
 * end, so the conversation is not woken about what it did.
 */
async function releaseBeforeWrite(
  args: InlineHandlerArgs,
  nodeId: string,
): Promise<WaitRegistration[]> {
  if (args.workflowExecution !== undefined) return [];
  try {
    return await endPlanNodeHold(holdDeps(args), holdTarget(args, nodeId));
  } catch (error) {
    warnHold('the wait was not released before the write', nodeId, error);
    return [];
  }
}

/** A write that did not land holds again what it released. */
async function restoreAfterRefusal(
  args: InlineHandlerArgs,
  nodeId: string,
  released: readonly WaitRegistration[],
): Promise<void> {
  try {
    await restorePlanNodeHold(holdDeps(args), holdTarget(args, nodeId), released);
  } catch (error) {
    warnHold('the write did not land, and its released wait was not held again', nodeId, error);
  }
}

/**
 * The wait a write that set a node blocked or waiting holds for the
 * conversation that made it (Plan 339 D4's discipline, for plan nodes). The
 * write has committed, so a failed hold leaves the result without a wait
 * rather than failing it.
 */
async function holdAfterWrite(args: InlineHandlerArgs, node: PlanNode): Promise<HeldWait | null> {
  if (args.workflowExecution !== undefined || !holdsPlanNodeWait(node.status)) return null;
  try {
    return await holdForPlanNode(holdDeps(args), holdTarget(args, node.nodeId));
  } catch (error) {
    warnHold('the write landed, but its wait was not held', node.nodeId, error);
    return null;
  }
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
  const wait = await holdAfterWrite(args, result.node);
  const output: PlanNodeCreateOutput = {
    node: result.node,
    ...(wait !== null ? { wait } : {}),
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}

export async function handlePlanNodeUpdate(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeUpdateInputSchema, startTime);
  if (!input) return;
  const state = await readSessionState(args);
  const context = writeContext(args, state);
  if (context.resident && input.status === 'done') {
    const credentialOwnerId = await sessionUser(args);
    // The API executor records the close, so the release precedes the dispatch.
    const released = await releaseBeforeWrite(args, input.nodeId);
    try {
      await dispatchOrWaitOnExecutor(
        args.redis,
        StepJobMessageSchema.parse({
          tenantId: args.context.tenantId,
          ...(args.workflowExecution
            ? { workflowExecution: args.workflowExecution }
            : { sessionId: args.context.runId }),
          spaceId: context.spaceId,
          stepExecutionId: args.stepExecutionId,
          parentStepExecutionId: args.parentStepExecutionId,
          stepId: args.stepDef.stepId,
          stepType: 'api',
          operationId: args.stepDef.operation,
          idempotencyKey: args.idempotencyKey,
          inputRef: args.resolvedInputRef,
          traceId: args.context.traceId,
          attempt: args.attempt,
          scheduledAtMs: args.scheduledAtMs,
          credentialOwnerId,
        }),
      );
    } catch (error) {
      await restoreAfterRefusal(args, input.nodeId, released);
      throw error;
    }
    return;
  }
  const conversationId = operatorConversation(args, state);
  const released = input.status !== undefined ? await releaseBeforeWrite(args, input.nodeId) : [];
  let result: Awaited<ReturnType<typeof updatePlanNode>>;
  try {
    result = await updatePlanNode(
      { ...context, ...(conversationId !== undefined ? { conversationId } : {}) },
      input,
    );
  } catch (error) {
    await restoreAfterRefusal(args, input.nodeId, released);
    throw error;
  }
  if (!result.ok) {
    await restoreAfterRefusal(args, input.nodeId, released);
    await emitPlanError(args, result, startTime);
    return;
  }
  const wait = input.status !== undefined ? await holdAfterWrite(args, result.node) : null;
  const output: PlanNodeUpdateOutput = {
    node: result.node,
    ...(wait !== null ? { wait } : {}),
    ...(result.carrier ? { carrier: result.carrier } : {}),
    ...(result.carrierFailure ? { carrierFailure: result.carrierFailure } : {}),
    ...(result.linkFailure ? { linkFailure: result.linkFailure } : {}),
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
