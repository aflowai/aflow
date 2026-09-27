import type {
  WorkflowPutInput,
  WorkflowPatchInput,
  WorkflowGetInput,
  WorkflowListInput,
  WorkflowRunStartInput,
  WorkflowRunResumeInput,
  WorkflowRunCancelInput,
  WorkflowRunDetailInput,
  WorkflowRunListAttentionInput,
  WorkflowEvaluateInput,
  WorkflowLearnInput,
  WorkflowLedgerGetInput,
  WorkflowCampaignStartInput,
  WorkflowCampaignGetInput,
  WorkflowCampaignListInput,
  WorkflowCampaignUpdateInput,
  WorkflowCampaignEndInput,
  WorkflowCampaignRefreshInput,
} from '@aflow/schemas';
import { WorkflowArchivedError } from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepError } from '../helpers.js';
import { handleWorkflowPut } from './create.js';
import { handleWorkflowPatch } from './update.js';
import { handleWorkflowGet, handleWorkflowList } from './read.js';
import { handleWorkflowRunStart } from './run/start.js';
import { handleWorkflowRunResume } from './run/resume.js';
import { handleWorkflowRunCancel } from './run/cancel.js';
import { handleWorkflowRunDetail } from './run/detail.js';
import { handleWorkflowRunListAttention } from './run/listAttention.js';
import { handleWorkflowEvaluate } from './evaluate.js';
import { handleWorkflowLearn } from './learn.js';
import { handleWorkflowLedgerGet } from './ledgerGet.js';
import { handleWorkflowCampaignStart } from './campaign/start.js';
import { handleWorkflowCampaignGet, handleWorkflowCampaignList } from './campaign/read.js';
import { handleWorkflowCampaignUpdate } from './campaign/update.js';
import { handleWorkflowCampaignEnd } from './campaign/end.js';
import { handleWorkflowCampaignRefresh } from './campaign/refresh.js';

export async function handleWorkflowCrudInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input is valid for list ops */
    }

    switch (operationId) {
      case 'workflow.manage.put':
        await handleWorkflowPut(args, input as unknown as WorkflowPutInput, startTime);
        break;
      case 'workflow.manage.patch':
        await handleWorkflowPatch(args, input as unknown as WorkflowPatchInput, startTime);
        break;
      case 'workflow.manage.get':
        await handleWorkflowGet(args, input as unknown as WorkflowGetInput, startTime);
        break;
      case 'workflow.manage.list':
        await handleWorkflowList(args, input as unknown as WorkflowListInput, startTime);
        break;
      case 'workflow.run.start':
        await handleWorkflowRunStart(args, input as unknown as WorkflowRunStartInput, startTime);
        break;
      case 'workflow.run.resume':
        await handleWorkflowRunResume(args, input as unknown as WorkflowRunResumeInput, startTime);
        break;
      case 'workflow.run.cancel':
        await handleWorkflowRunCancel(args, input as unknown as WorkflowRunCancelInput, startTime);
        break;
      case 'workflow.run.detail':
        await handleWorkflowRunDetail(args, input as unknown as WorkflowRunDetailInput, startTime);
        break;
      case 'workflow.run.list_attention':
        await handleWorkflowRunListAttention(
          args,
          input as unknown as WorkflowRunListAttentionInput,
          startTime,
        );
        break;
      case 'workflow.evaluate':
        await handleWorkflowEvaluate(args, input as unknown as WorkflowEvaluateInput, startTime);
        break;
      case 'workflow.learn':
        await handleWorkflowLearn(args, input as unknown as WorkflowLearnInput, startTime);
        break;
      case 'workflow.ledger.get':
        await handleWorkflowLedgerGet(args, input as unknown as WorkflowLedgerGetInput, startTime);
        break;
      case 'workflow.campaign.start':
        await handleWorkflowCampaignStart(
          args,
          input as unknown as WorkflowCampaignStartInput,
          startTime,
        );
        break;
      case 'workflow.campaign.get':
        await handleWorkflowCampaignGet(
          args,
          input as unknown as WorkflowCampaignGetInput,
          startTime,
        );
        break;
      case 'workflow.campaign.list':
        await handleWorkflowCampaignList(
          args,
          input as unknown as WorkflowCampaignListInput,
          startTime,
        );
        break;
      case 'workflow.campaign.update':
        await handleWorkflowCampaignUpdate(
          args,
          input as unknown as WorkflowCampaignUpdateInput,
          startTime,
        );
        break;
      case 'workflow.campaign.end':
        await handleWorkflowCampaignEnd(
          args,
          input as unknown as WorkflowCampaignEndInput,
          startTime,
        );
        break;
      case 'workflow.campaign.refresh':
        await handleWorkflowCampaignRefresh(
          args,
          input as unknown as WorkflowCampaignRefreshInput,
          startTime,
        );
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown workflow operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    if (err instanceof WorkflowArchivedError) {
      getOrchestratorLogger().warn(
        `workflowCrud: ${operationId} aborted — workflow '${err.workflowSlug}' archived under lock`,
      );
      await emitStepError(args, 'WORKFLOW_ARCHIVED', err.message, startTime, 'validation');
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    const errRec = err as Record<string, unknown>;
    const pgCode = errRec['code'];
    const pgDetail = errRec['detail'];
    // Log the full error server-side; show a generic message to the agent.
    // DB errors and other internal failures should not leak query details.
    // Classified as 'internal' (not retryable) — the agent should not retry.
    getOrchestratorLogger().error(
      `workflowCrud: ${operationId} failed: ${detail}`,
      err instanceof Error ? err : undefined,
      {
        tenantId: args.context.tenantId,
        sessionId: args.context.runId,
        ...(pgCode ? { pgCode } : {}),
        ...(pgDetail ? { pgDetail } : {}),
      },
    );
    await emitStepError(
      args,
      'WORKFLOW_OPERATION_FAILED',
      `System error: ${operationId} could not be completed due to an internal failure. Do not retry — report this to the operator.`,
      startTime,
      'internal',
    );
  }
}
