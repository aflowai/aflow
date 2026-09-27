import {
  WorkflowAssemblyInputSchema,
  isUsableJsonSchema,
  isCampaignFieldConsume,
  isCampaignRef,
  type AssembleWorkflowOutput,
  type ComposeIntent,
  type ComposedWorkflow,
  type DesignSurface,
  type OptimizationArchetypeSpec,
  type Outcome,
  type SkillGoal,
  type TaskGraphDraftTask,
  type TaskInputContract,
  type TaskInputContractBinding,
  type ThresholdOperator,
  type WorkflowAssemblyInput,
  type WorkflowMode,
  type WorkflowStateVariable,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
  type WorkflowTaskOutputPort,
  type DraftWhen,
  type WorkflowWhen,
} from '@aflow/schemas';
import { contractErrorJsonSchema, deriveOpBoundDraftPortShapes } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess, readInlineOpInputRecord } from './helpers.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

// ============================================================================
// Input loading
// ============================================================================

// ============================================================================

// ============================================================================
// Producer-key index (for defensive consumes validation)
// ============================================================================

/**
 * Build a `<taskId>::<outputKey>` set covering every output the draft
 * declares. Used to defensively reject `consumes[]` that point at a key the
 * producer doesn't declare — should already have been caught by
 * `task-graph-self-consistent`, but assembly fails loudly here as
 * defense-in-depth.
 */
function buildProducedKeys(tasks: readonly TaskGraphDraftTask[]): Set<string> {
  const out = new Set<string>();
  for (const task of tasks) {
    for (const p of task.produces) {
      out.add(`${task.taskId}::${p.key}`);
    }
  }
  return out;
}

// ============================================================================

/**
 * Build a producer-port lookup keyed by `<taskId>::<outputKey>` → port.
 *
 * Throws on duplicate `<taskId>::<key>` — a producer authoring two ports
 * with the same key would silently last-one-wins through the index, leaving
 * downstream `inputContract` derivation pointing at one shape while
 * `lowerProduces` persists both. Reject loud at assemble time. (Cross-task
 * duplicates are impossible — different `taskId`s produce different keys.)
 */
function buildProducerPortIndex(
  tasks: readonly TaskGraphDraftTask[],
): Map<string, WorkflowTaskOutputPort> {
  const out = new Map<string, WorkflowTaskOutputPort>();
  for (const task of tasks) {
    const ports = 'produces' in task ? task.produces : [];
    const seen = new Set<string>();
    for (const p of ports) {
      if (seen.has(p.key)) {
        throw new Error(
          `assembleWorkflow: task="${task.taskId}" declares duplicate produces[].key="${p.key}". Each output port key must be unique within a task.`,
        );
      }
      seen.add(p.key);
      if (!isUsableJsonSchema(p.shape)) {
        throw new Error(
          `assembleWorkflow: task="${task.taskId}" produces[].key="${p.key}" has a shape that is not a usable JSON Schema fragment. ` +
            `shape must be an object with at least one of: type, $ref, oneOf, anyOf, allOf, enum, const.`,
        );
      }
      out.set(`${task.taskId}::${p.key}`, {
        key: p.key,
        shape: p.shape,
        semantics: p.semantics,
        ...(p.providesPurposeId ? { providesPurposeId: p.providesPurposeId } : {}),
      });
    }
  }
  return out;
}

/**
 * Lift the IR's `produces[]` onto the assembled `WorkflowTask` (D12).
 * Returns `undefined` for tasks that declare no ports so the assembled task
 * stays minimal.
 */
function lowerProduces(task: TaskGraphDraftTask): WorkflowTaskOutputPort[] | undefined {
  const ports = 'produces' in task ? task.produces : [];
  if (ports.length === 0) return undefined;
  return ports.map((p) => {
    if (!isUsableJsonSchema(p.shape)) {
      throw new Error(
        `assembleWorkflow: task="${task.taskId}" produces[].key="${p.key}" has a shape that is not a usable JSON Schema fragment.`,
      );
    }
    return {
      key: p.key,
      shape: p.shape,
      semantics: p.semantics,
      ...(p.providesPurposeId ? { providesPurposeId: p.providesPurposeId } : {}),
    } satisfies WorkflowTaskOutputPort;
  });
}

/**
 * Derive a `TaskInputContract` per task from its lowered `inputBindings`.
 * Each entry's JSON Schema is sourced from the producer's `produces[]` port
 * for `task_output`, with kind-specific defaults for the other variants.
 *
 * Returns `undefined` when the task has no bindings — leaves the task
 * minimal so the runtime knows there is nothing to validate at `validate_input`.
 *
 * Throws a typed lowering error when a binding's `outputKey` (lowered to
 * `path` on the runtime binding) does not resolve to a producer port. This
 * is defensive — `lowerInputBindings` already throws on the same condition
 * via `producedKeys`, but the contract derivation is the place where the
 * topology check has the richest information for diagnostics.
 */
function deriveInputContract(
  taskId: string,
  inputBindings: Record<string, WorkflowTaskInputBinding> | undefined,
  producerPortIndex: ReadonlyMap<string, WorkflowTaskOutputPort>,
): TaskInputContract | undefined {
  if (!inputBindings || Object.keys(inputBindings).length === 0) return undefined;

  const bindings: Record<string, TaskInputContractBinding> = {};

  for (const [bindAs, binding] of Object.entries(inputBindings)) {
    switch (binding.kind) {
      case 'task_output': {
        // The lowered runtime binding stores the producer's port key in
        // `path` (compose-skill convention — see `lowerInputBindings`).
        const outputKey = binding.path;
        if (!outputKey) {
          throw new Error(
            `assembleWorkflow: task="${taskId}" inputBindings["${bindAs}"] is kind=task_output without a port key (path). The compose-skill lowering must set path = consumes[].outputKey.`,
          );
        }
        const port = producerPortIndex.get(`${binding.taskId}::${outputKey}`);
        if (!port) {
          throw new Error(
            `assembleWorkflow: task="${taskId}" inputBindings["${bindAs}"] references producer "${binding.taskId}".produces[].key="${outputKey}" but no matching port exists.`,
          );
        }
        bindings[bindAs] = {
          kind: 'task_output',
          bindAs,
          taskId: binding.taskId,
          outputKey,
          schema: port.shape,
        };
        break;
      }
      case 'task_summary': {
        bindings[bindAs] = {
          kind: 'task_summary',
          bindAs,
          taskId: binding.taskId,
          schema: { type: 'string' },
        };
        break;
      }
      case 'run_input': {
        // No run-input contract is declared on workflows yet (Phase A leaves
        // this as a placeholder; the runtime-supplied snapshot validates
        // structurally at the call site rather than via the schema).
        bindings[bindAs] = {
          kind: 'run_input',
          bindAs,
          path: binding.path,
          schema: {},
        };
        break;
      }
      case 'system_feedback': {
        bindings[bindAs] = {
          kind: 'system_feedback',
          bindAs,
          schema: contractErrorJsonSchema(),
        };
        break;
      }
      case 'artifact_binding': {
        bindings[bindAs] = {
          kind: 'artifact_binding',
          bindAs,
          bundleId: binding.bundleId,
          bindingId: binding.bindingId,
          schema: { type: 'string', format: 'uuid' },
        };
        break;
      }
      case 'campaign_input': {
        bindings[bindAs] = {
          kind: 'campaign_input',
          bindAs,
          path: binding.path,
          schema: {},
        };
        break;
      }
      case 'connection_binding': {
        // Resolved at DISPATCH from the run's pinned connection (run.metadata), not
        // a first-task typed input — so it carries NO entry in the flat input
        // contract. Explicit skip; the `never` default keeps the switch exhaustive
        // so a future binding kind can never be silently dropped here.
        break;
      }
      case 'learning_set': {
        // Resolved at DISPATCH by the platform (active-learning-set selector over
        // the run's skill/campaign) — like connection_binding, no entry in the
        // flat input contract.
        break;
      }
      default: {
        const _exhaustive: never = binding;
        void _exhaustive;
        throw new Error(
          `assembleWorkflow: task="${taskId}" inputBindings["${bindAs}"] has an unhandled binding kind.`,
        );
      }
    }
  }

  return { bindings };
}

// ============================================================================
// Task lowering
// ============================================================================

/**
 * Build a human-readable display name from a kebab/snake-cased taskId.
 * Avoids inventing structural data — purely cosmetic.
 */
function deriveTaskName(taskId: string): string {
  return taskId
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

interface LowerOpts {
  /** Set of `<taskId>::<outputKey>` keys produced by the draft. */
  producedKeys: ReadonlySet<string>;
  producerPortIndex: ReadonlyMap<string, WorkflowTaskOutputPort>;
}

/**
 * Build the `outputContract` for a task.
 *
 * Two cases (provenance gates removed 2026-05-06 — see top-of-file note):
 *
 *   1. No `produces[]` → `undefined`. No contract (legacy free-form lane).
 *   2. `produces[].length > 0` → strict derived schema:
 *        - `properties[port.key] = port.shape` for every declared port
 *        - `required` lists every port key
 *        - `additionalProperties: false`
 *
 * Output validation reads `task.outputContract.schema` directly from the
 * persisted workflow definition — no runtime change needed.
 */
function buildOutputContract(
  task: TaskGraphDraftTask,
  _opts: LowerOpts,
): WorkflowTask['outputContract'] | undefined {
  const ports = 'produces' in task ? task.produces : [];

  // Case 1: no ports declared. No contract — legacy free-form lane.
  if (ports.length === 0) return undefined;

  // Case 2: produces[]-bearing task. Derive the strict schema from the
  // declared ports.
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const port of ports) {
    properties[port.key] = port.shape;
    required.push(port.key);
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };

  return { schema };
}

function lowerInputBindings(
  task: TaskGraphDraftTask,
  opts: LowerOpts,
): Record<string, WorkflowTaskInputBinding> | undefined {
  if (task.type === 'human') return undefined;
  const consumes = task.consumes;
  if (consumes.length === 0) return undefined;
  const out: Record<string, WorkflowTaskInputBinding> = {};
  for (const c of consumes) {
    if (isCampaignFieldConsume(c)) {
      // Campaign-field consume → campaign_input binding (the head segment of
      // `path` names a declared campaign-contract field, resolved at run start
      // against the campaign config — Plan 195).
      out[c.bindAs] = { kind: 'campaign_input', path: c.campaignField };
      continue;
    }
    const key = `${c.taskId}::${c.outputKey}`;
    if (!opts.producedKeys.has(key)) {
      // Production not declared on the producer — should already have been
      // caught upstream by `task-graph-self-consistent`. Defensive: fail
      // loudly here rather than emit a workflow that fails downstream.
      throw new Error(
        `assembleWorkflow: task="${task.taskId}" consumes ${c.taskId}.${c.outputKey} but no matching produces[] entry was found.`,
      );
    }
    out[c.bindAs] = {
      kind: 'task_output',
      taskId: c.taskId,
      path: c.outputKey,
    };
  }
  return out;
}

function lowerDependsOn(task: TaskGraphDraftTask): string[] {
  const explicit = task.dependsOn;
  const consumes = task.type === 'human' ? [] : task.consumes;
  // Campaign-field consumes are not task dependencies (they read run-level
  // campaign config, not an upstream task output).
  const fromConsumes = consumes.flatMap((c) => (isCampaignFieldConsume(c) ? [] : [c.taskId]));
  // `approves` on human tasks establishes ordering without data binding —
  // the human reviews the named tasks' output before deciding.
  const fromApproves = task.type === 'human' ? task.approves : [];
  return [...new Set([...explicit, ...fromConsumes, ...fromApproves])].sort();
}

function lowerAgentContext(
  task: Extract<TaskGraphDraftTask, { type: 'agent' }>,
  hasConsumes: boolean,
): WorkflowTask['context'] | undefined {
  const caps = task.context.capabilities;
  const integrations = caps.integrations.map((i) => ({
    capabilityId: i.bindingId,
    sourceKind: i.sourceKind,
    integrationId: i.integrationId,
    binding: { kind: 'binding' as const, bindingId: i.bindingId },
    ...(i.grantKind ? { grantKind: i.grantKind } : {}),
    toolNames: i.toolNames.map((toolName) => ({ toolName })),
    allTools: false,
  }));
  const operations = caps.operations;
  const hasAny = integrations.length > 0 || operations.length > 0;
  if (!hasAny && !hasConsumes) return undefined;
  return {
    strategy: 'scoped',
    contextPolicy: 'auto-optimize',
    learnings: 'active',
    capabilities: {
      operations,
      integrations,
    },
  };
}

/** A reference a guard makes to a task that did not run skips the guarded task. */
function lowerWhen(when: DraftWhen): WorkflowWhen {
  if (typeof when === 'string') return { expression: when, onMissingRef: 'skip' };
  if ('anyOf' in when) return { anyOf: when.anyOf, onMissingRef: 'skip' };
  return { allOf: when.allOf, onMissingRef: 'skip' };
}

function lowerTask(task: TaskGraphDraftTask, opts: LowerOpts): WorkflowTask {
  const name = deriveTaskName(task.taskId);
  const dependsOn = lowerDependsOn(task);
  const outputContract = buildOutputContract(task, opts);
  const produces = lowerProduces(task);

  if (task.type === 'agent') {
    const inputBindings = lowerInputBindings(task, opts);
    const inputContract = deriveInputContract(task.taskId, inputBindings, opts.producerPortIndex);
    const context = lowerAgentContext(task, task.consumes.length > 0);
    return {
      taskId: task.taskId,
      name,
      goal: task.goal,
      type: 'agent',
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(inputBindings ? { inputBindings } : {}),
      ...(inputContract ? { inputContract } : {}),
      ...(produces ? { produces } : {}),
      ...(task.when ? { when: lowerWhen(task.when) } : {}),
      ...(context ? { context } : {}),
      ...(outputContract ? { outputContract } : {}),
    };
  }

  if (task.type === 'operation') {
    const inputBindings = lowerInputBindings(task, opts);
    const inputContract = deriveInputContract(task.taskId, inputBindings, opts.producerPortIndex);
    return {
      taskId: task.taskId,
      name,
      goal: `Run ${task.operationId}.`,
      type: 'operation',
      operation: task.operationId,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(inputBindings ? { inputBindings } : {}),
      ...(inputContract ? { inputContract } : {}),
      ...(produces ? { produces } : {}),
      ...(Object.keys(task.inputBindings).length > 0 ? { inputs: task.inputBindings } : {}),
      ...(task.inputTemplate !== undefined ? { inputTemplate: task.inputTemplate } : {}),
      ...(task.poll !== undefined ? { poll: task.poll } : {}),
      ...(task.outputProjection !== undefined ? { outputProjection: task.outputProjection } : {}),
      ...(task.retryability !== undefined ? { retryability: task.retryability } : {}),
      ...(task.maxAttempts !== undefined ? { maxAttempts: task.maxAttempts } : {}),
      ...(task.when ? { when: lowerWhen(task.when) } : {}),
      ...(outputContract ? { outputContract } : {}),
    };
  }

  // human — no inputBindings (humans are inputs themselves), but they may
  // still declare `produces[]` for the structured payload they hand back.
  return {
    taskId: task.taskId,
    name,
    goal: `Pause for human input: ${task.pauseInstruction}`,
    type: 'human',
    pauseInstruction: task.pauseInstruction,
    intent: task.intent,
    failureMode: task.failureMode,
    ...(task.context?.actionPreview ? { actionPreview: task.context.actionPreview } : {}),
    // Persist approves so the UI can display "Reviewing output of: ..."
    // without re-reading the graph. The ordering edges are already in dependsOn.
    ...(task.approves.length > 0 ? { approves: task.approves } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(produces ? { produces } : {}),
    ...(task.when ? { when: lowerWhen(task.when) } : {}),
    ...(outputContract ? { outputContract } : {}),
  };
}

// ============================================================================
// Iteration policy
// ============================================================================

function deriveIteration(mode: WorkflowMode): ComposedWorkflow['iteration'] {
  // 'optimization' implies retry-until-target — agents iterate. Other modes
  // run once per kick. Conservative defaults; the user/operator can tune
  // post-ratification.
  if (mode === 'optimization') {
    return {
      auto: false,
      maxConsecutiveRuns: 5,
      stopOnOutcomesMet: true,
      cooldownMs: 0,
    };
  }
  return {
    auto: false,
    maxConsecutiveRuns: 1,
    stopOnOutcomesMet: true,
    cooldownMs: 0,
  };
}

// ============================================================================
// Optimization archetype derivation (Plan 203 §3.3)
// ============================================================================

/**
 * Translate the goal direction (literal or `$campaign` ref) into the threshold
 * outcome operator. maximize → `gte`, minimize → `lte`. A `$campaign`-ref
 * direction yields a `$campaign`-ref operator reading the SAME field, so one
 * skill serves both maximize and minimize campaigns (the Kaggle pattern).
 */
type GoalDirection = OptimizationArchetypeSpec['goalMetric']['direction'];
type ThresholdOperatorSlot = Extract<Outcome['evaluator'], { type: 'threshold' }>['operator'];

/**
 * Drop an EMPTY `$campaign` map. A `map: {}` is meaningless — it can never
 * translate any field value, so it is unambiguously a bare ref the Runner
 * over-specified (the dogfood mistake: `target: { $campaign: 'targetScore',
 * map: {} }` on a numeric field, which trips `campaign_ref_map_incomplete`).
 * A non-empty map is left intact so a genuinely incomplete map still surfaces.
 */
function stripEmptyCampaignMap<T>(value: T): T {
  if (isCampaignRef(value) && value.map !== undefined && Object.keys(value.map).length === 0) {
    return { $campaign: value.$campaign } as T;
  }
  return value;
}

function deriveThresholdOperator(direction: GoalDirection): ThresholdOperatorSlot {
  if (isCampaignRef(direction)) {
    const dirMap = direction.map;
    if (dirMap) {
      const opMap: Record<string, ThresholdOperator> = {};
      for (const [k, v] of Object.entries(dirMap)) {
        opMap[k] = v === 'maximize' ? 'gte' : 'lte';
      }
      return { $campaign: direction.$campaign, map: opMap };
    }
    return { $campaign: direction.$campaign, map: { maximize: 'gte', minimize: 'lte' } };
  }
  return direction === 'maximize' ? 'gte' : 'lte';
}

interface OptimizationDerivation {
  tasks: WorkflowTask[];
  outcomes: Outcome[];
  stateVariables: WorkflowStateVariable[];
  output: NonNullable<ComposedWorkflow['output']>;
  campaign: OptimizationArchetypeSpec['campaign'];
  goal: SkillGoal;
}

/**
 * Derive the optimization loop wiring from the typed spec. Every key derives
 * from ONE source — `goalMetric.producedBy.outputKey` — so the state variable,
 * the promotion, the threshold outcome metric, `output.primary`, and
 * `manifest.goal.metricKey` cannot drift apart.
 */
function deriveOptimizationArchetype(
  loweredTasks: WorkflowTask[],
  spec: OptimizationArchetypeSpec,
): OptimizationDerivation {
  const metricKey = spec.goalMetric.producedBy.outputKey;
  const observeTaskId = spec.goalMetric.producedBy.taskId;
  // Normalize away over-specified empty `$campaign` maps before they reach the
  // derived outcome / goal (a `map: {}` would fail validity at propose time).
  const direction = stripEmptyCampaignMap(spec.goalMetric.direction);
  const target = stripEmptyCampaignMap(spec.target);

  // Inject promoteOutputs on the observe task so the score lands in run state.
  const observeTask = loweredTasks.find((t) => t.taskId === observeTaskId);
  if (!observeTask) {
    throw new Error(
      `assembleWorkflow: optimization.goalMetric.producedBy.taskId "${observeTaskId}" names no task in the assembled workflow.`,
    );
  }
  const tasks = loweredTasks.map((t) =>
    t.taskId === observeTaskId
      ? {
          ...t,
          promoteOutputs: [{ kind: 'output_path' as const, path: metricKey, toState: metricKey }],
        }
      : t,
  );

  const stateVariables: WorkflowStateVariable[] = [
    {
      variableId: metricKey,
      name: deriveTaskName(metricKey),
      description: 'Goal metric this skill optimizes; promoted from the observe task each run.',
      required: false,
      sensitive: false,
      immutable: false,
    },
  ];

  const goalOutcome: Outcome = {
    id: 'goal-met',
    name: 'Goal reached',
    evaluator: {
      type: 'threshold',
      metric: metricKey,
      operator: deriveThresholdOperator(direction),
      target,
    },
  };

  const output: NonNullable<ComposedWorkflow['output']> = {
    primary: metricKey,
    guidance:
      spec.guidance ??
      `Compare ${metricKey} against the campaign target. If the target is not met and run budget remains, summarize the approach and propose the next iteration (workflow.run.start).`,
  };

  const goal: SkillGoal = { type: 'numeric', metricKey, direction };

  return { tasks, outcomes: [goalOutcome], stateVariables, output, campaign: spec.campaign, goal };
}

// ============================================================================
// Top-level assembly
// ============================================================================

export function assembleWorkflow(input: WorkflowAssemblyInput): AssembleWorkflowOutput {
  const { intent, draft } = input;

  deriveOpBoundDraftPortShapes(draft.tasks);

  // 1. Defensive index of every produced output (catches dangling consumes
  //    if `validate-task-graph` was somehow skipped upstream).
  const producedKeys = buildProducedKeys(draft.tasks);

  const producerPortIndex = buildProducerPortIndex(draft.tasks);

  // 2. Lower each draft task. Dataflow → task_output bindings; both
  //    operation and agent consumers resolve them into the typed
  //    `TaskInputs` channel at dispatch time. Each lowered task carries
  const opts: LowerOpts = { producedKeys, producerPortIndex };
  const tasks = draft.tasks.map((t) => lowerTask(t, opts));

  // 3. Optional pause-for-user injection at the indicated boundary. If
  //    intent.pauseForUser.needed is true and no APPROVAL-intent human
  //    task is already in the draft, append one before any
  //    "submission/finalization" tail. Pragmatic placement: at the end.
  //    Operators can move it post-ratification.
  //
  const hasApprovalGate = tasks.some((t) => t.type === 'human' && t.intent === 'approve');
  if (intent.pauseForUser.needed && !hasApprovalGate) {
    const lastIds = tasks.length > 0 ? [tasks[tasks.length - 1]!.taskId] : [];
    const takenIds = new Set(tasks.map((t) => t.taskId));
    let injectedId = 'human-approval';
    let suffix = 2;
    while (takenIds.has(injectedId)) {
      injectedId = `human-approval-${String(suffix)}`;
      suffix += 1;
    }
    tasks.push({
      taskId: injectedId,
      name: 'Human Approval',
      goal: 'Pause for user approval before continuing.',
      type: 'human',
      pauseInstruction: intent.pauseForUser.when ?? 'Approve to continue.',
      intent: 'approve',
      ...(lastIds.length > 0 ? { dependsOn: lastIds } : {}),
    });
  }

  // 4. Assemble. Mode comes straight from intent (no `'graph'` value —
  //    enforced by ComposeIntentSchema; no remap needed). For the optimization
  //    archetype (Plan 203), the loop wiring — stateVariables, promoteOutputs,
  //    the threshold outcome, output, and the manifest campaign + goal — is
  //    DERIVED from the typed `optimization` spec. Other modes lower flat:
  //    dependsOn closures + task_output bindings give the runtime dataflow lane.
  const mode: WorkflowMode = intent.iterationModel;

  let finalTasks = tasks;
  let outcomes = draft.outcomes;
  let stateVariables: WorkflowStateVariable[] = [];
  let output: ComposedWorkflow['output'] | undefined;
  let campaign: AssembleWorkflowOutput['campaign'];
  let manifestGoal: SkillGoal | undefined;

  if (mode === 'optimization' && draft.optimization) {
    const derived = deriveOptimizationArchetype(tasks, draft.optimization);
    finalTasks = derived.tasks;
    outcomes = derived.outcomes;
    stateVariables = derived.stateVariables;
    output = derived.output;
    campaign = derived.campaign;
    manifestGoal = derived.goal;
  }

  const workflow: ComposedWorkflow = {
    slug: draft.slug,
    name: draft.name,
    description: draft.description,
    goal: draft.goal,
    outcomes,
    mode,
    tasks: finalTasks,
    stateVariables,
    ...(output ? { output } : {}),
    iteration: deriveIteration(mode),
  };

  return {
    workflow,
    ...(draft.activation ? { activation: draft.activation } : {}),
    ...(campaign ? { campaign } : {}),
    ...(manifestGoal ? { goal: manifestGoal } : {}),
  };
}

// ============================================================================
// Inline op handler
// ============================================================================

export async function handleAssembleWorkflowInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const opInput = await readInlineOpInputRecord(args);
    if (!opInput) {
      await emitStepError(
        args,
        'ASSEMBLE_WORKFLOW_NO_INPUT',
        'Operation input is missing or unparseable. assemble-workflow expects inputBindings { intent, surface, draft } from analyze-intent + prepare-design-surface + draft-task-graph.',
        startTime,
        'validation',
      );
      return;
    }

    const parsed = WorkflowAssemblyInputSchema.safeParse(opInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      await emitStepError(
        args,
        'ASSEMBLE_WORKFLOW_INVALID_INPUT',
        `Operation input failed schema validation: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }

    let assembled: AssembleWorkflowOutput;
    try {
      assembled = assembleWorkflow(parsed.data);
    } catch (err) {
      await emitStepError(
        args,
        'ASSEMBLE_WORKFLOW_LOWERING_FAILED',
        err instanceof Error ? err.message : String(err),
        startTime,
        'validation',
      );
      return;
    }

    // Forward the WHOLE assembled output (workflow + activation + the
    // optimization-derived campaign + numeric goal — Plan 203 §3.3) so
    // skill.compose.propose can author manifest.campaign/goal. Spreading the
    // typed object (rather than cherry-picking fields) is drift-proof: a future
    // AssembleWorkflowOutput field can't be silently dropped here again — the
    // omission of campaign/goal is exactly what made every optimization compose
    // fail the propose-time archetype check.
    const outputData: Record<string, unknown> = { ...assembled };
    await emitStepSuccess(args, outputData, startTime);

    logger.info(
      `[assembleWorkflow] assembled run=${args.context.runId} slug=${assembled.workflow.slug} tasks=${String(assembled.workflow.tasks.length)} stateVars=${String(assembled.workflow.stateVariables.length)}`,
    );
  } catch (err) {
    logger.error(
      `[assembleWorkflow] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'ASSEMBLE_WORKFLOW_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}

// `DesignSurface` and `ComposeIntent` are used only in types above; explicit
// no-op references silence "declared but never read" in the importing
// runtime when the type-only narrowing is structural.
export type _AssemblerInputTypes = [DesignSurface, ComposeIntent];
