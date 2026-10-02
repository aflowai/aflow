import {
  analyzeInputTemplate,
  describePredicate,
  getOperation,
  inferTaskType,
  isTemplateBindNode,
  jsonSchemaCovers,
  POLL_RESERVED_OUTPUT_KEY,
  predicateExpressions,
  predicateKey,
  readTemplateOperatorNode,
  StepTypeSchema,
  TEMPLATE_BIND_KEY,
  TEMPLATE_CONCAT_KEY,
  TEMPLATE_FIRST_OF_KEY,
  templateContainsSubstitution,
  type TemplateOperatorKey,
  toJsonSchemaSync,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
  type WorkflowStateVariable,
  type WorkflowOutputDeclaration,
} from '@aflow/schemas';
import { parseOutputComparison, parseTaskComparison } from './graph.js';
import { parseOutputPath } from './outputPath.js';
import { resolveSchemaPath } from './outputPathSchema.js';
import { bindingStaticSchema } from './bindingStaticSchema.js';
import { getResumeAjv } from '../resumeAjv.js';

// ============================================================================
// Types
// ============================================================================

export interface GraphValidationError {
  kind:
    | 'cycle'
    | 'missing_dep'
    | 'dangling_when_ref'
    | 'unsupported_when_expression'
    /** A `when` reads an output path the referenced task's output schema does not have. */
    | 'when_output_path_unknown'
    | 'duplicate_task_id'
    | 'reserved_task_id'
    | 'binding_dangling_task_ref'
    | 'binding_not_upstream'
    | 'binding_undeclared_state_var'
    | 'binding_dangling_port_ref'
    | 'promotion_undeclared_state_var'
    | 'promotion_immutable_conflict'
    | 'promotion_multi_writer'
    | 'duplicate_state_var_id'
    /** `workflow.output.primary` is not a declared stateVariables.variableId. */
    | 'output_primary_undeclared_state_var'
    /** `task.operation` is not a registered platform operation. */
    | 'op_unknown'
    /** A required op input has no guaranteed source (no literal, no unconditional binding). */
    | 'op_input_missing_required'
    /** A `task_output` binding feeding an op references a producer with no declared shape for the bound port. */
    | 'op_input_undeclared_producer_shape'
    /** A required op input is bound (no literal fallback) to a `when`-guarded producer the consumer is not guarded in lockstep with. */
    | 'op_input_conditional_absence'
    /** A supplied shape (or literal value) fails `jsonSchemaCovers` of the op field. */
    | 'op_input_incompatible'
    /** §2.5 platform-side undecidability on a required field (exotic op-side construct). */
    | 'op_input_uncheckable'
    | 'op_input_undeclared_field'
    /** `poll` declared on a non-operation task (agent / human). */
    | 'poll_on_non_operation_task'
    /**
     * A `poll.until` expression doesn't parse under the shared grammar —
     * `until` references only THIS task's raw op output via
     * `output.<field> <op> <literal>`, never other tasks.
     */
    | 'unsupported_poll_until_expression'
    /**
     * A polled task's `outputContract.schema` — or any task's
     * `outputProjection` — declares the platform-reserved `_poll` key. The
     * harness stamps it into the output at terminal completion; authors
     * must not claim it.
     */
    | 'reserved_output_field'
    /** `outputProjection` declared on a non-operation task (agent / human). */
    | 'projection_on_non_operation_task'
    /**
     * A projection `path` / `select` doesn't parse under the shared
     * output-path dialect, or `select` is declared without `'json'` in
     * `parse` (select paths into the JSON-parsed value).
     */
    | 'unsupported_projection_path'
    /** A `fromInput` echo names no declared inputBindings entry or literal inputs key. */
    | 'projection_undeclared_input'
    /**
     * The projected field set doesn't satisfy the task's
     * `outputContract.schema`: a schema-required field is not projected
     * (the task output is EXACTLY the projected object), an
     * `onMissing: 'null'` field is not schema-nullable, or
     * `parse: ['number']` lands on a string-typed contract field.
     */
    | 'projection_contract_mismatch'
    /** `inputTemplate` declared on a non-operation task (agent / human). */
    | 'template_on_non_operation_task'
    /**
     * A template node carries the reserved `$bind` key but is not a
     * well-formed bind node (extra keys alongside `$bind`, or a
     * non-string/empty value) — the author almost certainly meant
     * substitution, so it is rejected rather than treated as a literal.
     */
    | 'template_malformed_bind'
    /** A `$bind` names no declared inputBindings entry or literal inputs key. */
    | 'template_unknown_bind'
    | 'template_orphan_binding'
    /** More than one task has no `dependsOn` predecessors (multiple entry points). */
    | 'multiple_root_tasks'
    /**
     * A promotion op (`catalog.tool.promote` / `mcp.tool.promote`) appears in
     * a task's declared tools, operations, or promotable set. Promotion is
     * derived from the grant — declaring `promotable.operations` surfaces
     * `catalog.tool.promote` automatically, bounded to that set — never
     * declared. (Read-only discovery like `catalog.tool.list` stays
     * declarable: it grants awareness, not capability.)
     */
    | 'capability_promotion_op_declared'
    /** A `promotable.operations` entry is not a registered, agent-callable platform operation. */
    | 'promotable_op_invalid';
  /** Task IDs involved in the error. */
  taskIds: string[];
  field?: string;
  /** Operator-readable description. */
  detail: string;
}

// ============================================================================
// Reserved task IDs
// ============================================================================

/**
 * Task IDs reserved for internal scheduler use. User tasks must not use these.
 */
const RESERVED_TASK_IDS = new Set([
  '__bootstrap',
  '__join',
  '__start',
  '__end',
  '__root',
  '__parallel_join',
]);

// ============================================================================
// When-expression reference extraction
// ============================================================================

export function validateWhenExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (parseTaskComparison(trimmed)) {
    return null;
  }
  return (
    `Unsupported when expression: "${trimmed}". Supported single comparisons: ` +
    `tasks.<id>.status ==|!= '<value>', ` +
    `tasks.<id>.output.<path> >|>=|<|<=|==|!= <number>, ` +
    `tasks.<id>.output.<path> ==|!= '<string>', ` +
    `tasks.<id>.output.<path> ==|!= true|false (booleans are unquoted). ` +
    `Paths are dot-separated keys with [n] array indexing; ` +
    `combine comparisons with anyOf/allOf, not && or ||.`
  );
}

/**
 * Extract the task ID referenced by a single `when` comparison via the
 * shared parser (LHS-only — quoted string literals on the RHS can never
 * produce a false positive).
 */
export function extractWhenTaskRefs(expression: string): string[] {
  const parsed = parseTaskComparison(expression);
  return parsed ? [parsed.taskId] : [];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a workflow task graph for structural correctness.
 *
 * Returns an empty array if the graph is valid. Returns one or more
 * `GraphValidationError` entries otherwise. All errors are collected
 * (not short-circuited) so operators see the full picture.
 *
 * @param stateVariables - Optional workflow-level state variable declarations
 *   (104j §6.1). When provided, validates inputBinding and promoteOutputs
 *   references against declared state vars.
 * @param output - Optional workflow.output declaration; validates `primary`
 *   against declared state variables.
 */
export function validateWorkflowGraph(
  tasks: WorkflowTask[],
  stateVariables?: WorkflowStateVariable[],
  output?: WorkflowOutputDeclaration,
): GraphValidationError[] {
  const errors: GraphValidationError[] = [];

  // 1. Duplicate task IDs
  const idCounts = new Map<string, number>();
  for (const task of tasks) {
    idCounts.set(task.taskId, (idCounts.get(task.taskId) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({
        kind: 'duplicate_task_id',
        taskIds: [id],
        detail: `Task ID "${id}" appears ${String(count)} times. Task IDs must be unique.`,
      });
    }
  }

  // 2. Reserved task IDs
  for (const task of tasks) {
    if (RESERVED_TASK_IDS.has(task.taskId)) {
      errors.push({
        kind: 'reserved_task_id',
        taskIds: [task.taskId],
        detail: `Task ID "${task.taskId}" is reserved for internal scheduler use.`,
      });
    }
  }

  // Build lookup for remaining checks
  const taskIdSet = new Set(tasks.map((t) => t.taskId));

  // 3. Missing dependency references (dependsOn + approves on human tasks)
  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      if (!taskIdSet.has(depId)) {
        errors.push({
          kind: 'missing_dep',
          taskIds: [task.taskId, depId],
          detail: `Task "${task.taskId}" depends on "${depId}" which does not exist in the task list.`,
        });
      }
    }
    // approves[] on assembled human tasks must also reference existing tasks.
    if (task.type === 'human') {
      for (const approvedId of (task as { approves?: string[] }).approves ?? []) {
        if (!taskIdSet.has(approvedId)) {
          errors.push({
            kind: 'missing_dep',
            taskIds: [task.taskId, approvedId],
            detail: `Task "${task.taskId}" approves "${approvedId}" which does not exist in the task list.`,
          });
        }
      }
    }
  }

  for (const task of tasks) {
    if (!task.when) continue;

    for (const expression of predicateExpressions(task.when)) {
      // 4a. Check expression format is supported
      const formatError = validateWhenExpression(expression);
      if (formatError) {
        errors.push({
          kind: 'unsupported_when_expression',
          taskIds: [task.taskId],
          detail: `Task "${task.taskId}": ${formatError}`,
        });
        continue; // Skip ref checks for unsupported expressions
      }

      // 4b. Dangling when references
      for (const refId of extractWhenTaskRefs(expression)) {
        if (!taskIdSet.has(refId)) {
          errors.push({
            kind: 'dangling_when_ref',
            taskIds: [task.taskId, refId],
            detail: `Task "${task.taskId}" has a when expression referencing "${refId}" which does not exist in the task list.`,
          });
        }
      }
    }
  }

  validateWhenOutputPaths(tasks, errors);

  validatePollPolicies(tasks, errors);

  validateCapabilityDeclarations(tasks, errors);

  validateOutputProjections(tasks, errors);

  validateInputTemplates(tasks, errors);

  // 5. Self-dependency (special case of cycle, caught early)
  for (const task of tasks) {
    if (task.dependsOn?.includes(task.taskId)) {
      errors.push({
        kind: 'cycle',
        taskIds: [task.taskId],
        detail: `Task "${task.taskId}" depends on itself.`,
      });
    }
  }

  // 6. Cycle detection (DFS-based topological sort)
  // Only run if no duplicate IDs (otherwise adjacency map is ambiguous)
  if (!errors.some((e) => e.kind === 'duplicate_task_id')) {
    const cycleParticipants = detectCycles(tasks);
    if (cycleParticipants.length > 0) {
      errors.push({
        kind: 'cycle',
        taskIds: cycleParticipants,
        detail: `Dependency cycle detected involving tasks: ${cycleParticipants.join(', ')}.`,
      });
    }
  }

  // 7. Multiple root tasks — exactly one task may have no predecessors.
  //    Skip when cycles or duplicate IDs are already present (those make
  //    the root count undefined). A human task's `approves` confers
  //    predecessors too (assembleWorkflow folds it into dependsOn, but credit
  //    it directly so a direct-authored task with approves-but-no-dependsOn is
  //    not false-flagged).
  if (!errors.some((e) => e.kind === 'cycle' || e.kind === 'duplicate_task_id')) {
    const rootTaskIds = tasks
      .filter((t) => {
        const hasDep = (t.dependsOn ?? []).length > 0;
        const hasApproves =
          t.type === 'human' && ((t as { approves?: string[] }).approves ?? []).length > 0;
        return !hasDep && !hasApproves;
      })
      .map((t) => t.taskId);
    if (rootTaskIds.length > 1) {
      errors.push({
        kind: 'multiple_root_tasks',
        taskIds: rootTaskIds,
        detail:
          `Tasks ${rootTaskIds.map((id) => `"${id}"`).join(', ')} are all root tasks (no dependsOn). ` +
          `A workflow must have exactly one starting task. For parallel execution after the start, ` +
          `add a single setup/initialize task and fan out from it using dependsOn.`,
      });
    }
  }

  // 8. State variable declarations (104j §6.1)
  const stateVarIds = new Set<string>();
  const immutableStateVarIds = new Set<string>();
  const alternativeWriterVarIds = new Set<string>();
  if (stateVariables && stateVariables.length > 0) {
    const stateVarCounts = new Map<string, number>();
    for (const sv of stateVariables) {
      stateVarCounts.set(sv.variableId, (stateVarCounts.get(sv.variableId) ?? 0) + 1);
      stateVarIds.add(sv.variableId);
      if (sv.immutable) immutableStateVarIds.add(sv.variableId);
      if (sv.writers === 'alternatives') alternativeWriterVarIds.add(sv.variableId);
    }
    for (const [id, count] of stateVarCounts) {
      if (count > 1) {
        errors.push({
          kind: 'duplicate_state_var_id',
          taskIds: [],
          detail: `State variable ID "${id}" appears ${String(count)} times. Variable IDs must be unique.`,
        });
      }
    }
  }

  // 8. Input binding validation (104j §6.2 / §6.8)
  // Build transitive upstream closure per task (for upstream-only ref checks)
  const upstreamClosure = buildUpstreamClosure(tasks);
  const taskById = new Map(tasks.map((t) => [t.taskId, t] as const));

  for (const task of tasks) {
    if (!task.inputBindings) continue;

    for (const [fieldName, binding] of Object.entries(task.inputBindings)) {
      if (binding.kind === 'task_output' || binding.kind === 'task_summary') {
        // 8a. Referenced task must exist
        if (!taskIdSet.has(binding.taskId)) {
          errors.push({
            kind: 'binding_dangling_task_ref',
            taskIds: [task.taskId, binding.taskId],
            field: fieldName,
            detail: `Task "${task.taskId}" input "${fieldName}" binds to task "${binding.taskId}" which does not exist.`,
          });
          continue; // No point checking upstream / port-key without a producer.
        }

        // 8b. Referenced task must be upstream (in transitive dependsOn closure)
        const upstream = upstreamClosure.get(task.taskId);
        if (upstream && !upstream.has(binding.taskId)) {
          errors.push({
            kind: 'binding_not_upstream',
            taskIds: [task.taskId, binding.taskId],
            field: fieldName,
            detail: `Task "${task.taskId}" input "${fieldName}" binds to task "${binding.taskId}" which is not in its upstream dependency closure. Add it to dependsOn (directly or transitively).`,
          });
        }

        if (binding.kind === 'task_output' && binding.path) {
          const producer = taskById.get(binding.taskId);
          const ports = producer?.produces ?? [];
          if (ports.length > 0 && !ports.some((p) => p.key === binding.path)) {
            errors.push({
              kind: 'binding_dangling_port_ref',
              taskIds: [task.taskId, binding.taskId],
              field: fieldName,
              detail:
                `Task "${task.taskId}" input "${fieldName}" binds to "${binding.taskId}".${binding.path}, ` +
                `but no produces[] port with key "${binding.path}" is declared on the producer. ` +
                `Declared ports: [${ports.map((p) => p.key).join(', ')}].`,
            });
          }
        }
      }
      // run_input / system_feedback bindings don't need task/state validation
    }
  }

  validateOpTaskInputContracts(tasks, taskById, errors);

  // 9. Output promotion validation (104j §6.3 / §6.8)
  // Track which state vars are written to by which tasks (for multi-writer detection)
  const stateWriters = new Map<string, string[]>();

  for (const task of tasks) {
    if (!task.promoteOutputs) continue;

    for (const promo of task.promoteOutputs) {
      // 9a. Target state variable must be declared (empty/absent declarations = no vars available)
      if (!stateVarIds.has(promo.toState)) {
        errors.push({
          kind: 'promotion_undeclared_state_var',
          taskIds: [task.taskId],
          detail: `Task "${task.taskId}" promotes to state variable "${promo.toState}" which is not declared in stateVariables.`,
        });
        continue;
      }

      // Track writer for multi-writer / immutable checks
      const writers = stateWriters.get(promo.toState) ?? [];
      if (!writers.includes(task.taskId)) {
        writers.push(task.taskId);
      }
      stateWriters.set(promo.toState, writers);
    }
  }

  // 9b. Immutable state vars may have at most one writer
  for (const [varId, writers] of stateWriters) {
    if (immutableStateVarIds.has(varId) && writers.length > 1) {
      errors.push({
        kind: 'promotion_immutable_conflict',
        taskIds: writers,
        detail: `Immutable state variable "${varId}" has multiple writers: ${writers.join(', ')}. Immutable variables may only be written once.`,
      });
    }
  }

  // 9c. Multi-writer promotion only where the variable declares its writers
  // alternatives (no merge strategy exists — invariant §6.8 rule 5)
  for (const [varId, writers] of stateWriters) {
    if (
      writers.length > 1 &&
      !immutableStateVarIds.has(varId) &&
      !alternativeWriterVarIds.has(varId)
    ) {
      errors.push({
        kind: 'promotion_multi_writer',
        taskIds: writers,
        detail: `State variable "${varId}" has multiple writers: ${writers.join(', ')}. Declare it \`writers: 'alternatives'\` when the writers are branches a run takes one of, or use separate variables.`,
      });
    }
  }

  // 10. output.primary must reference a declared state variable
  if (output?.primary && !stateVarIds.has(output.primary)) {
    errors.push({
      kind: 'output_primary_undeclared_state_var',
      taskIds: [],
      detail: `workflow.output.primary "${output.primary}" is not declared in stateVariables.`,
    });
  }

  return errors;
}

// ============================================================================

/**
 * The schema a task's output is known to have, when one is known.
 *
 * A projected operation task outputs its projection, which its output contract
 * describes; an unprojected one outputs what its operation returns. Any other
 * task is described by its output contract when it declares one.
 */
function taskOutputSchema(task: WorkflowTask): Record<string, unknown> | undefined {
  if (isOperationTask(task) && task.outputProjection === undefined) {
    const outputZod = task.operation ? getOperation(task.operation)?.outputZod : undefined;
    return outputZod ? (toJsonSchemaSync(outputZod) as Record<string, unknown>) : undefined;
  }
  return task.outputContract?.schema;
}

/**
 * A `when` that reads a path its producer never emits skips its task on every
 * run, and nothing reports it: a missing reference under `onMissingRef: 'skip'`
 * looks exactly like a branch not taken. Refusing it here turns a typo into a
 * diagnostic that names the fields that do exist.
 */
function validateWhenOutputPaths(tasks: WorkflowTask[], errors: GraphValidationError[]): void {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const task of tasks) {
    if (!task.when) continue;
    for (const expression of predicateExpressions(task.when)) {
      const parsed = parseTaskComparison(expression.trim());
      if (parsed?.subject.kind !== 'output') continue;
      const producer = byId.get(parsed.taskId);
      if (!producer) continue;
      const segments = parseOutputPath(parsed.subject.field);
      if (!segments) continue;
      const head = segments[0];
      if (head?.kind === 'key' && head.key === POLL_RESERVED_OUTPUT_KEY) continue;
      const schema = taskOutputSchema(producer);
      if (!schema) continue;
      const result = resolveSchemaPath(schema, segments);
      if (result.kind !== 'missing') continue;
      errors.push({
        kind: 'when_output_path_unknown',
        taskIds: [task.taskId, producer.taskId],
        field: parsed.subject.field,
        detail:
          `Task "${task.taskId}" reads tasks.${producer.taskId}.output.${parsed.subject.field}, ` +
          `but "${producer.taskId}"'s output has no ${result.at}` +
          (result.available.length > 0
            ? ` — the fields there are: ${result.available.join(', ')}.`
            : '.'),
      });
    }
  }
}

function isOperationTask(task: WorkflowTask): boolean {
  try {
    return inferTaskType(task) === 'operation';
  } catch {
    return false;
  }
}

/**
 * Platform operation namespaces (step types). An operation task whose
 * `operation` first segment is one of these is a PLATFORM op — if the
 * registry doesn't know it, it's a typo (`op_unknown`). An operation whose
 * first segment is NOT a platform step type is an external API/MCP-mesh tool
 * (e.g. `stripe.charges.create`) resolved via integration definitions the
 * validator can't load — existence there is Phase 3's per-space concern, and
 * its input contract can't be checked statically, so we skip it.
 */
const PLATFORM_STEP_TYPES = new Set<string>(StepTypeSchema.options);

const HARNESS_ENVELOPE_INPUT_KEYS = new Set<string>(['workflowExecution']);

/**
 * Join each operation task's bound/literal inputs to the consumer op's
 * `inputZod`. Pushes `GraphValidationError`s into `errors`.
 *
 * Mirrors the runtime precedence (`resolveTaskInputs`): a binding that
 * resolves present overwrites the literal; a binding that resolves ABSENT
 * leaves the literal as fallback. The check therefore validates BOTH a present
 * binding and the literal-when-absent for any field that has both.
 */
/**
 * Ops that MUTATE an agent's tool surface. They are DERIVED, never declared:
 * declaring `promotable.operations` surfaces `catalog.tool.promote`
 * automatically, bounded to exactly that set. A hand-declared promotion op
 * would be a self-granted escalation path. Read-only discovery
 * (`catalog.tool.search`/`list`, `mcp.tool.discover`) stays declarable — it
 * grants awareness, not capability, and is scope-clamped at read time.
 */
const PROMOTION_OPERATION_IDS = new Set(['catalog.tool.promote', 'mcp.tool.promote']);

function validateCapabilityDeclarations(
  tasks: readonly WorkflowTask[],
  errors: GraphValidationError[],
): void {
  for (const task of tasks) {
    const ctx = task.context;
    if (!ctx) continue;

    const declared: Array<{ field: string; ops: readonly string[] }> = [
      { field: 'context.tools', ops: ctx.tools ?? [] },
      { field: 'context.capabilities.operations', ops: ctx.capabilities?.operations ?? [] },
      {
        field: 'context.capabilities.promotable.operations',
        ops: ctx.capabilities?.promotable?.operations ?? [],
      },
    ];

    for (const { field, ops } of declared) {
      for (const opId of ops) {
        if (PROMOTION_OPERATION_IDS.has(opId)) {
          errors.push({
            kind: 'capability_promotion_op_declared',
            taskIds: [task.taskId],
            field,
            detail:
              `Task "${task.taskId}" declares promotion op "${opId}" in ${field}. ` +
              'Promotion ops are derived, never declared: to let this task promote ' +
              'operations at runtime, list them in context.capabilities.promotable.operations ' +
              '— catalog.tool.promote is surfaced automatically and bounded to that set.',
          });
        }
      }
    }

    for (const [idx, opId] of (ctx.capabilities?.promotable?.operations ?? []).entries()) {
      if (PROMOTION_OPERATION_IDS.has(opId)) continue; // already reported above
      const op = getOperation(opId);
      if (!op || op.internal || !op.agentTool) {
        errors.push({
          kind: 'promotable_op_invalid',
          taskIds: [task.taskId],
          field: `context.capabilities.promotable.operations[${String(idx)}]`,
          detail:
            `Task "${task.taskId}" lists "${opId}" as promotable, but it is ` +
            (op
              ? 'not agent-callable (internal or agentTool: false).'
              : 'not a registered platform operation.') +
            ' Promotable entries must be operations an agent could hold as tools.',
        });
      }
    }
  }
}

function validateOpTaskInputContracts(
  tasks: WorkflowTask[],
  taskById: Map<string, WorkflowTask>,
  errors: GraphValidationError[],
): void {
  for (const task of tasks) {
    if (!isOperationTask(task) || !task.operation) continue;

    const op = getOperation(task.operation);
    if (!op) {
      const stepType = task.operation.split('.')[0] ?? '';
      if (PLATFORM_STEP_TYPES.has(stepType)) {
        errors.push({
          kind: 'op_unknown',
          taskIds: [task.taskId],
          detail: `Operation task "${task.taskId}" calls "${task.operation}", which is not a registered platform operation.`,
        });
      }
      // External API/MCP-mesh operation (non-platform namespace) — not
      // statically resolvable here; existence/contract are validated via
      // integration definitions (Phase 3). Skip.
      continue;
    }
    if (op.skipInputValidation) continue;

    const opInput = toJsonSchemaSync(op.inputZod) as Record<string, unknown>;

    if (task.inputTemplate !== undefined) {
      validateTemplateOpInput(task, task.inputTemplate, opInput, taskById, errors);
      continue;
    }

    const required = stringArrayOf(opInput['required']);
    const props = recordOf(opInput['properties']);
    const literals = task.inputs ?? {};
    const bindings = task.inputBindings ?? {};

    // (1) PRESENCE — every required op field needs a guaranteed source.
    for (const field of required) {
      const hasLiteral = Object.prototype.hasOwnProperty.call(literals, field);
      const binding = bindings[field];
      if (!hasLiteral && !binding) {
        errors.push({
          kind: 'op_input_missing_required',
          taskIds: [task.taskId],
          field,
          detail: `Operation task "${task.taskId}" is missing required input "${field}" for "${task.operation}". Provide a literal in inputs or an inputBindings entry.`,
        });
        continue;
      }
      // SOUND conditional-absence guard (review High-4): a `when`-guarded
      // producer may skip; the consumer is only safe if it skips in LOCKSTEP
      if (binding?.kind === 'task_output' && !hasLiteral) {
        const producer = taskById.get(binding.taskId);
        if (
          producer?.when &&
          (task.when === undefined || predicateKey(task.when) !== predicateKey(producer.when))
        ) {
          errors.push({
            kind: 'op_input_conditional_absence',
            taskIds: [task.taskId, binding.taskId],
            field,
            detail:
              `Operation task "${task.taskId}" requires input "${field}" bound from "${binding.taskId}", ` +
              `which is conditional (when: "${describePredicate(producer.when)}") and may not run. ` +
              `Add a literal fallback in inputs, guard this task with the SAME when predicate, or make the input optional.`,
          });
        }
      }
    }

    // (2) TYPE — for every op-declared field, check each runtime source.
    for (const [field, opFieldRaw] of Object.entries(props)) {
      if (!isRecord(opFieldRaw)) continue;
      const opField = opFieldRaw;
      const binding = bindings[field];
      if (binding) {
        const producer = binding.kind === 'task_output' ? taskById.get(binding.taskId) : undefined;
        const supplied = bindingStaticSchema(binding, producer);
        if (supplied.status === 'undeclared_producer') {
          errors.push({
            kind: 'op_input_undeclared_producer_shape',
            taskIds: [task.taskId, ...(producer ? [producer.taskId] : [])],
            field,
            detail:
              `Operation task "${task.taskId}" input "${field}" binds to ${describeBinding(binding)}, ` +
              `but that producer declares no output shape (produces[] port or outputContract.schema) for it. ` +
              `Declare the producer's output shape so the contract is checkable.`,
          });
        } else if (supplied.status === 'known') {
          const r = jsonSchemaCovers(supplied.schema, opField);
          if (r.uncheckable) {
            errors.push({
              kind: 'op_input_uncheckable',
              taskIds: [task.taskId],
              field,
              detail: `Operation task "${task.taskId}" input "${field}" for "${task.operation}" uses an op-side construct that cannot be statically checked${r.gap ? ` (${r.gap})` : ''}. Flagged as a platform follow-up.`,
            });
          } else if (!r.covered) {
            errors.push({
              kind: 'op_input_incompatible',
              taskIds: [task.taskId, ...(producer ? [producer.taskId] : [])],
              field,
              detail:
                `Operation task "${task.taskId}" input "${field}" (from ${describeBinding(binding)}) ` +
                `is incompatible with "${task.operation}": ${r.gap ?? 'shape mismatch'}. ` +
                `The producer's declared output must satisfy every field the operation requires.`,
            });
          }
        }
        // supplied.status === 'runtime_untyped' → presence-only, type-unchecked.
      }
      if (Object.prototype.hasOwnProperty.call(literals, field)) {
        const literalError = validateLiteralAgainstSchema(opField, literals[field]);
        if (literalError) {
          errors.push({
            kind: 'op_input_incompatible',
            taskIds: [task.taskId],
            field,
            detail: `Operation task "${task.taskId}" input "${field}" (literal) is incompatible with "${task.operation}": ${literalError}.`,
          });
        }
      }
    }

    // (3) UNDECLARED — a bound/literal field the op does NOT declare. Op inputs
    //     are closed (`additionalProperties:false`), so such a field is silently
    //     rejected at runtime. Symmetric with (1): coverage catches op fields
    //     that became REQUIRED; this catches bindings/literals to fields the op
    if (opInput['additionalProperties'] === false) {
      const supplied = new Set<string>([...Object.keys(literals), ...Object.keys(bindings)]);
      for (const field of supplied) {
        if (Object.prototype.hasOwnProperty.call(props, field)) continue;
        if (HARNESS_ENVELOPE_INPUT_KEYS.has(field)) continue;
        errors.push({
          kind: 'op_input_undeclared_field',
          taskIds: [task.taskId],
          field,
          detail:
            `Operation task "${task.taskId}" supplies input "${field}", which "${task.operation}" does not declare ` +
            `(the operation input is closed: additionalProperties:false), so it is rejected at runtime. ` +
            `Remove it, or correct the name to one of: ${Object.keys(props).sort().join(', ') || '(none)'}.`,
        });
      }
    }
  }
}

// ============================================================================

/**
 * Graph rules for the op-task `poll` policy:
 *   1. `poll` is only legal on `type: 'operation'` tasks (the schema also
 *      rejects this at parse time; the graph rule covers unparsed /
 *      materialized inputs so validity stays recompute-at-read).
 *   2. Every `poll.until` expression must parse under the shared grammar
 *      and reference only THIS task's raw op output (`output.<field>`).
 *   3. `_poll` is platform-reserved: a polled task's `outputContract.schema`
 *      must not declare it (the harness stamps it at terminal completion).
 */
function validatePollPolicies(tasks: WorkflowTask[], errors: GraphValidationError[]): void {
  for (const task of tasks) {
    if (!task.poll) continue;

    if (!isOperationTask(task)) {
      errors.push({
        kind: 'poll_on_non_operation_task',
        taskIds: [task.taskId],
        detail: `Task "${task.taskId}" declares poll but is not an operation task. Poll is harness re-dispatch policy for operations only — agent tasks loop via their own judgment.`,
      });
    }

    for (const expression of predicateExpressions(task.poll.until)) {
      if (!parseOutputComparison(expression)) {
        errors.push({
          kind: 'unsupported_poll_until_expression',
          taskIds: [task.taskId],
          detail:
            `Task "${task.taskId}": unsupported poll.until expression "${expression.trim()}". ` +
            `until references only this task's raw op output as a single comparison: ` +
            `output.<field> ==|!= <string|number|boolean literal>, or output.<field> >|>=|<|<= <number>. ` +
            `Other tasks' outputs are out of scope — use when for cross-task conditions.`,
        });
      }
    }

    const schema = task.outputContract?.schema;
    if (schema) {
      const props = recordOf(schema['properties']);
      const required = stringArrayOf(schema['required']);
      if (
        Object.prototype.hasOwnProperty.call(props, POLL_RESERVED_OUTPUT_KEY) ||
        required.includes(POLL_RESERVED_OUTPUT_KEY)
      ) {
        errors.push({
          kind: 'reserved_output_field',
          taskIds: [task.taskId],
          field: POLL_RESERVED_OUTPUT_KEY,
          detail:
            `Task "${task.taskId}" declares "${POLL_RESERVED_OUTPUT_KEY}" in its outputContract.schema, ` +
            `but it is platform-reserved on polled tasks — the harness stamps ` +
            `{ cycles, exhausted, conditionMet } into the task output at terminal completion. Remove the declaration.`,
        });
      }
    }
  }
}

// ============================================================================

/**
 * Graph rules for the op-task `outputProjection`:
 *   1. Only legal on `type: 'operation'` tasks (the schema also rejects at
 *      parse time; the graph rule keeps validity recompute-at-read).
 *   2. `_poll` is platform-reserved — a projection must not declare it.
 *   3. Every `path` / `select` must parse under the shared output-path
 *      dialect; `select` requires `'json'` in `parse`.
 *   4. `fromInput` must name a declared inputBindings entry or a literal
 *      inputs key.
 *   5. Contract coherence against `outputContract.schema` (the task output
 *      is EXACTLY the projected object): required ⊆ projected;
 *      `onMissing: 'null'` fields must be schema-nullable; `parse:
 *      ['number']` on a string-typed contract field is a mismatch.
 */
function validateOutputProjections(tasks: WorkflowTask[], errors: GraphValidationError[]): void {
  for (const task of tasks) {
    const projection = task.outputProjection;
    if (!projection) continue;

    if (!isOperationTask(task)) {
      errors.push({
        kind: 'projection_on_non_operation_task',
        taskIds: [task.taskId],
        detail: `Task "${task.taskId}" declares outputProjection but is not an operation task. Projection is the harness transform between op output and task output — agent tasks shape their own outputs via submit_output.`,
      });
    }

    const schema = task.outputContract?.schema;
    const props = schema ? recordOf(schema['properties']) : {};
    const required = schema ? stringArrayOf(schema['required']) : [];
    const declaredInputs =
      task.inputTemplate !== undefined
        ? new Set<string>(Object.keys(task.inputTemplate))
        : new Set<string>([
            ...Object.keys(task.inputBindings ?? {}),
            ...Object.keys(task.inputs ?? {}),
          ]);

    for (const [field, spec] of Object.entries(projection)) {
      if (field === POLL_RESERVED_OUTPUT_KEY) {
        errors.push({
          kind: 'reserved_output_field',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projects "${POLL_RESERVED_OUTPUT_KEY}", which is platform-reserved — ` +
            `the harness stamps poll metadata into the task output at terminal completion. Remove the field.`,
        });
        continue;
      }

      if ('fromInput' in spec) {
        if (!declaredInputs.has(spec.fromInput)) {
          errors.push({
            kind: 'projection_undeclared_input',
            taskIds: [task.taskId],
            field,
            detail:
              `Task "${task.taskId}" projection field "${field}" echoes fromInput "${spec.fromInput}", ` +
              (task.inputTemplate !== undefined
                ? `which names no top-level inputTemplate key (with a template, the resolved op input is exactly the substituted template). `
                : `which names no declared inputBindings entry or literal inputs key. `) +
              `Declared: [${[...declaredInputs].sort().join(', ') || '(none)'}].`,
          });
        }
        continue;
      }

      if (!parseOutputPath(spec.path)) {
        errors.push({
          kind: 'unsupported_projection_path',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projection field "${field}" has an invalid path "${spec.path}". ` +
            `Paths are dot-separated keys with [n] array indexing, e.g. 'content[0].text'.`,
        });
      }
      if (spec.select !== undefined && !parseOutputPath(spec.select)) {
        errors.push({
          kind: 'unsupported_projection_path',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projection field "${field}" has an invalid select "${spec.select}". ` +
            `Select paths use the same dialect as path.`,
        });
      }
      const parse = spec.parse ?? [];
      if (spec.select !== undefined && !parse.includes('json')) {
        errors.push({
          kind: 'unsupported_projection_path',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projection field "${field}" declares select without 'json' in parse — ` +
            `select paths into the JSON-parsed value, not the raw string.`,
        });
      }

      // Contract coherence per projected field.
      const propRaw = props[field];
      const prop = isRecord(propRaw) ? propRaw : undefined;
      if (spec.onMissing === 'null' && prop && !schemaAcceptsNull(prop)) {
        errors.push({
          kind: 'projection_contract_mismatch',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projection field "${field}" uses onMissing: 'null', but the ` +
            `outputContract.schema types it non-nullable. A legitimately-absent terminal value would ` +
            `fail the output-validation invariant — type the field nullable or use onMissing: 'error'.`,
        });
      }
      if (parse.includes('number') && prop && schemaTypeIs(prop, 'string')) {
        errors.push({
          kind: 'projection_contract_mismatch',
          taskIds: [task.taskId],
          field,
          detail:
            `Task "${task.taskId}" projection field "${field}" applies parse: ['number'], but the ` +
            `outputContract.schema types it as string. The projected number would fail the output ` +
            `validation invariant — drop the parse step or retype the contract field.`,
        });
      }
    }

    // Required ⊆ projected — the task output is EXACTLY the projected object.
    for (const requiredField of required) {
      if (!Object.prototype.hasOwnProperty.call(projection, requiredField)) {
        errors.push({
          kind: 'projection_contract_mismatch',
          taskIds: [task.taskId],
          field: requiredField,
          detail:
            `Task "${task.taskId}" outputContract.schema requires "${requiredField}", but the ` +
            `outputProjection does not produce it — with a projection the task output is exactly ` +
            `the projected object. Add the field to the projection or drop it from required.`,
        });
      }
    }
  }
}

// ============================================================================

/**
 * Structural graph rules for the op-task `inputTemplate`:
 *   1. Only legal on `type: 'operation'` tasks (the schema also rejects at
 *      parse time; the graph rule keeps validity recompute-at-read).
 *   2. Every bind node must be well-formed (`{ "$bind": "<name>" }` exactly).
 *   3. Every `$bind` names a declared inputBindings entry or literal inputs
 *      key.
 *   4. Every declared inputBindings entry is consumed by some `$bind` —
 *      with a template the op input is EXACTLY the substituted template, so
 *      an unreferenced binding is dead (orphan diagnostic). Literal `inputs`
 *      keys are reference sugar, not contracts — unreferenced literals are
 *      not flagged.
 *
 * The op-contract dimension (template shape vs the op's `inputZod`) lives in
 * `validateOpTaskInputContracts` — it needs the registry join.
 */
function validateInputTemplates(tasks: WorkflowTask[], errors: GraphValidationError[]): void {
  for (const task of tasks) {
    const template = task.inputTemplate;
    if (template === undefined) continue;

    if (!isOperationTask(task)) {
      errors.push({
        kind: 'template_on_non_operation_task',
        taskIds: [task.taskId],
        detail: `Task "${task.taskId}" declares inputTemplate but is not an operation task. The template is the harness-substituted op input — agent tasks consume typed inputs via the TASK INPUTS channel and human tasks take no op input.`,
      });
    }

    const analysis = analyzeInputTemplate(template);
    for (const malformed of analysis.malformed) {
      errors.push({
        kind: 'template_malformed_bind',
        taskIds: [task.taskId],
        ...(malformed.path ? { field: malformed.path } : {}),
        detail:
          `Task "${task.taskId}" inputTemplate node at "${malformed.path || '(root)'}" is malformed: ` +
          `${malformed.reason}.`,
      });
    }

    const declared = new Set<string>([
      ...Object.keys(task.inputBindings ?? {}),
      ...Object.keys(task.inputs ?? {}),
    ]);
    for (const bind of analysis.binds) {
      if (!declared.has(bind.bindAs)) {
        errors.push({
          kind: 'template_unknown_bind',
          taskIds: [task.taskId],
          ...(bind.path ? { field: bind.path } : {}),
          detail:
            `Task "${task.taskId}" inputTemplate "${TEMPLATE_BIND_KEY}": "${bind.bindAs}" at "${bind.path || '(root)'}" ` +
            `names no declared inputBindings entry or literal inputs key. ` +
            `Declared: [${[...declared].sort().join(', ') || '(none)'}].`,
        });
      }
    }

    const consumed = new Set(analysis.binds.map((b) => b.bindAs));
    for (const bindAs of Object.keys(task.inputBindings ?? {})) {
      if (!consumed.has(bindAs)) {
        errors.push({
          kind: 'template_orphan_binding',
          taskIds: [task.taskId],
          field: bindAs,
          detail:
            `Task "${task.taskId}" declares inputBindings["${bindAs}"] but the inputTemplate never consumes it ` +
            `via "${TEMPLATE_BIND_KEY}" — with a template the op input is exactly the substituted template, so the ` +
            `binding resolves and is silently discarded. Reference it in the template or remove the binding.`,
        });
      }
    }
  }
}

function validateTemplateOpInput(
  task: WorkflowTask,
  template: Record<string, unknown>,
  opInputSchema: Record<string, unknown>,
  taskById: Map<string, WorkflowTask>,
  errors: GraphValidationError[],
): void {
  const bindings = task.inputBindings ?? {};

  const joinField = (path: string, key: string): string => (path ? `${path}.${key}` : key);

  const checkNode = (node: unknown, schemaNode: Record<string, unknown>, path: string): void => {
    // Bind node (well-formed or attempted) — malformed nodes are owned by
    // `validateInputTemplates` (template_malformed_bind); skip here.
    if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, TEMPLATE_BIND_KEY)) {
      if (!isTemplateBindNode(node)) return;
      const binding = bindings[node[TEMPLATE_BIND_KEY]];
      // A `$bind` to a literal inputs key (or an unknown name — flagged by
      // the structural rule) has no static schema to check — skip cleanly.
      if (!binding) return;
      const producer = binding.kind === 'task_output' ? taskById.get(binding.taskId) : undefined;
      const supplied = bindingStaticSchema(binding, producer);
      if (supplied.status !== 'known') return; // best-effort: skip cleanly.
      const r = jsonSchemaCovers(supplied.schema, schemaNode);
      if (r.uncheckable) {
        errors.push({
          kind: 'op_input_uncheckable',
          taskIds: [task.taskId],
          ...(path ? { field: path } : {}),
          detail: `Operation task "${task.taskId}" inputTemplate position "${path || '(root)'}" for "${task.operation ?? ''}" uses an op-side construct that cannot be statically checked${r.gap ? ` (${r.gap})` : ''}. Flagged as a platform follow-up.`,
        });
      } else if (!r.covered) {
        errors.push({
          kind: 'op_input_incompatible',
          taskIds: [task.taskId, ...(producer ? [producer.taskId] : [])],
          ...(path ? { field: path } : {}),
          detail:
            `Operation task "${task.taskId}" inputTemplate position "${path || '(root)'}" ` +
            `("${TEMPLATE_BIND_KEY}": "${node[TEMPLATE_BIND_KEY]}" from ${describeBinding(binding)}) is incompatible with ` +
            `"${task.operation ?? ''}": ${r.gap ?? 'shape mismatch'}.`,
        });
      }
      return;
    }

    const operatorNode = readTemplateOperatorNode(node);
    if (operatorNode !== undefined) {
      // A malformed operator node is owned by `validateInputTemplates`.
      if ('operands' in operatorNode) checkOperator(operatorNode, schemaNode, path);
      return;
    }

    // Object node — descend structurally where the op-side schema is a
    // plain object shape (regardless of binds, so per-field diagnostics
    // match the flat path's even for bind-free templates). z.record-style
    // op positions (no declared `properties`, open `additionalProperties`)
    // fall through this with nothing to check — the free-form lane.
    if (isRecord(node)) {
      const props = recordOf(schemaNode['properties']);
      const isObjectShape = schemaNode['type'] === 'object' || Object.keys(props).length > 0;
      if (!isObjectShape) {
        // Exotic op-side construct (union/combinator/leaf). A pure-literal
        // value can still be Ajv-validated whole; binds make it unknowable.
        if (!templateContainsSubstitution(node)) checkLiteral(node, schemaNode, path);
        return;
      }
      for (const requiredKey of stringArrayOf(schemaNode['required'])) {
        if (!Object.prototype.hasOwnProperty.call(node, requiredKey)) {
          errors.push({
            kind: 'op_input_missing_required',
            taskIds: [task.taskId],
            field: joinField(path, requiredKey),
            detail: `Operation task "${task.taskId}" inputTemplate is missing required input "${joinField(path, requiredKey)}" for "${task.operation ?? ''}". Add the field to the template.`,
          });
        }
      }
      if (schemaNode['additionalProperties'] === false) {
        for (const key of Object.keys(node)) {
          if (Object.prototype.hasOwnProperty.call(props, key)) continue;
          if (path === '' && HARNESS_ENVELOPE_INPUT_KEYS.has(key)) continue;
          errors.push({
            kind: 'op_input_undeclared_field',
            taskIds: [task.taskId],
            field: joinField(path, key),
            detail:
              `Operation task "${task.taskId}" inputTemplate supplies "${joinField(path, key)}", which ` +
              `"${task.operation ?? ''}" does not declare (the schema at this position is closed: additionalProperties:false), ` +
              `so it is rejected at runtime. Remove it, or correct the name to one of: ${Object.keys(props).sort().join(', ') || '(none)'}.`,
          });
        }
      }
      for (const [key, child] of Object.entries(node)) {
        const childSchema = props[key];
        if (isRecord(childSchema)) checkNode(child, childSchema, joinField(path, key));
      }
      // A record-shaped position (every entry validated by additionalProperties
      // or keyed by propertyNames) declares no properties to descend into, so
      // a literal there is validated whole or not at all.
      const recordShaped =
        Object.keys(props).length === 0 &&
        (isRecord(schemaNode['additionalProperties']) || isRecord(schemaNode['propertyNames']));
      if (recordShaped && !templateContainsSubstitution(node)) checkLiteral(node, schemaNode, path);
      return;
    }

    if (Array.isArray(node)) {
      if (!templateContainsSubstitution(node)) {
        // Pure-literal array — Ajv-validate whole so array-level
        // constraints (minItems, uniqueItems) are covered.
        checkLiteral(node, schemaNode, path);
        return;
      }
      const items = schemaNode['items'];
      if (isRecord(items)) {
        node.forEach((el, i) => {
          checkNode(el, items, `${path}[${String(i)}]`);
        });
      }
      return;
    }

    // Primitive leaf — concrete value, validate directly.
    checkLiteral(node, schemaNode, path);
  };

  // `$firstOf` yields one of its operands, so each must suit the position;
  // `$concat` yields a string from string operands.
  const checkOperator = (
    node: { operator: TemplateOperatorKey; operands: unknown[] },
    schemaNode: Record<string, unknown>,
    path: string,
  ): void => {
    const operandsPath = joinField(path, node.operator);
    if (node.operator === TEMPLATE_FIRST_OF_KEY) {
      node.operands.forEach((operand, i) => {
        checkNode(operand, schemaNode, `${operandsPath}[${String(i)}]`);
      });
      return;
    }

    node.operands.forEach((operand, i) => {
      const operandPath = `${operandsPath}[${String(i)}]`;
      if (typeof operand === 'string') return;
      if (
        isRecord(operand) &&
        (Object.prototype.hasOwnProperty.call(operand, TEMPLATE_BIND_KEY) ||
          readTemplateOperatorNode(operand) !== undefined)
      ) {
        checkNode(operand, STRING_SCHEMA, operandPath);
        return;
      }
      errors.push({
        kind: 'op_input_incompatible',
        taskIds: [task.taskId],
        field: operandPath,
        detail:
          `Operation task "${task.taskId}" inputTemplate "${TEMPLATE_CONCAT_KEY}" at "${path || '(root)'}" joins strings, ` +
          `and operand ${String(i)} is ${describeLiteral(operand)}. Write it as a string, or bind a string output.`,
      });
    });

    if (node.operands.every((operand): operand is string => typeof operand === 'string')) {
      checkLiteral(node.operands.join(''), schemaNode, path);
      return;
    }
    // Only the type: a joined string cannot be shown statically to meet the
    // position's length, pattern or enum, which the op's own input check holds.
    if (!schemaAdmitsString(schemaNode)) {
      errors.push({
        kind: 'op_input_incompatible',
        taskIds: [task.taskId],
        ...(path ? { field: path } : {}),
        detail:
          `Operation task "${task.taskId}" inputTemplate position "${path || '(root)'}" holds a "${TEMPLATE_CONCAT_KEY}" node, ` +
          `which yields a string, and "${task.operation ?? ''}" takes no string there.`,
      });
    }
  };

  const checkLiteral = (node: unknown, schemaNode: Record<string, unknown>, path: string): void => {
    const literalError = validateLiteralAgainstSchema(schemaNode, node);
    if (literalError) {
      errors.push({
        kind: 'op_input_incompatible',
        taskIds: [task.taskId],
        ...(path ? { field: path } : {}),
        detail: `Operation task "${task.taskId}" inputTemplate position "${path || '(root)'}" (literal) is incompatible with "${task.operation ?? ''}": ${literalError}.`,
      });
    }
  };

  checkNode(template, opInputSchema, '');
}

/** Whether a JSON Schema property admits `null`. */
function schemaAcceptsNull(prop: Record<string, unknown>): boolean {
  const ty = prop['type'];
  if (ty === 'null') return true;
  if (Array.isArray(ty) && ty.includes('null')) return true;
  if (prop['nullable'] === true) return true; // OpenAPI-style
  const en = prop['enum'];
  if (Array.isArray(en) && en.includes(null)) return true;
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = prop[combinator];
    if (Array.isArray(branches)) {
      if (branches.some((b) => isRecord(b) && schemaAcceptsNull(b))) return true;
    }
  }
  return false;
}

/** Whether a JSON Schema property is typed exactly/only as `t`. */
function schemaTypeIs(prop: Record<string, unknown>, t: string): boolean {
  const ty = prop['type'];
  if (typeof ty === 'string') return ty === t;
  if (Array.isArray(ty)) return ty.length > 0 && ty.every((x) => x === t);
  return false;
}

/** Validate a concrete literal value against a JSON Schema via Ajv (resumeAjv pattern). */
function validateLiteralAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  try {
    const ajv = getResumeAjv();
    const validate = ajv.compile(schema);
    if (validate(value)) return null;
    // Errors live on the compiled validator, not the Ajv instance (matches
    // `workflowRunResumeModes.ts`); reading `ajv.errors` yields empty diagnostics.
    const errors =
      (validate as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
        .errors ?? [];
    const issues = errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`)
      .join('; ');
    return issues || 'value does not satisfy the operation input schema';
  } catch {
    // Ajv could not compile/validate (exotic schema) — skip rather than
    // false-reject; the coverage check covers the structural case.
    return null;
  }
}

const STRING_SCHEMA: Record<string, unknown> = { type: 'string' };

/** Whether a position's schema can admit some string; a construct this cannot read admits one. */
function schemaAdmitsString(schema: Record<string, unknown>): boolean {
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches)) {
      return branches.some((branch) => !isRecord(branch) || schemaAdmitsString(branch));
    }
  }
  const ty = schema['type'];
  if (typeof ty === 'string') return ty === 'string';
  if (Array.isArray(ty)) return ty.includes('string');
  if (Object.keys(recordOf(schema['properties'])).length > 0) return false;
  return true;
}

function describeLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} literal`;
}

function describeBinding(binding: WorkflowTaskInputBinding): string {
  if (binding.kind === 'task_output') {
    return binding.path ? `${binding.taskId}.${binding.path}` : `${binding.taskId} (whole output)`;
  }
  return binding.kind;
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ============================================================================
// Upstream closure computation
// ============================================================================

/**
 * Build the transitive upstream dependency closure for each task.
 * Returns a map of taskId → Set of all transitive upstream task IDs.
 */
function buildUpstreamClosure(tasks: WorkflowTask[]): Map<string, Set<string>> {
  const depsMap = new Map<string, string[]>();
  for (const task of tasks) {
    depsMap.set(task.taskId, task.dependsOn ?? []);
  }

  const cache = new Map<string, Set<string>>();

  function resolve(taskId: string, visited: Set<string>): Set<string> {
    const cached = cache.get(taskId);
    if (cached) return cached;

    // Guard against cycles (already validated above, but be safe)
    if (visited.has(taskId)) return new Set();

    visited.add(taskId);
    const upstream = new Set<string>();
    const directDeps = depsMap.get(taskId) ?? [];

    for (const depId of directDeps) {
      upstream.add(depId);
      // Add transitive deps
      for (const transitive of resolve(depId, visited)) {
        upstream.add(transitive);
      }
    }

    cache.set(taskId, upstream);
    return upstream;
  }

  for (const task of tasks) {
    resolve(task.taskId, new Set());
  }

  return cache;
}

// ============================================================================
// Cycle detection
// ============================================================================

type NodeColor = 'white' | 'gray' | 'black';

/**
 * DFS-based cycle detection on the dependency graph.
 * Returns the set of task IDs that participate in at least one cycle,
 * or an empty array if the graph is a DAG.
 */
function detectCycles(tasks: WorkflowTask[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    if (!adjacency.has(task.taskId)) {
      adjacency.set(task.taskId, []);
    }
  }

  const color = new Map<string, NodeColor>();
  for (const task of tasks) {
    color.set(task.taskId, 'white');
  }

  const dependsOnMap = new Map<string, string[]>();
  for (const task of tasks) {
    dependsOnMap.set(task.taskId, task.dependsOn ?? []);
  }

  const cycleNodes = new Set<string>();

  function dfs(nodeId: string, path: string[]): boolean {
    color.set(nodeId, 'gray');
    path.push(nodeId);

    const deps = dependsOnMap.get(nodeId) ?? [];
    for (const depId of deps) {
      const depColor = color.get(depId);
      if (depColor === 'gray') {
        const cycleStart = path.indexOf(depId);
        for (let i = cycleStart; i < path.length; i++) {
          cycleNodes.add(path[i]!);
        }
        return true;
      }
      if (depColor === 'white') {
        dfs(depId, path);
      }
    }

    path.pop();
    color.set(nodeId, 'black');
    return false;
  }

  for (const task of tasks) {
    if (color.get(task.taskId) === 'white') {
      dfs(task.taskId, []);
    }
  }

  return Array.from(cycleNodes);
}

/**
 * Check whether an RFC 6902 JSON Patch touches graph-structural fields
 * (tasks, dependsOn, or when references). Used to gate graph validation
 * on patch operations — we only re-validate when the graph changes.
 */
export function patchTouchesGraph(
  operations: Array<{ op: string; path: string; from?: string | undefined }>,
): boolean {
  const graphPrefixes = ['/tasks', '/stateVariables'];
  return operations.some((op) => {
    if (graphPrefixes.some((p) => op.path === p || op.path.startsWith(`${p}/`))) {
      return true;
    }
    if ((op.op === 'move' || op.op === 'copy') && op.from) {
      if (graphPrefixes.some((p) => op.from === p || op.from!.startsWith(`${p}/`))) {
        return true;
      }
    }
    return false;
  });
}
