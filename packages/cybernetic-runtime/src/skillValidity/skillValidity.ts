import {
  CAMPAIGN_GOAL_DIRECTIONS,
  getOperation,
  isCampaignRef,
  stableHash,
  StepTypeSchema,
  THRESHOLD_OPERATORS,
  validateEvalSuiteDiscipline,
  validateSkillUiOutputShape,
  WorkflowSchema,
  type CampaignRef,
  type EvalCriterion,
  type EvalSuiteDisciplineInput,
  type Outcome,
  type SkillCampaignContract,
  type SkillDiagnostic,
  type SkillGoal,
  type SkillUiOutput,
  type SkillValidity,
  type WorkflowMode,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
  type WorkflowRunInput,
  type WorkflowStateVariable,
  type WorkflowOutputDeclaration,
} from '@aflow/schemas';
import { validateWorkflowGraph, type GraphValidationError } from '../scheduling/graphValidation.js';
import { entryRunInputSlots } from '../parentTaskInputs.js';
import { deriveOpBoundProducerShapes } from '../scheduling/deriveOpBoundShapes.js';
import { bindingStaticSchema } from '../scheduling/bindingStaticSchema.js';
import {
  validateAgentOpTaskOnlyTools,
  validateSkillEvalPlaneSeparation,
  validateSkillPlanSeparation,
} from '../scheduling/opTaskOnlyValidator.js';
import { CONTAINS_RESERVED_FIELDS } from '../evalRunnerCriterion.js';

// ============================================================================
// Inputs / outputs
// ============================================================================

/**
 * Bundle-level inputs for the checks that only apply when the skill is being
 * authored/installed as a full bundle (compose, ratify, install). When absent
 * (plain `workflow.manage.put/patch`, read-side recompute), only the
 * graph + op-input contract dimensions run — exactly today's behaviour for
 * those paths.
 */
export interface SkillBundleChecks {
  /** `SkillManifest.uiOutput` — cross-checked against the terminal task. */
  uiOutput?: SkillUiOutput | undefined;
  /**
   * `evalSuite.taskCriteria` (taskId → criteria). Two checks:
   *   - `eval_unknown_task` — a key that is not a real task (Slice 1).
   *   - `eval_field_not_produced` — a criterion bound to an output field the
   *     producing task doesn't produce, when its output is closed (Slice 4).
   */
  taskCriteria?: Readonly<Record<string, readonly EvalCriterion[]>> | undefined;
  evalSuite?: EvalSuiteDisciplineInput | undefined;
  manifestRefs?:
    | {
        workflowSlug?: string | undefined;
        evalSuiteRef?: string | undefined;
        activationRef?: string | undefined;
      }
    | undefined;
  /** What the bundle actually carries, for {@link SkillBundleChecks.manifestRefs}. */
  artifacts?:
    | {
        workflowSlug?: string | undefined;
        hasEvalSuite?: boolean | undefined;
        hasActivation?: boolean | undefined;
      }
    | undefined;
}

export interface SkillCampaignChecks {
  /** `manifest.campaign` — absent for skills without an instance contract. */
  contract?: SkillCampaignContract | undefined;
  /** `manifest.goal` — `goal.direction` is a `$campaign` slot. */
  goal?: SkillGoal | undefined;
  /** Workflow outcomes — `evaluator.{operator, target}` are `$campaign` slots. */
  outcomes?: readonly Outcome[] | undefined;
  /** `evalSuite.goalCriteria` — goal-tier threshold slots. */
  goalCriteria?: readonly EvalCriterion[] | undefined;
  /** `evalSuite.trajectoryCriteria` — threshold slots. */
  trajectoryCriteria?: readonly EvalCriterion[] | undefined;
}

/**
 * The manifest-side campaign inputs a post-install mutation gate resolves
 * (one `resolveSkillForWorkflow` read) and threads through; the candidate
 * outcomes / criteria are supplied by the gate from the artifact it is about
 * to persist. See {@link SkillCampaignChecks} for where the rules run.
 */
export type SkillCampaignManifestParams = Pick<SkillCampaignChecks, 'contract' | 'goal'>;

export interface SkillConfigToValidate {
  tasks: WorkflowTask[];
  stateVariables?: WorkflowStateVariable[] | undefined;
  output?: WorkflowOutputDeclaration | undefined;
  /**
   * The workflow's declared run inputs. Needed because declaring one is not the
   * same as being able to pass it: a caller's `inputs` are checked against the
   * ENTRY task's binding surface, so a slot the first task never declares is
   * unreachable no matter what this list says.
   */
  runInputs?: WorkflowRunInput[] | undefined;
  bundle?: SkillBundleChecks | undefined;
  campaign?: SkillCampaignChecks | undefined;
  /**
   * Workflow mode. When `'optimization'`, the archetype-coherence checks run
   * (Plan 203 §4) — the campaign-loop wiring must be present + consistent.
   * Absent on read-side recomputes that don't carry the workflow mode.
   */
  mode?: WorkflowMode | undefined;
}

export interface MaterializeAndValidateResult {
  /** The derived task list (op-bound producer shapes filled). */
  materializedTasks: WorkflowTask[];
  validity: SkillValidity;
}

// ============================================================================
// Write side — materialize + validate
// ============================================================================

/**
 * Derive op-bound producer shapes, then validate the result against current
 * rules + (optionally) the bundle-level checks. Returns the materialized tasks
 * and the verdict. Never throws.
 *
 * Derivation and validation are one atomic step: validating without deriving
 * would still ship an under-materialised seed (the Kaggle incident, §7).
 */
export function materializeAndValidateSkillConfig(
  input: SkillConfigToValidate,
): MaterializeAndValidateResult {
  const diagnostics: SkillDiagnostic[] = [];

  if (!Array.isArray(input.tasks)) {
    return {
      materializedTasks: [],
      validity: invalidParseValidity(
        'tasks_not_array',
        'Workflow config has no task array (tasks is missing or not an array); it cannot be materialised or validated.',
      ),
    };
  }

  // 1. Derive op-bound producer contracts. A multi-consumer conflict throws —
  //    convert it into a blocking diagnostic so the verdict stays uniform.
  let materializedTasks: WorkflowTask[];
  try {
    materializedTasks = deriveOpBoundProducerShapes(input.tasks);
  } catch (err) {
    materializedTasks = input.tasks;
    diagnostics.push({
      code: 'derivation_conflict',
      dimension: 'op_input',
      severity: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Graph + op-input contract validation against the derived tasks. Guarded:
  //    a malformed task object that slips past §0 must not crash the gate.
  const opByTaskId = new Map(materializedTasks.map((t) => [t.taskId, t.operation] as const));
  try {
    const graphErrors = validateWorkflowGraph(
      materializedTasks,
      input.stateVariables,
      input.output,
    );
    for (const err of graphErrors) {
      diagnostics.push(graphErrorToDiagnostic(err, opByTaskId));
    }
  } catch (err) {
    diagnostics.push({
      code: 'validation_error',
      dimension: 'parse',
      severity: 'error',
      detail: `Contract validation could not complete: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  appendEntryInputCoverageDiagnostics(materializedTasks, diagnostics);
  appendRunInputReachabilityDiagnostics(materializedTasks, input.runInputs, diagnostics);

  // Always-on (write AND read-side recompute, so the run-start gate holds):
  // the subject must not see the ruler (Plan 269 D7).
  const evalPlaneError = validateSkillEvalPlaneSeparation(materializedTasks);
  if (evalPlaneError) {
    diagnostics.push({
      code: 'skill_references_eval_plane_op',
      dimension: 'ref',
      severity: 'error',
      detail: evalPlaneError,
    });
  }

  // Same gate, same both sides: a run may serve a plan node, never rewrite the plan (Plan 322 D3).
  const planError = validateSkillPlanSeparation(materializedTasks);
  if (planError) {
    diagnostics.push({
      code: 'skill_references_plan_op',
      dimension: 'ref',
      severity: 'error',
      detail: planError,
    });
  }

  // 3. Bundle-level checks (compose / ratify / install only).
  if (input.bundle) {
    appendBundleDiagnostics(materializedTasks, input.bundle, diagnostics);
  }

  if (input.campaign) {
    appendCampaignRefDiagnostics(input.campaign, input.bundle?.taskCriteria ?? {}, diagnostics);
    appendCampaignInputBindingDiagnostics(materializedTasks, input.campaign.contract, diagnostics);
  }

  if (input.mode === 'optimization') {
    appendOptimizationArchetypeDiagnostics(input, materializedTasks, diagnostics);
  }

  const hasError = diagnostics.some((d) => d.severity === 'error');
  const validity: SkillValidity = {
    status: hasError ? 'invalid' : 'valid',
    diagnostics: diagnostics.filter((d) => d.severity === 'error'),
    advisories: diagnostics.filter((d) => d.severity === 'advisory'),
    validatedAt: new Date().toISOString(),
  };

  return { materializedTasks, validity };
}

export function materializeSkillTasks(tasks: WorkflowTask[]): WorkflowTask[] {
  if (!Array.isArray(tasks)) return tasks;
  try {
    return deriveOpBoundProducerShapes(tasks);
  } catch {
    return tasks;
  }
}

function invalidParseValidity(code: string, detail: string): SkillValidity {
  return {
    status: 'invalid',
    diagnostics: [{ code, dimension: 'parse', severity: 'error', detail }],
    advisories: [],
    validatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Read side — recompute the current verdict
// ============================================================================

export function ensureCurrentSkillValidity(skill: {
  tasks: WorkflowTask[];
  stateVariables?: WorkflowStateVariable[] | undefined;
  output?: WorkflowOutputDeclaration | undefined;
  runInputs?: WorkflowRunInput[] | undefined;
}): SkillValidity {
  return materializeAndValidateSkillConfig({
    tasks: skill.tasks,
    stateVariables: skill.stateVariables,
    output: skill.output,
    runInputs: skill.runInputs,
  }).validity;
}

export function ensureWorkflowDocValidity(raw: unknown): SkillValidity {
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first
      ? `Workflow doc fails schema: ${first.path.join('.')}: ${first.message}`
      : 'Workflow doc is missing or fails schema validation.';
    return invalidParseValidity('workflow_parse_failed', detail);
  }
  const validity = ensureCurrentSkillValidity({
    tasks: parsed.data.tasks,
    stateVariables: parsed.data.stateVariables,
    output: parsed.data.output,
  });
  const quality = computeQualityAdvisories(parsed.data.tasks);
  if (quality.length === 0) return validity;
  return { ...validity, advisories: [...validity.advisories, ...quality] };
}

export function computeQualityAdvisories(tasks: WorkflowTask[]): SkillDiagnostic[] {
  if (tasks.length === 0) return [];
  const noneDeclareCapabilities = tasks.every((t) => {
    const ctx = (t as { context?: unknown }).context;
    if (!ctx || typeof ctx !== 'object') return true;
    const caps = (ctx as Record<string, unknown>)['capabilities'];
    return caps == null || typeof caps !== 'object';
  });
  if (!noneDeclareCapabilities) return [];
  return [
    {
      code: 'no_capability_declarations',
      dimension: 'capability',
      severity: 'advisory',
      detail:
        'No task declares a `context.capabilities` block; tools/APIs are inferred from goal prose only. ' +
        'A Coach can propose update_task_context_spec ops to compile the goal into structured grants.',
    },
  ];
}

// ============================================================================
// Slice 5b — config hash + cached-read fast path (perf, surface lists only)
// ============================================================================

export function hashWorkflowConfig(tasks: unknown, stateVariables: unknown): string {
  return stableHash({ tasks: tasks ?? [], stateVariables: stateVariables ?? [] });
}

export function cachedOrRecomputeValidity(
  workflow: { tasks?: unknown; stateVariables?: unknown } | null | undefined,
  projection:
    | { contractValidity?: SkillValidity | undefined; contractValidityHash?: string | undefined }
    | null
    | undefined,
): SkillValidity {
  if (
    workflow != null &&
    projection?.contractValidity !== undefined &&
    projection.contractValidityHash !== undefined &&
    projection.contractValidityHash === hashWorkflowConfig(workflow.tasks, workflow.stateVariables)
  ) {
    return projection.contractValidity;
  }
  return ensureWorkflowDocValidity(workflow ?? null);
}

// ============================================================================
// Diagnostic shaping
// ============================================================================

/** Graph-validation kinds that belong to the op-input contract dimension. */
const OP_INPUT_KINDS = new Set<GraphValidationError['kind']>([
  'op_unknown',
  'op_input_missing_required',
  'op_input_undeclared_producer_shape',
  'op_input_conditional_absence',
  'op_input_incompatible',
  'op_input_uncheckable',
  'op_input_undeclared_field',
]);

/**
 * Kinds where `taskIds[1]` is genuinely the upstream PRODUCER (dataflow /
 * op-input dimensions). For other kinds `taskIds[1]` is a dependency or a
 * when-ref target — labelling it `producerTaskId` would mislead a consumer, so
 * the field is left unset.
 */
const PRODUCER_IN_TASKIDS = new Set<GraphValidationError['kind']>([
  'binding_dangling_task_ref',
  'binding_not_upstream',
  'binding_dangling_port_ref',
  'op_input_undeclared_producer_shape',
  'op_input_conditional_absence',
  'op_input_incompatible',
]);

function graphErrorToDiagnostic(
  err: GraphValidationError,
  opByTaskId: ReadonlyMap<string, string | undefined>,
): SkillDiagnostic {
  const taskId = err.taskIds[0];
  const producerTaskId = PRODUCER_IN_TASKIDS.has(err.kind) ? err.taskIds[1] : undefined;
  const operationId = taskId ? opByTaskId.get(taskId) : undefined;
  return {
    code: err.kind,
    dimension: OP_INPUT_KINDS.has(err.kind) ? 'op_input' : 'graph',
    severity: 'error',
    ...(taskId !== undefined ? { taskId } : {}),
    ...(err.field !== undefined ? { field: err.field } : {}),
    ...(producerTaskId !== undefined ? { producerTaskId } : {}),
    ...(operationId !== undefined ? { operationId } : {}),
    detail: err.detail,
  };
}

function appendBundleDiagnostics(
  tasks: WorkflowTask[],
  bundle: SkillBundleChecks,
  out: SkillDiagnostic[],
): void {
  const opTaskOnlyError = validateAgentOpTaskOnlyTools(tasks);
  if (opTaskOnlyError) {
    out.push({
      code: 'agent_references_op_task_only_tool',
      dimension: 'ref',
      severity: 'error',
      detail: opTaskOnlyError,
    });
  }

  // Eval task-scoped criteria — taskId existence + output-field linkage.
  if (bundle.taskCriteria) {
    appendEvalLinkageDiagnostics(tasks, bundle.taskCriteria, out);
  }

  if (bundle.evalSuite) {
    for (const issue of validateEvalSuiteDiscipline(bundle.evalSuite)) {
      out.push({
        code: issue.code,
        dimension: 'eval_linkage',
        severity: 'advisory',
        detail: issue.detail,
        fixHint:
          issue.code === 'judge_without_deterministic_anchor'
            ? 'Add at least one threshold / contains / trace_bound criterion before admitting a judge.'
            : 'Set judge-only tiers to weight 0 (advisory) and give a deterministic tier non-zero weight.',
      });
    }
  }

  // Manifest refs must resolve to artifacts the bundle actually carries.
  if (bundle.manifestRefs) {
    appendRefDiagnostics(bundle.manifestRefs, bundle.artifacts ?? {}, out);
  }

  // Agent capability grants must reference real platform operations.
  appendCapabilityDiagnostics(tasks, out);

  const uiErrors = validateSkillUiOutputShape(
    bundle.uiOutput,
    tasks.map((t) => ({
      taskId: t.taskId,
      ...(t.operation !== undefined ? { operation: t.operation } : {}),
      ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
      ...(t.inputBindings !== undefined ? { inputBindings: t.inputBindings } : {}),
    })),
  );
  for (const e of uiErrors) {
    out.push({
      code: e.kind,
      dimension: 'ref',
      severity: 'error',
      detail: `uiOutput: ${e.detail}`,
    });
  }

  // Curated context strategy is reserved (105) — reject in authored bundles.
  for (const task of tasks) {
    if (task.context && 'strategy' in task.context && task.context.strategy === 'curated') {
      out.push({
        code: 'curated_context_forbidden',
        dimension: 'graph',
        severity: 'error',
        taskId: task.taskId,
        detail:
          `Task '${task.taskId}' declares context strategy 'curated', which is reserved for V3 (105). ` +
          `Use 'static' or 'scoped'.`,
      });
    }
  }
}

// ============================================================================

/** One parameterizable slot a `$campaign` ref may occupy. */
type CampaignSlot = { kind: 'number' } | { kind: 'enum'; allowed: readonly string[] };

interface CampaignRefSite {
  ref: CampaignRef;
  slot: CampaignSlot;
  /** Human-readable slot location for the diagnostic detail. */
  where: string;
  dimension: 'ref' | 'eval_linkage';
  taskId?: string | undefined;
}

function thresholdCriterionRefSites(
  criterion: EvalCriterion,
  whereBase: string,
  dimension: 'ref' | 'eval_linkage',
  taskId: string | undefined,
  sites: CampaignRefSite[],
): void {
  if (criterion.type !== 'threshold') return;
  if (isCampaignRef(criterion.operator)) {
    sites.push({
      ref: criterion.operator,
      slot: { kind: 'enum', allowed: THRESHOLD_OPERATORS },
      where: `${whereBase}.operator`,
      dimension,
      taskId,
    });
  }
  if (isCampaignRef(criterion.target)) {
    sites.push({
      ref: criterion.target,
      slot: { kind: 'number' },
      where: `${whereBase}.target`,
      dimension,
      taskId,
    });
  }
}

function collectCampaignRefSites(
  campaign: SkillCampaignChecks,
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>>,
): CampaignRefSite[] {
  const sites: CampaignRefSite[] = [];

  if (campaign.goal?.type === 'numeric' && isCampaignRef(campaign.goal.direction)) {
    sites.push({
      ref: campaign.goal.direction,
      slot: { kind: 'enum', allowed: CAMPAIGN_GOAL_DIRECTIONS },
      where: 'manifest.goal.direction',
      dimension: 'ref',
      taskId: undefined,
    });
  }

  for (const outcome of campaign.outcomes ?? []) {
    const ev = outcome.evaluator;
    if (ev.type !== 'threshold') continue;
    if (isCampaignRef(ev.operator)) {
      sites.push({
        ref: ev.operator,
        slot: { kind: 'enum', allowed: THRESHOLD_OPERATORS },
        where: `outcome '${outcome.id}'.evaluator.operator`,
        dimension: 'ref',
        taskId: undefined,
      });
    }
    if (isCampaignRef(ev.target)) {
      sites.push({
        ref: ev.target,
        slot: { kind: 'number' },
        where: `outcome '${outcome.id}'.evaluator.target`,
        dimension: 'ref',
        taskId: undefined,
      });
    }
  }

  for (const criterion of campaign.goalCriteria ?? []) {
    thresholdCriterionRefSites(
      criterion,
      `goalCriteria '${criterion.name}'`,
      'eval_linkage',
      undefined,
      sites,
    );
  }
  for (const criterion of campaign.trajectoryCriteria ?? []) {
    thresholdCriterionRefSites(
      criterion,
      `trajectoryCriteria '${criterion.name}'`,
      'eval_linkage',
      undefined,
      sites,
    );
  }
  for (const [taskId, criteria] of Object.entries(taskCriteria)) {
    for (const criterion of criteria) {
      thresholdCriterionRefSites(
        criterion,
        `taskCriteria['${taskId}'] '${criterion.name}'`,
        'eval_linkage',
        taskId,
        sites,
      );
    }
  }

  return sites;
}

/** Pull the string-enum values out of a contract field's JSON Schema, if any. */
function fieldSchemaEnum(schema: Record<string, unknown>): string[] | null {
  const raw = schema['enum'];
  if (!Array.isArray(raw)) return null;
  const values = raw.filter((v): v is string => typeof v === 'string');
  return values.length === raw.length ? values : null;
}

export function validateCampaignParameterization(
  campaign: SkillCampaignChecks,
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>> = {},
): SkillDiagnostic[] {
  const out: SkillDiagnostic[] = [];
  appendCampaignRefDiagnostics(campaign, taskCriteria, out);
  return out;
}

function appendCampaignRefDiagnostics(
  campaign: SkillCampaignChecks,
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>>,
  out: SkillDiagnostic[],
): void {
  const contract = campaign.contract;
  const sites = collectCampaignRefSites(campaign, taskCriteria);

  for (const site of sites) {
    const field = contract?.fields[site.ref.$campaign];
    if (!field) {
      out.push({
        code: 'campaign_ref_unknown_field',
        dimension: site.dimension,
        severity: 'error',
        field: site.ref.$campaign,
        ...(site.taskId !== undefined ? { taskId: site.taskId } : {}),
        detail:
          `${site.where} references "$campaign": "${site.ref.$campaign}", but ` +
          (contract
            ? `the manifest campaign contract declares no field "${site.ref.$campaign}" ` +
              `(declared: ${Object.keys(contract.fields).join(', ') || '(none)'}).`
            : 'the manifest declares no campaign contract at all.'),
        fixHint: contract
          ? 'Reference a declared contract field, or add the field to manifest.campaign.fields.'
          : 'Declare manifest.campaign with the referenced field, or replace the ref with a literal.',
      });
      continue;
    }

    const refMap = site.ref.map;
    if (refMap !== undefined) {
      const enumValues = fieldSchemaEnum(field.schema);
      if (enumValues === null) {
        out.push({
          code: 'campaign_ref_map_incomplete',
          dimension: site.dimension,
          severity: 'error',
          field: site.ref.$campaign,
          ...(site.taskId !== undefined ? { taskId: site.taskId } : {}),
          detail:
            `${site.where} uses an enum-mapped ref on "$campaign": "${site.ref.$campaign}", but the ` +
            'field schema declares no string enum — a map is only checkable (and resolvable) over an enum.',
          fixHint: `Give "${site.ref.$campaign}" an enum schema (e.g. { "type": "string", "enum": [...] }).`,
        });
        continue;
      }
      const missing = enumValues.filter((v) => !Object.prototype.hasOwnProperty.call(refMap, v));
      if (missing.length > 0) {
        out.push({
          code: 'campaign_ref_map_incomplete',
          dimension: site.dimension,
          severity: 'error',
          field: site.ref.$campaign,
          ...(site.taskId !== undefined ? { taskId: site.taskId } : {}),
          detail:
            `${site.where}: map on "$campaign": "${site.ref.$campaign}" does not cover the field's ` +
            `enum — missing [${missing.join(', ')}]. An uncovered value fails resolution at read time.`,
          fixHint: `Add map entries for [${missing.join(', ')}].`,
        });
      }
      continue;
    }

    // Value ref — the field's schema must produce a slot-compatible value.
    if (site.slot.kind === 'number') {
      const type = field.schema['type'];
      if (type !== 'number' && type !== 'integer') {
        out.push({
          code: 'campaign_ref_type_mismatch',
          dimension: site.dimension,
          severity: 'error',
          field: site.ref.$campaign,
          ...(site.taskId !== undefined ? { taskId: site.taskId } : {}),
          detail:
            `${site.where} requires a number, but contract field "${site.ref.$campaign}" has ` +
            `schema type ${JSON.stringify(type)} — resolution would fail on every run.`,
          fixHint: `Make "${site.ref.$campaign}" numeric, or reference a numeric field.`,
        });
      }
    } else {
      const enumValues = fieldSchemaEnum(field.schema);
      const allowed = site.slot.allowed;
      const invalid = enumValues?.filter((v) => !allowed.includes(v)) ?? null;
      if (enumValues === null || (invalid !== null && invalid.length > 0)) {
        out.push({
          code: 'campaign_ref_type_mismatch',
          dimension: site.dimension,
          severity: 'error',
          field: site.ref.$campaign,
          ...(site.taskId !== undefined ? { taskId: site.taskId } : {}),
          detail:
            `${site.where} requires one of [${allowed.join(', ')}], but contract field ` +
            `"${site.ref.$campaign}" ` +
            (enumValues === null
              ? 'declares no string enum.'
              : `allows incompatible value(s) [${invalid!.join(', ')}].`),
          fixHint:
            `Add a "map" translating the field's enum to [${allowed.join(', ')}], or constrain the ` +
            'field schema enum to slot-compatible values.',
        });
      }
    }
  }

  // Placeholder-constant rule — only meaningful when a contract exists. On
  // the OUTCOME side it is scoped to the goal metric, mirroring
  // `resolveCampaignTargetBar`: the campaign bar is the threshold outcome ON
  // `goal.metricKey`, so a literal there is the §1b placeholder failure — but
  // a constant threshold on a NON-goal metric (e.g. `errorRate lte 0.01`) is
  // a legitimate fixed check and must not be blocked. Without a numeric goal
  // there is no bar to protect, so the outcome-side rule stays silent.
  if (contract) {
    const goalMetricKey = campaign.goal?.type === 'numeric' ? campaign.goal.metricKey : null;
    for (const outcome of campaign.outcomes ?? []) {
      const ev = outcome.evaluator;
      if (
        ev.type === 'threshold' &&
        typeof ev.target === 'number' &&
        goalMetricKey !== null &&
        ev.metric === goalMetricKey
      ) {
        out.push({
          code: 'placeholder_constant_in_parameterized_skill',
          dimension: 'ref',
          severity: 'error',
          detail:
            `Outcome '${outcome.id}' carries a literal numeric target (${String(ev.target)}) on the ` +
            `goal metric "${goalMetricKey}" of a campaign-contracted skill. The bar lives on the ` +
            'campaign — a literal here is a placeholder that every instance would be scored against ' +
            '(the Plan 195 §1b failure).',
          fixHint:
            'Replace with a $campaign reference, e.g. "target": { "$campaign": "<numericField>" }.',
        });
      }
    }
    for (const criterion of campaign.goalCriteria ?? []) {
      if (criterion.type === 'threshold' && typeof criterion.target === 'number') {
        out.push({
          code: 'placeholder_constant_in_parameterized_skill',
          dimension: 'eval_linkage',
          severity: 'error',
          detail:
            `Goal-tier criterion "${criterion.name}" carries a literal numeric target ` +
            `(${String(criterion.target)}) on a campaign-contracted skill. The bar lives on the ` +
            'campaign — reference it instead of baking a constant into the suite.',
          fixHint:
            'Replace with a $campaign reference, e.g. "target": { "$campaign": "<numericField>" }.',
        });
      }
    }
  }
}

// ============================================================================

function appendRunInputReachabilityDiagnostics(
  tasks: WorkflowTask[],
  runInputs: WorkflowRunInput[] | undefined,
  out: SkillDiagnostic[],
): void {
  if (!runInputs || runInputs.length === 0) return;
  const entry = tasks.find((t) => !t.dependsOn || t.dependsOn.length === 0);
  if (!entry) return;

  // Ask the runtime's own question rather than a second version of it: a slot
  // is identified by its binding's `path`, not the `bindAs` it is keyed under,
  // and a task declaring no run-input surface at all takes a catch-all that
  // accepts whatever a caller passes. Re-deriving either by hand reports a
  // skill that runs as unstartable.
  const hasContract = Object.keys(entry.inputContract?.bindings ?? {}).length > 0;
  const slots = entryRunInputSlots(entry, runInputs);
  if (slots.length === 0 && !hasContract) return;

  const reachable = new Set(slots.map((s) => s.path.split('.')[0] ?? s.path));

  for (const slot of runInputs) {
    if (reachable.has(slot.id)) continue;
    out.push({
      code: 'run_input_unreachable',
      dimension: 'graph',
      severity: slot.required ? 'error' : 'advisory',
      taskId: entry.taskId,
      detail:
        `Run input '${slot.id}' is declared on the workflow but no run_input binding on entry ` +
        `task '${entry.taskId}' reads it, so a caller passing it is refused with UNKNOWN_BINDAS.`,
      // A REQUIRED slot that cannot be passed makes the skill un-startable,
      // which is already broken — flagging it costs no working path. An
      // optional one leaves the skill runnable without it.
      fixHint:
        `Declare inputContract.bindings['${slot.id}'] = { kind: 'run_input', bindAs: '${slot.id}', ` +
        `path: '${slot.id}', schema } on '${entry.taskId}' — including when a later task reads it.`,
    });
  }
}

function appendEntryInputCoverageDiagnostics(tasks: WorkflowTask[], out: SkillDiagnostic[]): void {
  for (const task of tasks) {
    if (task.dependsOn && task.dependsOn.length > 0) continue;
    const uncovered: string[] = [];
    for (const [bindAs, binding] of Object.entries(task.inputBindings ?? {})) {
      if (binding.kind !== 'run_input') continue;
      if (task.inputContract?.bindings?.[bindAs]?.kind === 'run_input') continue;
      uncovered.push(bindAs);
    }
    if (uncovered.length === 0) continue;
    out.push({
      code: 'entry_inputs_undeclared',
      dimension: 'graph',
      severity: 'advisory',
      taskId: task.taskId,
      detail:
        `Entry task '${task.taskId}' binds run_input slot(s) [${uncovered.join(', ')}] without ` +
        `covering them in its inputContract. The skill's typed input surface ` +
        `(firstTaskInputContract) cannot be derived for these slots, so callers only discover ` +
        `them via mid-run binding-resolution failures.`,
      fixHint:
        `Declare inputContract.bindings['<bindAs>'] = { kind: 'run_input', bindAs, path, schema } ` +
        `for each run_input binding on '${task.taskId}' (record key must equal bindAs).`,
    });
  }
}

// ============================================================================

function appendCampaignInputBindingDiagnostics(
  tasks: WorkflowTask[],
  contract: SkillCampaignContract | undefined,
  out: SkillDiagnostic[],
): void {
  for (const task of tasks) {
    for (const [bindAs, binding] of Object.entries(task.inputBindings ?? {})) {
      if (binding.kind !== 'campaign_input') continue;
      if (!contract) {
        out.push({
          code: 'campaign_input_without_contract',
          dimension: 'ref',
          severity: 'error',
          taskId: task.taskId,
          field: bindAs,
          detail:
            `Task '${task.taskId}' input "${bindAs}" binds campaign_input.${binding.path}, but ` +
            'the manifest declares no campaign contract — there is no campaign config to resolve from.',
          fixHint:
            'Declare manifest.campaign with the referenced field, or bind run_input for a per-run value.',
        });
        continue;
      }
      const head = binding.path.split('.')[0] ?? binding.path;
      if (!Object.prototype.hasOwnProperty.call(contract.fields, head)) {
        out.push({
          code: 'campaign_input_unknown_field',
          dimension: 'ref',
          severity: 'error',
          taskId: task.taskId,
          field: bindAs,
          detail:
            `Task '${task.taskId}' input "${bindAs}" binds campaign_input.${binding.path}, but the ` +
            `campaign contract declares no field "${head}" ` +
            `(declared: ${Object.keys(contract.fields).join(', ') || '(none)'}).`,
          fixHint: `Reference a declared contract field, or add "${head}" to manifest.campaign.fields.`,
        });
      }
    }
  }
}

// ============================================================================
// Optimization archetype coherence (Plan 203 §4)
// ============================================================================
//
// Runs only when `mode === 'optimization'`. The campaign-loop wiring derived
// by `assembleWorkflow` must be present + internally consistent: a campaign
// contract, a numeric goal whose metric is promoted into state AND has a
// threshold outcome (the bar), every identity field actually consumed, and —
// advisory — a side-effectful op gated behind a human approval.

function appendOptimizationArchetypeDiagnostics(
  input: SkillConfigToValidate,
  tasks: WorkflowTask[],
  out: SkillDiagnostic[],
): void {
  const contract = input.campaign?.contract;
  const goal = input.campaign?.goal;
  const outcomes = input.campaign?.outcomes ?? [];
  const stateVars = new Set((input.stateVariables ?? []).map((v) => v.variableId));

  // 1. A campaign contract is the spine of an optimization skill.
  if (!contract) {
    out.push({
      code: 'optimization_missing_campaign',
      dimension: 'graph',
      severity: 'error',
      detail:
        'Optimization-mode skill declares no campaign contract. The per-campaign config (identity + tunable fields) is what an optimization loop iterates against.',
      fixHint:
        'Author `optimization.campaign` in the task-graph draft so the assembler can derive manifest.campaign.',
    });
  }

  // 2. The goal metric must be numeric, promoted into run state, AND carry a
  //    threshold outcome (the bar). Any gap means the loop has nothing to score.
  if (goal?.type !== 'numeric') {
    out.push({
      code: 'optimization_goal_metric_unresolved',
      dimension: 'graph',
      severity: 'error',
      detail:
        'Optimization-mode skill has no numeric goal. The goal names the metric the loop optimizes (manifest.goal = { type: "numeric", metricKey, direction }).',
      fixHint: 'Author `optimization.goalMetric` so the assembler derives a numeric goal.',
    });
  } else {
    const metricKey = goal.metricKey;
    const promoted = tasks.some((t) =>
      (t.promoteOutputs ?? []).some((p) => p.toState === metricKey),
    );
    if (!stateVars.has(metricKey)) {
      out.push({
        code: 'optimization_goal_metric_unresolved',
        dimension: 'graph',
        severity: 'error',
        field: metricKey,
        detail: `Goal metric "${metricKey}" is not a declared state variable — the run result has no value to score.`,
        fixHint: `Declare a stateVariable "${metricKey}" and promote the observe task's port into it.`,
      });
    }
    if (!promoted) {
      out.push({
        code: 'optimization_goal_metric_unresolved',
        dimension: 'graph',
        severity: 'error',
        field: metricKey,
        detail: `No task promotes a value into goal metric "${metricKey}" (no promoteOutputs rule writes it). The metric never gets a value.`,
        fixHint: `Add a promoteOutputs rule on the observe task writing toState "${metricKey}".`,
      });
    }
    const hasThreshold = outcomes.some(
      (o) => o.evaluator.type === 'threshold' && o.evaluator.metric === metricKey,
    );
    if (!hasThreshold) {
      out.push({
        code: 'optimization_goal_metric_unresolved',
        dimension: 'graph',
        severity: 'error',
        field: metricKey,
        detail: `No threshold outcome targets goal metric "${metricKey}" — the campaign has no bar to clear.`,
        fixHint: `Add a threshold outcome on metric "${metricKey}" (operator + target).`,
      });
    }
  }

  // 3. Every identity campaign field must feed the loop (be consumed via a
  //    campaign_input binding) — an identity field nothing reads is dead config.
  if (contract) {
    const consumedHeads = new Set<string>();
    for (const task of tasks) {
      for (const binding of Object.values(task.inputBindings ?? {})) {
        if (binding.kind === 'campaign_input') {
          consumedHeads.add(binding.path.split('.')[0] ?? binding.path);
        }
      }
    }
    for (const [key, field] of Object.entries(contract.fields)) {
      if (field.identity === true && !consumedHeads.has(key)) {
        out.push({
          code: 'campaign_field_unbound',
          dimension: 'graph',
          severity: 'error',
          field: key,
          detail: `Identity campaign field "${key}" is never consumed by any task (no campaign_input binding reads it). An identity field that nothing reads cannot affect the run.`,
          fixHint: `Add a campaign_field consume for "${key}" on the task that needs it, or make the field non-identity.`,
        });
      }
    }
  }

  // 4. ADVISORY (§4.1): a side-effectful op with no approval gate anywhere.
  //    HITL is governance, not skill-shape — this never blocks, it nudges.
  const hasUnsafeOp = tasks.some((t) => t.type === 'operation' && t.retryability === 'unsafe');
  const hasApproveGate = tasks.some((t) => t.type === 'human' && t.intent === 'approve');
  if (hasUnsafeOp && !hasApproveGate) {
    out.push({
      code: 'optimization_side_effect_ungated',
      dimension: 'graph',
      severity: 'advisory',
      detail:
        'An unsafe (side-effectful) operation runs with no human approval gate in the workflow. Optimization loops that submit / post / mutate an external system usually gate the side effect behind an approval.',
      fixHint:
        'Add a human task (intent: "approve") upstream of the side-effectful op — or rely on op-level HITL governance once it lands.',
    });
  }
}

// ============================================================================
// Slice 4 — eval ↔ output-field linkage (dimension: eval_linkage)
// ============================================================================

function appendEvalLinkageDiagnostics(
  tasks: WorkflowTask[],
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>>,
  out: SkillDiagnostic[],
): void {
  const taskById = new Map(tasks.map((t) => [t.taskId, t] as const));
  const taskIdList = [...taskById.keys()].join(', ');

  for (const [taskId, criteria] of Object.entries(taskCriteria)) {
    const task = taskById.get(taskId);
    if (!task) {
      out.push({
        code: 'eval_unknown_task',
        dimension: 'eval_linkage',
        severity: 'advisory',
        taskId,
        detail: `Eval taskCriteria references unknown taskId '${taskId}'. Valid taskIds: ${taskIdList}.`,
      });
      continue;
    }

    const declared = taskDeclaredOutput(task);
    // No declared shape, or an OPEN shape — the field may exist at runtime, so
    // absence is unprovable. Skip (don't false-flag).
    if (!declared?.closed) continue;
    const metrics = taskDeclaredMetrics(task);

    for (const criterion of criteria) {
      let field: string;
      if (criterion.type === 'contains') {
        // Reserved fields (e.g. `summary`) resolve to a platform value, not a
        // task output — never flag them. Sourced from the runtime resolver.
        if (CONTAINS_RESERVED_FIELDS.has(criterion.inField)) continue;
        field = criterion.inField;
      } else if (criterion.type === 'threshold') {
        field = criterion.metric;
      } else {
        // trace_bound (trace metric enum), judge — no task output-field
        // binding to check.
        continue;
      }
      if (declared.fields.has(field) || metrics.has(field)) continue;
      out.push({
        code: 'eval_field_not_produced',
        dimension: 'eval_linkage',
        severity: 'advisory',
        taskId,
        field,
        detail:
          `Eval criterion "${criterion.name}" on task '${taskId}' binds to output field '${field}', but that ` +
          `task's declared output is closed and produces only: ${[...declared.fields].sort().join(', ') || '(none)'}` +
          `${metrics.size > 0 ? ` (metrics: ${[...metrics].sort().join(', ')})` : ''}. ` +
          `The grader's resolveField('${field}') returns "not found", so this criterion can never pass.`,
        fixHint:
          `Bind the criterion to one of the declared output fields` +
          (criterion.type === 'contains'
            ? ` or a reserved field (${[...CONTAINS_RESERVED_FIELDS].join(', ')})`
            : '') +
          `, or declare '${field}' in task '${taskId}'.outputContract.schema.`,
      });
    }
  }
}

/**
 * Task-criteria identities (`${taskId} ${criterionName}`) that can never
 * resolve — same checks as {@link appendEvalLinkageDiagnostics}, returned as a
 * set so the eval runner excludes them from the verdict instead of scoring a
 * false fail. Open/undeclared outputs are unprovable, so never excluded.
 */
export function selectIneligibleTaskCriteria(
  tasks: WorkflowTask[],
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>>,
): Set<string> {
  const ineligible = new Set<string>();
  const taskById = new Map(tasks.map((t) => [t.taskId, t] as const));

  for (const [taskId, criteria] of Object.entries(taskCriteria)) {
    const task = taskById.get(taskId);
    if (!task) {
      for (const c of criteria) ineligible.add(`${taskId} ${c.name}`);
      continue;
    }
    const declared = taskDeclaredOutput(task);
    if (!declared?.closed) continue;
    const metrics = taskDeclaredMetrics(task);
    for (const criterion of criteria) {
      let field: string;
      if (criterion.type === 'contains') {
        if (CONTAINS_RESERVED_FIELDS.has(criterion.inField)) continue;
        field = criterion.inField;
      } else if (criterion.type === 'threshold') {
        field = criterion.metric;
      } else {
        continue;
      }
      if (declared.fields.has(field) || metrics.has(field)) continue;
      ineligible.add(`${taskId} ${criterion.name}`);
    }
  }
  return ineligible;
}

/**
 * A task's statically-declared output field set + whether the whole-output
 * shape is CLOSED. Reuses the §5.1 primitive {@link bindingStaticSchema}
 * (whole-output resolution) rather than re-deriving — op tasks resolve from the
 * op's `outputZod`, agent/human from `outputContract.schema` / `produces[]`.
 * Returns `null` when no static shape is resolvable (undeclared / open
 * producer), the caller's signal to leave the criterion alone.
 */
export function taskDeclaredOutput(
  task: WorkflowTask,
): { fields: Set<string>; closed: boolean } | null {
  const wholeBinding: WorkflowTaskInputBinding = { kind: 'task_output', taskId: task.taskId };
  const whole = bindingStaticSchema(wholeBinding, task);
  if (whole.status !== 'known') return null;
  const fields = new Set<string>();
  const props = whole.schema['properties'];
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(props)) fields.add(key);
  }
  for (const port of task.produces ?? []) fields.add(port.key);
  return { fields, closed: whole.schema['additionalProperties'] === false };
}

/** Declared metric names a `threshold.metric` may legitimately resolve from. */
export function taskDeclaredMetrics(task: WorkflowTask): Set<string> {
  const metrics = new Set<string>();
  const declared = task.outputContract?.metrics;
  if (declared) for (const key of Object.keys(declared)) metrics.add(key);
  for (const key of task.metrics ?? []) metrics.add(key);
  return metrics;
}

// ============================================================================
// Slice 4 — manifest ref coherence (dimension: ref)
// ============================================================================

function appendRefDiagnostics(
  refs: NonNullable<SkillBundleChecks['manifestRefs']>,
  artifacts: NonNullable<SkillBundleChecks['artifacts']>,
  out: SkillDiagnostic[],
): void {
  if (
    refs.workflowSlug !== undefined &&
    artifacts.workflowSlug !== undefined &&
    refs.workflowSlug !== artifacts.workflowSlug
  ) {
    out.push({
      code: 'dangling_workflow_ref',
      dimension: 'ref',
      severity: 'error',
      detail:
        `Manifest workflowSlug '${refs.workflowSlug}' does not match the bundled workflow slug ` +
        `'${artifacts.workflowSlug}'. The manifest points at a workflow the bundle does not carry.`,
      fixHint: `Set workflowSlug to '${artifacts.workflowSlug}'.`,
    });
  }
  if (refs.evalSuiteRef !== undefined && artifacts.hasEvalSuite === false) {
    out.push({
      code: 'dangling_eval_suite_ref',
      dimension: 'ref',
      severity: 'error',
      detail: `Manifest evalSuiteRef '${refs.evalSuiteRef}' is set, but the bundle carries no eval suite.`,
      fixHint: 'Include an eval suite in the bundle, or clear evalSuiteRef.',
    });
  }
  if (refs.activationRef !== undefined && artifacts.hasActivation === false) {
    out.push({
      code: 'dangling_activation_ref',
      dimension: 'ref',
      severity: 'error',
      detail: `Manifest activationRef '${refs.activationRef}' is set, but the bundle carries no activation.`,
      fixHint: 'Include an activation in the bundle, or clear activationRef.',
    });
  }
}

// ============================================================================
// Slice 4 — capability grant well-formedness (dimension: capability)
// ============================================================================

const CAPABILITY_PLATFORM_STEP_TYPES = new Set<string>(StepTypeSchema.options);

function appendCapabilityDiagnostics(tasks: WorkflowTask[], out: SkillDiagnostic[]): void {
  for (const task of tasks) {
    const operations = task.context?.capabilities?.operations;
    if (!operations) continue;
    for (const operationId of operations) {
      const prefix = operationId.split('.')[0] ?? operationId;
      if (!CAPABILITY_PLATFORM_STEP_TYPES.has(prefix)) continue;
      if (getOperation(operationId)) continue;
      out.push({
        code: 'capability_unknown_operation',
        dimension: 'capability',
        severity: 'error',
        taskId: task.taskId,
        operationId,
        detail:
          `Task '${task.taskId}' grants platform operation '${operationId}' in ` +
          `context.capabilities.operations, but it is not in the operation registry.`,
        fixHint: 'Remove the grant or correct the operation id.',
      });
    }
  }
}

// ============================================================================
// Rendering helper (for legacy string-message call sites)
// ============================================================================

export function renderSkillDiagnostics(diagnostics: readonly SkillDiagnostic[]): string {
  return diagnostics.map((d) => `[${d.code}] ${d.detail}`).join('\n');
}
