import type { WorkflowTask } from '@aflow/schemas';
import { getOperation, isEvalPlaneOperation, isPlanOperation } from '@aflow/schemas';

/** Teaching error template — `{toolId}` is replaced at validation time. */
export const OP_TASK_ONLY_AGENT_TOOL_ERROR =
  "Tool {toolId} is opTaskOnly. Agents cannot call it directly. Add it as an operation task in the workflow graph. To require human approval before each call, precede it with a type: 'human', intent: 'approve' task that previews the op input; bind the op task's input to the approval's output via $ref so the audit trail is atomic.";

/**
 * Collect every operation ID an agent task's context spec can put on its tool
 * surface: direct tools, operation grants, and the promotable ceiling — a
 * promotable op becomes a live tool via catalog.tool.promote, so validation
 * that skips it validates a narrower surface than the one that runs.
 */
export function collectAgentTaskToolIds(task: WorkflowTask): string[] {
  if (task.type !== 'agent') return [];
  const ctx = task.context;
  const toolSet = new Set<string>(ctx?.tools ?? []);
  if (ctx?.capabilities?.operations) {
    for (const op of ctx.capabilities.operations) {
      toolSet.add(op);
    }
  }
  if (ctx?.capabilities?.promotable?.operations) {
    for (const op of ctx.capabilities.promotable.operations) {
      toolSet.add(op);
    }
  }
  return [...toolSet];
}

/**
 * Returns a teaching error message when any agent task references an
 * op-task-only tool, or `null` when the workflow passes.
 */
export function validateAgentOpTaskOnlyTools(tasks: readonly WorkflowTask[]): string | null {
  for (const task of tasks) {
    if (task.type !== 'agent') continue;
    for (const toolId of collectAgentTaskToolIds(task)) {
      const opDesc = getOperation(toolId);
      if (opDesc?.opTaskOnly === true) {
        return OP_TASK_ONLY_AGENT_TOOL_ERROR.replace('{toolId}', toolId);
      }
    }
  }
  return null;
}

/** Teaching error template — `{opId}` is replaced at validation time. */
export const EVAL_PLANE_TASK_ERROR =
  'Operation {opId} is on the eval measurement plane — golden datasets and batches grade skill runs, ' +
  'so a skill task can never reference an eval.* operation (the subject under measurement must not ' +
  'see the ruler). Remove the reference; eval.* runs from the Helmsman or operator surfaces, outside skill runs.';

/**
 * Plan 269 D7 — no skill task, agent tool surface or operation task, may
 * reference an `eval.*` operation. Returns a teaching error for the first
 * violation, or `null` when the workflow passes.
 */
export function validateSkillEvalPlaneSeparation(tasks: readonly WorkflowTask[]): string | null {
  for (const task of tasks) {
    if (typeof task.operation === 'string' && isEvalPlaneOperation(task.operation)) {
      return EVAL_PLANE_TASK_ERROR.replace('{opId}', task.operation);
    }
    for (const toolId of collectAgentTaskToolIds(task)) {
      if (isEvalPlaneOperation(toolId)) {
        return EVAL_PLANE_TASK_ERROR.replace('{opId}', toolId);
      }
    }
  }
  return null;
}

/** Teaching error template — `{opId}` is replaced at validation time. */
export const PLAN_TASK_ERROR =
  'Operation {opId} writes or reads the space’s plan, which is the Helmsman’s alone — a run may serve a plan ' +
  'node and may never rewrite the plan it serves, so a skill task can never reference a plan.* operation. ' +
  'Remove the reference; what a run needs from its node arrives in its inputs.';

/**
 * Plan 322 D3 — no skill task, agent tool surface or operation task, may
 * reference a `plan.*` operation. Returns a teaching error for the first
 * violation, or `null` when the workflow passes.
 */
export function validateSkillPlanSeparation(tasks: readonly WorkflowTask[]): string | null {
  for (const task of tasks) {
    if (typeof task.operation === 'string' && isPlanOperation(task.operation)) {
      return PLAN_TASK_ERROR.replace('{opId}', task.operation);
    }
    for (const toolId of collectAgentTaskToolIds(task)) {
      if (isPlanOperation(toolId)) {
        return PLAN_TASK_ERROR.replace('{opId}', toolId);
      }
    }
  }
  return null;
}
