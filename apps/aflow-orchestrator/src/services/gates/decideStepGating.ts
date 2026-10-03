import {
  BROWSER_PAGE_OPEN_OPERATION_ID,
  buildOperationId,
  enforceGrant,
  getOperation,
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

const HOST_HARNESS_RUN_OPERATION_ID = buildOperationId('host', 'harness', 'run');

export interface DecideHarnessBrowserGatingArgs {
  stepDef: StepDefinition;
  grant: RunAccessGrant | null;
  /** The step's input as it will be sent. */
  resolvedInput: unknown;
  allSteps?: readonly StepDefinition[];
}

/**
 * A harness run given `browser` opens and drives pages in the operator's
 * Chrome, in any profile its space may use — the reach of `browser.page.open`.
 * The harness operation's own capability says nothing about that, so the run's
 * grant has to cover opening a page as well.
 */
export function decideHarnessBrowserGating(
  args: DecideHarnessBrowserGatingArgs,
): GrantEnforcementResult {
  if (args.stepDef.operation !== HOST_HARNESS_RUN_OPERATION_ID) return { allowed: true };
  const input = args.resolvedInput;
  if (typeof input !== 'object' || input === null) return { allowed: true };
  if ((input as Record<string, unknown>)['browser'] === undefined) return { allowed: true };

  const open = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID);
  const decision = enforceGrant(
    args.grant,
    BROWSER_PAGE_OPEN_OPERATION_ID,
    open?.mutates ?? true,
    open?.privileged ?? false,
    open?.capabilityGroupId ?? 'browser.page',
    open?.accessMode ?? 'write',
    open?.riskModifiers ?? [],
    {},
    { kind: callerKindFromStep(args.stepDef, args.allSteps) },
  );
  if (decision.allowed) return decision;
  return {
    allowed: false,
    reason:
      `${HOST_HARNESS_RUN_OPERATION_ID} with \`browser\` is not authorized: a harness browser ` +
      `opens pages, which needs browser.page:write, and this run's grant does not cover it — ` +
      `${decision.reason.replace(/\.$/, '')}. Leave \`browser\` out to run the harness without one.`,
  };
}
