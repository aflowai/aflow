import AjvModule from 'ajv';
import type { TaskTargetedInstructions, Workflow, WorkflowTask } from '@aflow/schemas';
import { inferTaskType } from '@aflow/schemas';

// `ajv` ships its constructor as the package default in ESM and as the
// module shape in CJS — mirror the existing pattern in
// `workflowCrud.ts` so behaviour matches across both build outputs.
const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => (data: unknown) => boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
};
let _ajv: InstanceType<typeof AjvCtor> | undefined;
function getAjv(): InstanceType<typeof AjvCtor> {
  if (!_ajv) _ajv = new AjvCtor({ allErrors: true, strict: false });
  return _ajv;
}

// ============================================================================
// First-task selection
// ============================================================================

export type FirstTaskSelectionResult =
  | { ok: true; task: WorkflowTask }
  | {
      ok: false;
      code: 'NO_ROOT_TASK' | 'AMBIGUOUS_ROOT_TASKS';
      /** Operator-facing message ready to surface as `error.message`. */
      message: string;
      /** When ambiguous, the candidate task ids. */
      rootTaskIds?: string[];
    };

export function selectFirstTaskForParentInputs(
  workflow: Pick<Workflow, 'slug' | 'tasks'>,
): FirstTaskSelectionResult {
  const roots = workflow.tasks.filter((t) => !t.dependsOn || t.dependsOn.length === 0);
  if (roots.length === 0) {
    return {
      ok: false,
      code: 'NO_ROOT_TASK',
      message:
        `Workflow "${workflow.slug}" has no task with empty dependsOn[] — cannot identify an entry task to receive parent inputs. ` +
        'This is a workflow-authoring bug; the parent should fall back to passing freeform `instructions` instead of typed `inputs`.',
    };
  }
  if (roots.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_ROOT_TASKS',
      message:
        `Workflow "${workflow.slug}" has ${String(roots.length)} entry tasks (no dependsOn): [${roots
          .map((r) => r.taskId)
          .join(', ')}]. ` +
        'Plan 141 §4.2 v1 routes typed `inputs` to the unique entry task only. ' +
        'Pass freeform `instructions` instead, or pick one entry task path by re-authoring the workflow.',
      rootTaskIds: roots.map((r) => r.taskId),
    };
  }
  return { ok: true, task: roots[0]! };
}

// ============================================================================
// Task-targeted instructions validation
// ============================================================================

export type InstructionTargetsValidationResult =
  | { ok: true }
  | {
      ok: false;
      unknownTaskIds: string[];
      nonAgentTaskIds: string[];
      agentTaskIds: string[];
      /** Teaching message ready to surface as `error.message`. */
      message: string;
    };

/**
 * Instructions are injected into the Runner prompt of AGENT tasks only
 * (`buildDelegateTaskInput`); operation and human tasks never read them. An
 * entry addressed to a non-existent or non-agent taskId would be accepted and
 * then silently never delivered — the run executes undirected. Reject it
 * before the run is created, naming the addressable agent task ids.
 *
 * `context` adapts the teaching message to the call site (run start vs an
 * operator resume) so the stated consequence and retry action stay true.
 */
export function validateInstructionTaskTargets(
  workflow: Pick<Workflow, 'slug' | 'tasks'>,
  instructions: TaskTargetedInstructions,
  context: { consequence: string; retryAction: string } = {
    consequence: 'no run was started',
    retryAction: 'call workflow.run.start again',
  },
): InstructionTargetsValidationResult {
  if (typeof instructions === 'string') return { ok: true };

  const tasksById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const agentTaskIds = workflow.tasks.filter(isAgentTask).map((t) => t.taskId);
  const unknownTaskIds: string[] = [];
  const nonAgentTaskIds: string[] = [];
  for (const taskId of new Set(instructions.map((entry) => entry.taskId))) {
    const task = tasksById.get(taskId);
    if (!task) {
      unknownTaskIds.push(taskId);
    } else if (!isAgentTask(task)) {
      nonAgentTaskIds.push(taskId);
    }
  }
  if (unknownTaskIds.length === 0 && nonAgentTaskIds.length === 0) return { ok: true };

  const remedy =
    agentTaskIds.length > 0
      ? `Address instructions to the agent task id(s) [${agentTaskIds.join(', ')}], or pass a single run-level string. Fix the taskId(s) and ${context.retryAction}.`
      : `Workflow "${workflow.slug}" has no agent tasks, so task-targeted instructions can never be delivered — pass a single run-level string or drop instructions.`;
  const message =
    `Instructions target task id(s) that cannot receive them — ${context.consequence}. ` +
    (unknownTaskIds.length > 0
      ? `[${unknownTaskIds.join(', ')}] do not exist on workflow "${workflow.slug}". `
      : '') +
    (nonAgentTaskIds.length > 0
      ? `[${nonAgentTaskIds.join(', ')}] are operation/human tasks, which never read instructions. `
      : '') +
    remedy;
  return { ok: false, unknownTaskIds, nonAgentTaskIds, agentTaskIds, message };
}

function isAgentTask(task: WorkflowTask): boolean {
  try {
    return inferTaskType(task) === 'agent';
  } catch {
    return false;
  }
}

// ============================================================================
// Per-bindAs validation
// ============================================================================

export interface ParentInputsValidationIssue {
  /** The bindAs name the parent provided (or omitted, for MISSING_BINDAS). */
  bindAs: string;
  /**
   * Stable code so callers can pattern-match.
   *
   *   - `MISSING_BINDAS`   — the contract declares a required `run_input`
   *     binding (Phase 4 review fix: all `run_input` bindings are
   *     required, matching `deriveFirstTaskInputContract`'s `required[]`
   *     list and the resolver's throw-on-missing behaviour) but the
   *     parent did not provide it. Without this check, partial inputs
   *     would silently pass the boundary and the Runner would
   *     `signal_blocked: missing_input` again on the next dispatch.
   *   - `UNKNOWN_BINDAS`   — the parent provided a key the first task
   *     doesn't declare a slot for.
   *   - `WRONG_KIND`       — the bindAs targets a binding that isn't
   *     `run_input` (e.g., an upstream `task_output`).
   *   - `SCHEMA_VIOLATION` — the value didn't match the binding's Ajv
   *     `schema`.
   */
  code: 'MISSING_BINDAS' | 'UNKNOWN_BINDAS' | 'WRONG_KIND' | 'SCHEMA_VIOLATION';
  /** Operator-facing detail, suitable for inclusion in the error message. */
  detail: string;
}

export type ParentInputsValidationResult =
  | { ok: true; validatedInputs: Record<string, unknown> }
  | { ok: false; issues: ParentInputsValidationIssue[]; populatableBindAs: string[] };

/**
 * One populatable run-input slot on the entry task — the `bindAs` the parent
 * keys `inputs` by, whether it was declared via `inputContract.bindings` or via
 * the raw `inputBindings` + workflow `runInputs` contract.
 */
interface EntryRunInputSlot {
  bindAs: string;
  path: string;
  required: boolean;
  /** JSON Schema for the value, when one is declared for this slot. */
  schema?: Record<string, unknown> | undefined;
}

/**
 * The entry task's parent-populatable input surface. A skill declares its run
 * inputs on the task's `inputBindings` (kind `run_input`) and the workflow's
 * `runInputs` (id + required + optional schema); the assembler-only
 * `inputContract.bindings` is the DERIVED form and is preferred when present
 * (it carries a per-binding schema). Deriving from `inputBindings` directly
 * means a skill does not have to hand-author a redundant `inputContract` for
 * its typed input surface to be discovered and enforced.
 */
/**
 * The run-input surface a caller may actually populate on the entry task.
 *
 * Exported because the standing-validity check must ask the same question the
 * runtime asks. A second implementation of "which run inputs are reachable"
 * would disagree with this one — on `path` versus `bindAs`, or on the catch-all
 * — and report a working skill as broken.
 */
export function entryRunInputSlots(
  firstTask: WorkflowTask,
  runInputs: Workflow['runInputs'] | undefined,
): EntryRunInputSlot[] {
  const contractBindings = firstTask.inputContract?.bindings;
  if (contractBindings && Object.keys(contractBindings).length > 0) {
    const slots: EntryRunInputSlot[] = [];
    for (const [bindAs, b] of Object.entries(contractBindings)) {
      if (b.kind !== 'run_input') continue;
      slots.push({
        bindAs,
        path: b.path,
        required: isRunInputRequired(runInputs, b.path),
        schema: b.schema,
      });
    }
    return slots;
  }
  return Object.entries(firstTask.inputBindings ?? {})
    .filter(([, b]) => b.kind === 'run_input')
    .map(([bindAs, b]) => {
      const path = b.kind === 'run_input' ? b.path : bindAs;
      const id = path.split('.')[0] ?? path;
      const schema = (runInputs ?? []).find((r) => r.id === id)?.schema;
      return {
        bindAs,
        path,
        required: isRunInputRequired(runInputs, path),
        ...(schema !== undefined ? { schema } : {}),
      };
    });
}

export function validateParentTaskInputs(
  firstTask: WorkflowTask,
  inputs: Record<string, unknown>,
  runInputs?: Workflow['runInputs'],
): ParentInputsValidationResult {
  const slots = entryRunInputSlots(firstTask, runInputs);
  const contractBindings = firstTask.inputContract?.bindings;
  const hasContract = !!contractBindings && Object.keys(contractBindings).length > 0;

  if (slots.length === 0 && !hasContract) {
    // Catch-all path — no declared run-input surface, accept inputs verbatim.
    return { ok: true, validatedInputs: inputs };
  }

  const slotByBindAs = new Map(slots.map((s) => [s.bindAs, s]));
  const populatableBindAs = slots.map((s) => s.bindAs);

  const issues: ParentInputsValidationIssue[] = [];
  const ajv = getAjv();

  // Pass 1 — required-slot check. A `run_input` binding is required UNLESS the
  // workflow declares the slot optional (`runInputs[].required === false`).
  // Without the required check, a missing REQUIRED slot would resolve to
  // `undefined` at the Runner and close the loop on `signal_blocked:
  // missing_input`; with it, a genuinely optional slot (e.g. fix-mode's
  // prNumber) can be omitted in the common path.
  for (const slot of slots) {
    if (!slot.required) continue;
    if (!Object.prototype.hasOwnProperty.call(inputs, slot.bindAs)) {
      issues.push({
        bindAs: slot.bindAs,
        code: 'MISSING_BINDAS',
        detail:
          `"${slot.bindAs}" is a required input on task "${firstTask.taskId}" but is absent from \`inputs\`. ` +
          'Populate every required key listed in `populatableBindAs`.',
      });
    }
  }

  // Pass 2 — validate the keys the parent did provide. Unknown/wrong-kind checks
  // require a declared binding surface to blame against; the `inputBindings`-only
  // path validates against its own run-input slots (any extra key is unknown).
  const declaredBindingKinds: Record<string, string> = hasContract
    ? Object.fromEntries(Object.entries(contractBindings).map(([k, b]) => [k, b.kind]))
    : Object.fromEntries(
        Object.entries(firstTask.inputBindings ?? {}).map(([k, b]) => [k, b.kind]),
      );

  for (const [bindAs, value] of Object.entries(inputs)) {
    const declaredKind = declaredBindingKinds[bindAs];
    if (declaredKind === undefined) {
      issues.push({
        bindAs,
        code: 'UNKNOWN_BINDAS',
        detail: `"${bindAs}" is not a declared input on task "${firstTask.taskId}".`,
      });
      continue;
    }
    if (!slotByBindAs.has(bindAs)) {
      // The binding exists but isn't `run_input` — the parent can't
      // populate it (system_feedback / task_output / task_summary are
      // platform- or resolver-filled).
      issues.push({
        bindAs,
        code: 'WRONG_KIND',
        detail:
          `"${bindAs}" is a "${declaredKind}" binding on task "${firstTask.taskId}"; only "run_input" bindings can be populated by the parent. ` +
          'Drop this key.',
      });
      continue;
    }

    const schema = slotByBindAs.get(bindAs)?.schema;
    if (schema === undefined) continue;
    const validator = ajv.compile(schema);
    if (!validator(value)) {
      const errs =
        (validator as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
          .errors ?? [];
      const summary = errs
        .slice(0, 3)
        .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'invalid'}`)
        .join('; ');
      issues.push({
        bindAs,
        code: 'SCHEMA_VIOLATION',
        detail: `value failed the binding's JSON Schema: ${summary || 'unknown error'}.`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, populatableBindAs };
  }
  return { ok: true, validatedInputs: inputs };
}

/**
 * A run_input slot is REQUIRED unless the workflow declares it optional
 * (`runInputs[].required === false`) — the single source of truth. An undeclared
 * slot defaults to required (matches `WorkflowRunInputSchema`'s `default(true)`).
 * This is what lets a skill carry an optional run input (e.g. fix-mode's
 * `prNumber`) without forcing every caller to supply it in the common path.
 */
function isRunInputRequired(runInputs: Workflow['runInputs'] | undefined, path: string): boolean {
  const id = path.split('.')[0] ?? path;
  const decl = (runInputs ?? []).find((r) => r.id === id);
  return decl ? decl.required : true;
}

export function deriveFirstTaskInputContract(
  workflow: Pick<Workflow, 'slug' | 'tasks' | 'runInputs'>,
): Record<string, unknown> | null {
  const firstTaskResult = selectFirstTaskForParentInputs(workflow);
  if (!firstTaskResult.ok) return null;
  const slots = entryRunInputSlots(firstTaskResult.task, workflow.runInputs);
  if (slots.length === 0) return null;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const slot of slots) {
    properties[slot.bindAs] = slot.schema ?? {};
    if (slot.required) required.push(slot.bindAs);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Render a validation failure as a single multi-line error message ready
 * for surfacing through `emitStepError`. Keeps the formatting consistent
 * between `workflow.run.start` (Phase 2) and `workflow.run.resume`
 * `provide_input` (Phase 3).
 */
export function renderParentInputsValidationFailure(
  firstTaskId: string,
  issues: ParentInputsValidationIssue[],
  populatableBindAs: string[],
): string {
  const issueLines = issues.map((i) => `  - "${i.bindAs}" (${i.code}): ${i.detail}`);
  const missing = issues.filter((i) => i.code === 'MISSING_BINDAS').map((i) => i.bindAs);
  const header =
    missing.length > 0
      ? `Cannot start: this skill declares required run input(s) [${missing.join(', ')}] that were not provided. ` +
        `Pass each as a structured input (e.g. \`inputs.${missing[0]}\`), not as free-form \`instructions\`.`
      : `Provided \`inputs\` failed validation against task "${firstTaskId}"'s input contract.`;
  const acceptedHint =
    populatableBindAs.length > 0
      ? `Populatable input keys on "${firstTaskId}": [${populatableBindAs.join(', ')}].`
      : `Task "${firstTaskId}" declares no run_input bindings — pass guidance via \`instructions\` instead of typed \`inputs\`.`;
  return `${header}\n${issueLines.join('\n')}\n${acceptedHint}`;
}
