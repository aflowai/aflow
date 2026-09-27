/**
 * Dispatch inline operations — route to the appropriate inline handler
 * based on operation ID.
 */
import type { Redis } from 'ioredis';
import { handleDraftGetInline, handleDraftPatchInline } from './inlineOps/taskDraft.js';
import type {
  StepExecutionId,
  IdempotencyKey,
  OperationId,
  WorkflowExecutionRef,
} from '@aflow/schemas';
import type { StepDefinition } from '@aflow/schemas';
import { SNOOZE_OPERATION_ID } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { addStepResult } from '@aflow/redis';
import type { FlowExecutionContext } from '../types.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  handleGetSchemaInline,
  handleCatalogSearchInline,
  handleGetDefinitionSchemaInline,
  handleRunStepInline,
  handleDelegateInline,
  handleEndFlowInline,
  handleListApiDefinitionsInline,
  handleApiAdminOpInline,
  handleAgentCrudInline,
  handleSpaceCrudInline,
  handleGuardrailCrudInline,
  handleScheduleCrudInline,
  handleWebhookCrudInline,
  handleWorkflowCrudInline,
  handleCoachCrudInline,
  handleProposalCrudInline,
  handleCatalogAgentInline,
  handleResumeInline,
  handleSkillComposeInline,
  handleEvalCaseProposeInline,
  handleSkillManageInline,
  handlePrepareDesignSurfaceInline,
  handleAssembleWorkflowInline,
  handleCapabilityBindingInline,
  handleIntegrationRegistryLookupInline,
  handleIntegrationRegistryListInline,
  handleSimulationOpInline,
  handleMcpBindingAdminInline,
  handleHumanChatAskInline,
  handleHumanActionCenterFocusInline,
  handleArtifactInspectInline,
  handleValidateTaskGraphInline,
  handleValidateSourceCoverageInline,
  handleCapabilityValidateGrantsInline,
  handleMcpToolDiscoverInline,
  handleMcpToolPromoteInline,
  handleCatalogToolPromoteInline,
  handleMcpBindingConsentInline,
  handleScheduleSnoozeInline,
  handleStoreListingSearchInline,
  handleStoreListingGetInline,
  handleStoreListingInstallInline,
  handleEvalDatasetGetInline,
  handleEvalDatasetListInline,
  handleEvalCasePromoteInline,
  handleEvalBatchRunInline,
  handleEvalBatchGetInline,
  handleEvalBatchCompareInline,
  handleEvalBatchListInline,
} from './inlineOps/index.js';

export async function dispatchInlineOp(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  now: number,
  parentStepExecutionId?: StepExecutionId,
  workflowExecution?: WorkflowExecutionRef,
): Promise<void> {
  const workflowExecutionFields = workflowExecution ? { workflowExecution } : {};
  if (stepDef.operation === 'catalog.tool.search') {
    await handleCatalogSearchInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'catalog.tool.list') {
    await handleGetSchemaInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'catalog.tool.promote') {
    await handleCatalogToolPromoteInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'mcp.tool.discover') {
    await handleMcpToolDiscoverInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'mcp.tool.promote') {
    await handleMcpToolPromoteInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'mcp.binding.get' || stepDef.operation === 'mcp.binding.list') {
    await handleMcpBindingAdminInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'mcp.binding.consent') {
    await handleMcpBindingConsentInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.manage.get_definition_schema') {
    await handleGetDefinitionSchemaInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'api.definition.list') {
    await handleListApiDefinitionsInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (
    stepDef.operation.startsWith('api.definition.') ||
    stepDef.operation.startsWith('api.binding.')
  ) {
    await handleApiAdminOpInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.run_step') {
    await handleRunStepInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'human.chat.ask') {
    await handleHumanChatAskInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'human.action_center.focus') {
    await handleHumanActionCenterFocusInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'agent.control.delegate') {
    await handleDelegateInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.resume') {
    await handleResumeInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.end') {
    await handleEndFlowInline(
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      now,
      parentStepExecutionId,
    );
  } else if (stepDef.operation === 'agent.control.draft_patch') {
    await handleDraftPatchInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.draft_get') {
    await handleDraftGetInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.submit_output') {
    const { handleSubmitOutputInline } = await import('./inlineOps/runnerOutput.js');
    await handleSubmitOutputInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'agent.control.signal_blocked') {
    const { handleSignalBlockedInline } = await import('./inlineOps/runnerOutput.js');
    await handleSignalBlockedInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('agent.manage.')) {
    await handleAgentCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('space.manage.')) {
    await handleSpaceCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === SNOOZE_OPERATION_ID) {
    await handleScheduleSnoozeInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('agent.schedule.')) {
    await handleScheduleCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('api.webhook.')) {
    await handleWebhookCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('artifact.inspect.')) {
    await handleArtifactInspectInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('learner.')) {
    await handleCoachCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('proposal.')) {
    await handleProposalCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('workflow.')) {
    await handleWorkflowCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('catalog.agent.')) {
    await handleCatalogAgentInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'skill.compose.prepare_surface') {
    await handlePrepareDesignSurfaceInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'skill.compose.assemble_workflow') {
    await handleAssembleWorkflowInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'skill.compose.validate_task_graph') {
    await handleValidateTaskGraphInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'skill.compose.validate_source_coverage') {
    await handleValidateSourceCoverageInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.case.propose') {
    await handleEvalCaseProposeInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('skill.compose.')) {
    await handleSkillComposeInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('skill.manage.')) {
    await handleSkillManageInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'capability.validate.grants') {
    await handleCapabilityValidateGrantsInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('capability.binding.')) {
    await handleCapabilityBindingInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'integration.registry.lookup') {
    await handleIntegrationRegistryLookupInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'integration.registry.list') {
    await handleIntegrationRegistryListInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('integration.simulation.')) {
    await handleSimulationOpInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'store.listing.search') {
    await handleStoreListingSearchInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'store.listing.get') {
    await handleStoreListingGetInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'store.listing.install') {
    await handleStoreListingInstallInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.dataset.get') {
    await handleEvalDatasetGetInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.dataset.list') {
    await handleEvalDatasetListInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.case.promote') {
    await handleEvalCasePromoteInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.batch.run') {
    await handleEvalBatchRunInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.batch.get') {
    await handleEvalBatchGetInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.batch.compare') {
    await handleEvalBatchCompareInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation === 'eval.batch.list') {
    await handleEvalBatchListInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else if (stepDef.operation.startsWith('guardrail.')) {
    await handleGuardrailCrudInline({
      redis,
      payloadStore,
      context,
      stepDef,
      stepExecutionId,
      idempotencyKey,
      resolvedInputRef,
      attempt,
      scheduledAtMs: now,
      ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
      ...workflowExecutionFields,
    });
  } else {
    // Unknown inline operation — emit FAILED result instead of silently ending the run
    const errorData = {
      code: 'UNROUTED_INLINE_OPERATION',
      message: `Unknown operation: "${stepDef.operation}". Operation not found in the catalog. Use catalog.tool.list to discover available operations.`,
      classification: 'validation' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;
    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - now,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
    logOrchestratorError(
      `[SessionOrchestrator] Unrouted inline operation: ${stepDef.operation}`,
      new Error(`Unrouted inline operation: ${stepDef.operation}`),
      {
        tenantId: context.tenantId,
        sessionId: context.runId,
        operationId: stepDef.operation,
        stepId: stepDef.stepId,
      },
    );
  }
}
