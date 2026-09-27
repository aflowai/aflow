export function isInlineOperation(operationId: string): boolean {
  return (
    operationId.startsWith('catalog.') ||
    operationId.startsWith('platform.') ||
    operationId.startsWith('space.manage.') ||
    operationId.startsWith('agent.manage.') ||
    operationId.startsWith('agent.schedule.') ||
    operationId.startsWith('guardrail.') ||
    operationId.startsWith('workflow.') ||
    operationId.startsWith('learner.') ||
    operationId.startsWith('proposal.') ||
    operationId.startsWith('skill.compose.') || // 104f
    operationId.startsWith('capability.binding.') || // 104g
    operationId.startsWith('capability.validate.') ||
    operationId.startsWith('integration.registry.') ||
    operationId.startsWith('integration.simulation.') ||
    operationId.startsWith('store.listing.') ||
    operationId === 'eval.dataset.get' ||
    operationId === 'eval.dataset.list' ||
    operationId === 'eval.case.promote' ||
    operationId === 'eval.case.propose' ||
    operationId === 'eval.batch.run' ||
    operationId === 'eval.batch.get' ||
    operationId === 'eval.batch.compare' ||
    operationId === 'eval.batch.list' ||
    operationId === 'api.definition.list' ||
    operationId.startsWith('api.definition.') ||
    operationId.startsWith('api.binding.') ||
    operationId.startsWith('api.webhook.') ||
    operationId === 'agent.control.run_step' ||
    operationId === 'agent.control.delegate' ||
    operationId === 'agent.control.resume' ||
    operationId === 'agent.control.end' ||
    operationId === 'agent.control.submit_output' ||
    operationId === 'agent.control.draft_patch' ||
    operationId === 'agent.control.draft_get' ||
    operationId === 'agent.control.signal_blocked' ||
    operationId === 'mcp.tool.discover' ||
    operationId === 'mcp.tool.promote' ||
    operationId === 'mcp.binding.consent' ||
    operationId === 'mcp.binding.get' ||
    operationId === 'mcp.binding.list' ||
    operationId === 'human.chat.ask' ||
    operationId === 'human.action_center.focus' ||
    operationId === 'artifact.inspect.list' ||
    operationId === 'artifact.inspect.read'
  );
}

export const WORKFLOW_TASK_SAFE_INLINE_OPERATIONS: ReadonlySet<string> = new Set([
  // compose-skill workflow tasks
  'skill.compose.prepare_surface',
  'skill.compose.validate_task_graph',
  'skill.compose.validate_source_coverage',
  'skill.compose.assemble_workflow',
  'skill.compose.propose',
  'capability.validate.grants',
  // eval-suite-design workflow task: proposes, never writes
  'eval.case.propose',
  // bind-capability workflow tasks
  'capability.binding.propose',
  'store.listing.install',
  'workflow.learn',
  'agent.schedule.snooze',
]);

export function isWorkflowTaskSafeInlineOperation(operationId: string): boolean {
  return WORKFLOW_TASK_SAFE_INLINE_OPERATIONS.has(operationId);
}

/** The safelist as a stable list, for the guard that pins it to `isInlineOperation`. */
export const WORKFLOW_TASK_SAFE_INLINE_OPERATION_IDS: readonly string[] = [
  ...WORKFLOW_TASK_SAFE_INLINE_OPERATIONS,
];
