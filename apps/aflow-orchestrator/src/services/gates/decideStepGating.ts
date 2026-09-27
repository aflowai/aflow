import {
  enforceGrant,
  type GrantEnforcementResult,
  type RunAccessGrant,
  type OperationDescriptor,
  type StepDefinition,
  type CallerContext,
} from '@aflow/schemas';

export interface DecideStepGatingArgs {
  /** The step we're about to schedule. */
  stepDef: StepDefinition;
  /** Operation descriptor (registry lookup) — may be undefined for unknown ops. */
  opDesc: OperationDescriptor | undefined;
  /** Cached run access grant (may be null/expired). */
  grant: RunAccessGrant | null;
  /** Derived from the op descriptor + the run's grant context. */
  opMutates: boolean;
  opPrivileged: boolean;
  opCapabilityGroupId: string;
  opAccessMode: string;
  opRiskModifiers: string[];
  /** All step definitions in the agent/workflow (for caller-kind inference). */
  allSteps?: readonly StepDefinition[];
}

/**
 * Infer whether this step is invoked from an agent tool loop or a workflow
 * operation task. Defaults to `'agent'` when uncertain (fail-closed).
 */
export function callerKindFromStep(
  stepDef: StepDefinition,
  _allSteps?: readonly StepDefinition[],
): CallerContext['kind'] {
  const tags = stepDef.tags ?? [];

  // Agent-loop lowered tools stamp `parent:<agentStepId>`.
  if (tags.some((t) => t.startsWith('parent:'))) {
    return 'agent';
  }

  // Virtual tools emitted by agent-tool lowering.
  if (tags.includes('virtual_mcp_tool') || tags.includes('virtual_api_tool')) {
    return 'agent';
  }

  // Agent turn and dynamic run_step invocations are always agent-context.
  if (stepDef.operation === 'ai.agent.turn' || stepDef.operation === 'agent.control.run_step') {
    return 'agent';
  }

  // Workflow harness operation tasks stamp `_taskId:<id>` without a parent tag.
  if (tags.some((t) => t.startsWith('_taskId:'))) {
    return 'op_task';
  }

  return 'agent';
}

export function decideStepGating(args: DecideStepGatingArgs): GrantEnforcementResult {
  if (args.opDesc?.bypassGrant) {
    return { allowed: true };
  }

  const callerKind = callerKindFromStep(args.stepDef, args.allSteps);

  const bindingTaskOnly = args.stepDef.tags.includes('_opTaskOnly');

  return enforceGrant(
    args.grant,
    args.stepDef.operation,
    args.opMutates,
    args.opPrivileged,
    args.opCapabilityGroupId,
    args.opAccessMode,
    args.opRiskModifiers,
    {
      opTaskOnly: args.opDesc?.opTaskOnly ?? false,
      bindingTaskOnly,
    },
    { kind: callerKind },
  );
}
