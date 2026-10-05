import {
  PLAN_NODE_CREATE_OPERATION_ID,
  PLAN_NODE_GET_OPERATION_ID,
  PLAN_NODE_LIST_OPERATION_ID,
  PLAN_NODE_UPDATE_OPERATION_ID,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepError } from '../helpers.js';
import { handlePlanNodeCreate, handlePlanNodeUpdate } from './write.js';
import { handlePlanNodeGet, handlePlanNodeList } from './read.js';

/** `plan.node.*` — the Helmsman's plan, through the one engine in `@aflow/cybernetic-runtime`. */
export async function handlePlanNodeInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();
  try {
    switch (operationId) {
      case PLAN_NODE_CREATE_OPERATION_ID:
        await handlePlanNodeCreate(args, startTime);
        break;
      case PLAN_NODE_UPDATE_OPERATION_ID:
        await handlePlanNodeUpdate(args, startTime);
        break;
      case PLAN_NODE_GET_OPERATION_ID:
        await handlePlanNodeGet(args, startTime);
        break;
      case PLAN_NODE_LIST_OPERATION_ID:
        await handlePlanNodeList(args, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown plan operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    getOrchestratorLogger().error(
      `plan: ${operationId} failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
      { tenantId: args.context.tenantId, sessionId: args.context.runId },
    );
    await emitStepError(
      args,
      'PLAN_OPERATION_FAILED',
      `System error: ${operationId} could not be completed due to an internal failure. Do not retry — report this to the operator.`,
      startTime,
      'internal',
    );
  }
}
