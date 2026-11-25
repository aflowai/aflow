/**
 * The orchestrator half of a dry run's write hold. A platform write a dry run
 * asks for — memory, campaign, learnings and every other write-mode operation
 * `dryRunWriteDisposition` holds — never dispatches: it succeeds at once with
 * the held result, and its result message carries the held write for the run
 * to record. API writes are held by the API executor, which reads the tier.
 */
import { recordDryRunHeldWrite, type Database } from '@aflow/database';
import { addStepResult } from '@aflow/redis';
import {
  buildDryRunHeldOutput,
  dryRunWriteDisposition,
  previewWrite,
  type DryRunHeldWrite,
  type StepResultMessage,
} from '@aflow/schemas';
import { encodeInlineOpOutputRef } from './inlineOps/helpers.js';
import type { InlineHandlerArgs } from './inlineOps/types.js';

/** Whether a dry run holds `operationId` here, before it dispatches. */
export function orchestratorHoldsInDryRun(operationId: string): boolean {
  return dryRunWriteDisposition(operationId) === 'hold';
}

function stringAt(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/**
 * Where a held platform write would have gone, and the addressing fields the
 * held result echoes. A memory write names its path, a campaign or skill write
 * its slug, and any other write its operation.
 */
export function describeHeldPlatformWrite(
  operationId: string,
  input: unknown,
): { target: string; echo: Record<string, unknown> } {
  const nested =
    input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)['target']
      : undefined;
  const path =
    stringAt(input, 'path') ?? stringAt(nested, 'path') ?? stringAt(input, 'toMemoryPath');
  if (path !== undefined) {
    return { target: `${operationId} ${path}`, echo: { path } };
  }
  const slug = stringAt(input, 'slug');
  if (slug !== undefined) return { target: `${operationId} ${slug}`, echo: { slug } };
  return { target: operationId, echo: {} };
}

/**
 * Hold one platform write of `dryRunOf`: succeed the step with the held result
 * and nothing executed. The result rides the results stream, as an inline
 * operation's does, so it is applied and recorded on the one path every
 * result takes.
 */
export async function emitDryRunHeldResult(
  args: InlineHandlerArgs,
  dryRunOf: string,
): Promise<DryRunHeldWrite> {
  const input = await args.payloadStore.retrieve(args.resolvedInputRef);
  const operationId = args.stepDef.operation;
  const { target, echo } = describeHeldPlatformWrite(operationId, input);
  const preview = previewWrite(input);
  const held: DryRunHeldWrite = {
    runId: dryRunOf,
    operationId,
    target,
    ...(preview !== undefined ? { preview } : {}),
  };
  const outputRef = await encodeInlineOpOutputRef(
    args.payloadStore,
    args.context,
    args.stepExecutionId,
    args.attempt,
    buildDryRunHeldOutput(held, echo),
  );
  await addStepResult(args.redis, {
    messageVersion: 1,
    tenantId: args.context.tenantId,
    ...(args.workflowExecution
      ? { workflowExecution: args.workflowExecution }
      : { sessionId: args.context.runId }),
    stepExecutionId: args.stepExecutionId,
    parentStepExecutionId: args.parentStepExecutionId ?? null,
    stepId: args.stepDef.stepId,
    stepType: args.stepDef.stepType,
    operationId,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    resolvedInputRef: args.resolvedInputRef,
    heldWrite: held,
    durationMs: 0,
    traceId: args.context.traceId,
    finishedAtMs: Date.now(),
  });
  return held;
}

/**
 * Record the write a result says a dry run held, on the dry run it names. Every
 * result passes here before it is applied, whichever tier held the write, so
 * the run's detail lists the writes of its operation tasks and of the sessions
 * its agent tasks ran in alike. A redelivered result records nothing twice.
 */
export async function recordHeldWriteOfResult(
  db: Database,
  result: Pick<
    StepResultMessage,
    'tenantId' | 'heldWrite' | 'stepExecutionId' | 'attempt' | 'sessionId' | 'workflowExecution'
  >,
): Promise<void> {
  if (result.heldWrite === undefined) return;
  await recordDryRunHeldWrite(db, result.tenantId, {
    held: result.heldWrite,
    stepExecutionId: result.stepExecutionId,
    attempt: result.attempt,
    ...(result.workflowExecution !== undefined ? { taskId: result.workflowExecution.taskId } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  });
}
