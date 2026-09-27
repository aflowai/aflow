import type {
  Workflow,
  CyberneticEvalSuite,
  CampaignContractField,
  EvalCriterion,
  SkillDiagnostic,
  StagedChangeOp,
  SkillManifest,
} from '@aflow/schemas';
import { WorkflowSchema, CyberneticEvalSuiteSchema, SkillManifestSchema } from '@aflow/schemas';
import {
  materializeAndValidateSkillConfig,
  validateCampaignParameterization,
  type SkillCampaignManifestParams,
} from '../skillValidity/skillValidity.js';

// ============================================================================
// Types
// ============================================================================

export interface ApplyOpsInput {
  /** Workflow snapshot at pinnedRevision. `null` for eval-only proposals. */
  workflow: Workflow | null;
  /** Eval suites keyed by skill slug. Empty Map if no eval ops. */
  evalSuites: Map<string, CyberneticEvalSuite>;
  /** Set of valid workflow task IDs — used to validate task-scoped eval ops. */
  workflowTaskIds?: Set<string>;
  ops: readonly StagedChangeOp[];
  /** Slug of the workflow being mutated (used by eval ops that omit `skillSlug`). */
  targetSlug?: string;
  /**
   * The skill's manifest snapshot — required when manifest ops (`update_goal`,
   * `campaign.field.*`) are present. The effective campaign (contract + goal)
   * used to validate the workflow/evals is derived from the POST-edit manifest,
   * so a manifest edit and the workflow are always checked together.
   */
  manifest?: SkillManifest | null;
  campaign?: SkillCampaignManifestParams;
  /**
   * Who is applying these ops, derived from the enclosing `StagedChange.source`.
   * Stamps added eval criteria and enforces ownership: a `'coach'` apply may not
   * update/remove an operator-authored criterion. Absent ⇒ `'coach'`.
   */
  source?: 'coach' | 'operator';
}

export type ApplyOpsResult =
  | {
      ok: true;
      candidateWorkflow: Workflow | null;
      candidateEvalSuites: Map<string, CyberneticEvalSuite>;
      /** The post-edit manifest when manifest ops were applied; else null. */
      candidateManifest: SkillManifest | null;
      manifestChanged: boolean;
      appliedOps: string[];
      skippedOps: string[];
    }
  | {
      ok: false;
      failureCode: string;
      failureDetail: string;
      failedOpIndex?: number;
      diagnostics?: SkillDiagnostic[];
    };

/** Empty suite (schema defaults) for the eval-birth path. */
function createEmptyEvalSuite(): CyberneticEvalSuite {
  const now = new Date().toISOString();
  return CyberneticEvalSuiteSchema.parse({
    createdAt: now,
    updatedAt: now,
    createdBy: 'coach',
  });
}

// ============================================================================
// Entry — pure transform
// ============================================================================

/**
 * Apply ops to the supplied snapshots and return the candidate state.
 *
 * On success, the returned `candidateWorkflow` has a bumped `revision`
 * and refreshed `updatedAt`, post-validation has been run, and graph
 * integrity holds. On failure, returns a structured `failureCode` +
 * `failureDetail`; no further I/O happens at the call site.
 */
export function applyOpsToSnapshot(input: ApplyOpsInput): ApplyOpsResult {
  const ops = input.ops;
  const appliedOps: string[] = [];
  const skippedOps: string[] = [];

  // Partition ops by target artifact.
  const workflowOps: StagedChangeOp[] = [];
  const evalOps: StagedChangeOp[] = [];
  const manifestOps: StagedChangeOp[] = [];
  const noOpKinds = new Set(['platform_issue', 'flag_pattern', 'amend_directives']);

  for (const op of ops) {
    if (noOpKinds.has(op.op)) {
      skippedOps.push(op.op);
      continue;
    }
    if (op.op.startsWith('eval.criterion.')) {
      evalOps.push(op);
    } else if (op.op === 'update_goal' || op.op.startsWith('campaign.field.')) {
      manifestOps.push(op);
    } else {
      workflowOps.push(op);
    }
  }

  // Structural copy of workflow to keep input snapshot pristine. Eval suites
  // get a JSON deep-copy each, since we may mutate goalCriteria / taskCriteria
  // arrays.
  let candidateWorkflow: Workflow | null = input.workflow
    ? (JSON.parse(JSON.stringify(input.workflow)) as Workflow)
    : null;
  const candidateEvalSuites = new Map<string, CyberneticEvalSuite>();
  for (const [slug, suite] of input.evalSuites) {
    candidateEvalSuites.set(slug, JSON.parse(JSON.stringify(suite)) as CyberneticEvalSuite);
  }

  // Apply manifest ops FIRST — the effective campaign used to validate the
  // workflow + evals is derived from the post-edit manifest, so a manifest edit
  // and the workflow it parameterizes are always checked together.
  let candidateManifest: SkillManifest | null = input.manifest
    ? (JSON.parse(JSON.stringify(input.manifest)) as SkillManifest)
    : null;
  let manifestChanged = false;
  if (manifestOps.length > 0) {
    if (!candidateManifest) {
      const firstOp = manifestOps[0];
      return {
        ok: false,
        failureCode: 'target_skill_missing',
        failureDetail: `Manifest snapshot is null but ${String(manifestOps.length)} manifest op(s) were supplied.`,
        ...(firstOp ? { failedOpIndex: ops.indexOf(firstOp) } : {}),
      };
    }
    for (const op of manifestOps) {
      try {
        applyManifestOp(candidateManifest, op);
        appliedOps.push(op.op);
        manifestChanged = true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          failureCode: deriveOpFailureCode(op),
          failureDetail: detail,
          failedOpIndex: ops.indexOf(op),
        };
      }
    }
    // Stamp updatedAt so ratified manifest edits match the operator direct-edit
    // authority (applySkillSurfacePatch), which freshens it for the same fields.
    candidateManifest.updatedAt = new Date().toISOString();
    const parsed = SkillManifestSchema.safeParse(candidateManifest);
    if (!parsed.success) {
      return {
        ok: false,
        failureCode: 'manifest_post_validation',
        failureDetail: `Mutated manifest fails schema: ${parsed.error.message}`,
      };
    }
    candidateManifest = parsed.data;
  }

  // Effective campaign params for validation — the post-edit manifest is the
  // source of truth for goal + contract when a manifest snapshot was supplied;
  // otherwise the caller's pre-derived `campaign` (no-manifest-op callers).
  const effectiveCampaign: SkillCampaignManifestParams | undefined = candidateManifest
    ? { contract: candidateManifest.campaign, goal: candidateManifest.goal }
    : input.campaign;

  // Apply workflow ops.
  if (workflowOps.length > 0) {
    if (!candidateWorkflow) {
      const firstOp = workflowOps[0];
      return {
        ok: false,
        failureCode: 'workflow_not_found',
        failureDetail: `Workflow snapshot is null but ${String(workflowOps.length)} workflow op(s) were supplied.`,
        ...(firstOp ? { failedOpIndex: ops.indexOf(firstOp) } : {}),
      };
    }
    for (const op of workflowOps) {
      try {
        applyWorkflowOp(candidateWorkflow, op);
        appliedOps.push(op.op);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          failureCode: deriveOpFailureCode(op),
          failureDetail: detail,
          failedOpIndex: ops.indexOf(op),
        };
      }
    }

    // Bump revision + updatedAt — same shape as applyRatifiedOps.
    candidateWorkflow.revision = candidateWorkflow.revision + 1;
    candidateWorkflow.updatedAt = new Date().toISOString();

    // Schema re-parse — catches op-introduced schema invariants.
    const parseResult = WorkflowSchema.safeParse(candidateWorkflow);
    if (!parseResult.success) {
      return {
        ok: false,
        failureCode: 'post_validation',
        failureDetail: `Mutated workflow fails schema: ${parseResult.error.message}`,
      };
    }
    candidateWorkflow = parseResult.data;

    const { materializedTasks, validity } = materializeAndValidateSkillConfig({
      tasks: candidateWorkflow.tasks,
      stateVariables: candidateWorkflow.stateVariables,
      runInputs: candidateWorkflow.runInputs,
      ...(effectiveCampaign
        ? { campaign: { ...effectiveCampaign, outcomes: candidateWorkflow.outcomes } }
        : {}),
    });
    candidateWorkflow.tasks = materializedTasks;
    if (validity.status === 'invalid') {
      const derivationConflict = validity.diagnostics.find((d) => d.code === 'derivation_conflict');
      if (derivationConflict) {
        return {
          ok: false,
          failureCode: 'graph_validator_failed',
          failureDetail: `Contract derivation failed: ${derivationConflict.detail}`,
          diagnostics: validity.diagnostics,
        };
      }
      const detail = validity.diagnostics.map((d) => `${d.code}: ${d.detail}`).join('; ');
      // Use the first diagnostic code as the failureCode — this is the
      const firstErr = validity.diagnostics[0];
      return {
        ok: false,
        failureCode: firstErr ? `graph_validator:${firstErr.code}` : 'graph_validator_failed',
        failureDetail: `Graph validation failed: ${detail}`,
        diagnostics: validity.diagnostics,
      };
    }
  }

  // When the manifest (goal / contract) changed, re-validate every artifact that
  // could now carry a dangling `$campaign` ref against the POST-edit contract —
  // with no revision bump or workflow write.
  if (manifestChanged && effectiveCampaign) {
    // Workflow graph + task-input refs. When workflow ops ran the graph was
    // already validated above against effectiveCampaign; re-run only otherwise.
    if (workflowOps.length === 0 && candidateWorkflow) {
      const { validity } = materializeAndValidateSkillConfig({
        tasks: candidateWorkflow.tasks,
        stateVariables: candidateWorkflow.stateVariables,
        runInputs: candidateWorkflow.runInputs,
        mode: candidateWorkflow.mode,
        campaign: { ...effectiveCampaign, outcomes: candidateWorkflow.outcomes },
      });
      if (validity.status === 'invalid') {
        const detail = validity.diagnostics.map((d) => `${d.code}: ${d.detail}`).join('; ');
        const firstErr = validity.diagnostics[0];
        return {
          ok: false,
          failureCode: firstErr ? `graph_validator:${firstErr.code}` : 'graph_validator_failed',
          failureDetail: `Skill invalid after manifest edit: ${detail}`,
          diagnostics: validity.diagnostics,
        };
      }
    }
    // Goal / outcome / eval-criterion `$campaign` refs. The graph validator never
    // sees eval criteria, and goal refs must be checked even for a workflow-less
    // (eval-only) skill — so this runs regardless of whether a workflow exists.
    const targetSuite = input.targetSlug ? candidateEvalSuites.get(input.targetSlug) : undefined;
    const refDiagnostics = validateCampaignParameterization(
      {
        ...effectiveCampaign,
        ...(candidateWorkflow ? { outcomes: candidateWorkflow.outcomes } : {}),
        ...(targetSuite
          ? {
              goalCriteria: targetSuite.goalCriteria,
              trajectoryCriteria: targetSuite.trajectoryCriteria,
            }
          : {}),
      },
      targetSuite?.taskCriteria ?? {},
    );
    const firstRefError = refDiagnostics.find((d) => d.severity === 'error');
    if (firstRefError) {
      return {
        ok: false,
        failureCode: `campaign_ref:${firstRefError.code}`,
        failureDetail: refDiagnostics.map((d) => `${d.code}: ${d.detail}`).join('; '),
        diagnostics: refDiagnostics,
      };
    }
  }

  // Apply eval ops, grouped by slug.
  if (evalOps.length > 0) {
    const bySlug = new Map<string, StagedChangeOp[]>();
    for (const op of evalOps) {
      const slug =
        'skillSlug' in op && typeof op.skillSlug === 'string'
          ? op.skillSlug
          : (input.targetSlug ?? '');
      if (!slug) {
        return {
          ok: false,
          failureCode: 'eval_slug_missing',
          failureDetail: `Eval op '${op.op}' has no skillSlug and no targetSlug fallback.`,
          failedOpIndex: ops.indexOf(op),
        };
      }
      const existing = bySlug.get(slug) ?? [];
      existing.push(op);
      bySlug.set(slug, existing);
    }

    for (const [slug, slugOps] of bySlug) {
      let suite = candidateEvalSuites.get(slug);
      if (!suite) {
        // A suite-less skill births its suite from the first criterion.add;
        // remove/update have nothing to target and stay an error.
        const hasAdd = slugOps.some((o) => o.op === 'eval.criterion.add');
        if (!hasAdd) {
          const firstOp = slugOps[0];
          return {
            ok: false,
            failureCode: 'target_skill_missing',
            failureDetail: `Eval suite not found for skill slug '${slug}'.`,
            ...(firstOp ? { failedOpIndex: ops.indexOf(firstOp) } : {}),
          };
        }
        suite = createEmptyEvalSuite();
        candidateEvalSuites.set(slug, suite);
      }
      const postApplyTaskIds = candidateWorkflow
        ? new Set(candidateWorkflow.tasks.map((t) => t.taskId))
        : input.workflowTaskIds;
      for (const op of slugOps) {
        try {
          applyEvalOp(suite, op, postApplyTaskIds, input.source ?? 'coach');
          appliedOps.push(op.op);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            failureCode:
              err instanceof EvalOwnershipError ? 'eval_operator_owned' : deriveOpFailureCode(op),
            failureDetail: detail,
            failedOpIndex: ops.indexOf(op),
          };
        }
      }

      // Post-apply: enforce name uniqueness across the entire suite.
      const nameCollisions = findDuplicateCriterionNames(suite);
      if (nameCollisions.length > 0) {
        return {
          ok: false,
          failureCode: 'eval_post_validation',
          failureDetail: `Duplicate criterion names after apply: ${nameCollisions.join(', ')}`,
        };
      }

      suite.updatedAt = new Date().toISOString();
      const parseResult = CyberneticEvalSuiteSchema.safeParse(suite);
      if (!parseResult.success) {
        return {
          ok: false,
          failureCode: 'eval_post_validation',
          failureDetail: `Mutated eval suite fails schema: ${parseResult.error.message}`,
        };
      }

      if (effectiveCampaign && slug === input.targetSlug) {
        const campaignDiagnostics = validateCampaignParameterization(
          {
            ...effectiveCampaign,
            goalCriteria: parseResult.data.goalCriteria,
            trajectoryCriteria: parseResult.data.trajectoryCriteria,
          },
          parseResult.data.taskCriteria,
        );
        const firstError = campaignDiagnostics.find((d) => d.severity === 'error');
        if (firstError) {
          return {
            ok: false,
            failureCode: `campaign_ref:${firstError.code}`,
            failureDetail: campaignDiagnostics.map((d) => `${d.code}: ${d.detail}`).join('; '),
            diagnostics: campaignDiagnostics,
          };
        }
      }
      candidateEvalSuites.set(slug, parseResult.data);
    }
  }

  return {
    ok: true,
    candidateWorkflow,
    candidateEvalSuites,
    candidateManifest,
    manifestChanged,
    appliedOps,
    skippedOps,
  };
}

// ============================================================================
// Per-op mutation (pure)
// ============================================================================

function applyWorkflowOp(workflow: Workflow, op: StagedChangeOp): void {
  switch (op.op) {
    case 'update_task_goal': {
      const task = workflow.tasks.find((t) => t.taskId === op.taskId);
      if (!task) throw new Error(`Task ${op.taskId} not found`);
      task.goal = op.newGoal;
      break;
    }

    case 'update_task_context_spec': {
      const task = workflow.tasks.find((t) => t.taskId === op.taskId);
      if (!task) throw new Error(`Task ${op.taskId} not found`);
      task.context = op.contextSpec;
      break;
    }

    case 'add_task': {
      const newTask = op.task;
      if (workflow.tasks.some((t) => t.taskId === newTask.taskId)) {
        throw new Error(`Task ${newTask.taskId} already exists`);
      }
      const hasUpstream = (newTask.dependsOn ?? []).length > 0;
      if (!hasUpstream && op.source !== true) {
        throw new Error(
          `Task '${newTask.taskId}' has no dependsOn but op.source is not set. ` +
            `Set op.source=true to acknowledge introducing a new workflow source task, ` +
            `or add upstream dependencies via dependsOn.`,
        );
      }
      if (hasUpstream && op.source === true) {
        throw new Error(
          `Task '${newTask.taskId}' has upstream dependencies but op.source=true. ` +
            `op.source is only valid when dependsOn is empty.`,
        );
      }
      const existingIds = new Set(workflow.tasks.map((t) => t.taskId));
      for (const depId of newTask.dependsOn ?? []) {
        if (!existingIds.has(depId)) {
          throw new Error(
            `Task '${newTask.taskId}' depends on '${depId}' which does not exist in the workflow.`,
          );
        }
      }
      workflow.tasks.push(newTask);
      break;
    }

    case 'replace_task': {
      const idx = workflow.tasks.findIndex((t) => t.taskId === op.taskId);
      if (idx === -1) throw new Error(`Task ${op.taskId} not found`);
      if (op.task.taskId !== op.taskId) {
        throw new Error(
          `replace_task cannot change taskId from '${op.taskId}' to '${op.task.taskId}'.`,
        );
      }
      workflow.tasks[idx] = op.task;
      break;
    }

    case 'remove_task': {
      const idx = workflow.tasks.findIndex((t) => t.taskId === op.taskId);
      if (idx === -1) throw new Error(`Task ${op.taskId} not found`);
      workflow.tasks.splice(idx, 1);
      break;
    }

    case 'reorder_tasks': {
      const reordered: typeof workflow.tasks = [];
      for (const tid of op.taskIds) {
        const task = workflow.tasks.find((t) => t.taskId === tid);
        if (!task) throw new Error(`Task ${tid} not found during reorder`);
        reordered.push(task);
      }
      for (const task of workflow.tasks) {
        if (!op.taskIds.includes(task.taskId)) {
          reordered.push(task);
        }
      }
      workflow.tasks = reordered;
      break;
    }

    case 'update_task_dependencies': {
      const task = workflow.tasks.find((t) => t.taskId === op.taskId);
      if (!task) throw new Error(`Task ${op.taskId} not found`);
      const newDeps = op.dependsOn;
      if (newDeps.length === 0 && op.source !== true) {
        throw new Error(
          `update_task_dependencies on '${op.taskId}' would clear dependsOn. ` +
            `Set op.source=true to acknowledge promoting this task to a workflow source.`,
        );
      }
      if (newDeps.length > 0 && op.source === true) {
        throw new Error(
          `update_task_dependencies on '${op.taskId}' has non-empty dependsOn but op.source=true. ` +
            `op.source is only valid when dependsOn is empty.`,
        );
      }
      const existingIds = new Set(workflow.tasks.map((t) => t.taskId));
      for (const depId of newDeps) {
        if (depId === op.taskId) {
          throw new Error(`Task '${op.taskId}' cannot depend on itself.`);
        }
        if (!existingIds.has(depId)) {
          throw new Error(
            `Task '${op.taskId}' would depend on '${depId}' which does not exist in the workflow.`,
          );
        }
      }
      if (newDeps.length > 0) {
        task.dependsOn = newDeps;
      } else {
        delete task.dependsOn;
      }
      break;
    }

    case 'update_outcome_threshold': {
      const outcome = workflow.outcomes.find((o) => o.id === op.outcomeId);
      if (!outcome) throw new Error(`Outcome ${op.outcomeId} not found`);
      (outcome.evaluator as Record<string, unknown>)['target'] = op.newTarget;
      break;
    }

    case 'update_activation_hint': {
      if (!workflow.activation) {
        (workflow as Record<string, unknown>)['activation'] = {
          triggerPatterns: [],
          activationHint: op.newHint,
        };
      } else {
        (workflow.activation as Record<string, unknown>)['activationHint'] = op.newHint;
      }
      break;
    }

    case 'add_trigger_pattern': {
      if (!workflow.activation) {
        (workflow as Record<string, unknown>)['activation'] = {
          triggerPatterns: [op.pattern],
          activationHint: '',
        };
      } else {
        workflow.activation.triggerPatterns.push(op.pattern);
      }
      break;
    }

    case 'update_iteration_policy': {
      const iter = workflow.iteration as Record<string, unknown>;
      if (op.maxConsecutiveRuns !== undefined) iter['maxConsecutiveRuns'] = op.maxConsecutiveRuns;
      if (op.cooldownMs !== undefined) iter['cooldownMs'] = op.cooldownMs;
      if (op.stopOnOutcomesMet !== undefined) iter['stopOnOutcomesMet'] = op.stopOnOutcomesMet;
      break;
    }

    case 'update_workflow_contract': {
      if (op.stateVariables !== undefined) {
        workflow.stateVariables = op.stateVariables;
      }
      if (op.output !== undefined) {
        if (op.output === null) {
          delete workflow.output;
        } else {
          workflow.output = op.output;
        }
      }
      break;
    }

    case 'promote_context_strategy': {
      const task = workflow.tasks.find((t) => t.taskId === op.taskId);
      if (!task) throw new Error(`Task ${op.taskId} not found`);
      task.context = op.newSpec;
      break;
    }

    case 'block_workflow': {
      workflow.status = 'abandoned' as typeof workflow.status;
      (workflow as Record<string, unknown>)['blockReason'] = op.reason;
      break;
    }

    case 'unblock_workflow': {
      workflow.status = 'approved';
      delete (workflow as Record<string, unknown>)['blockReason'];
      break;
    }

    case 'platform_issue':
    case 'skill_compose':
    case 'flag_pattern':
    case 'amend_directives':
    case 'eval.criterion.add':
    case 'eval.criterion.remove':
    case 'eval.criterion.update':
    case 'capability.definition.upsert':
    case 'capability.binding.remove':
    case 'store_install':
    case 'update_artifact':
    case 'update_goal':
    case 'campaign.field.add':
    case 'campaign.field.update':
    case 'campaign.field.remove':
    case 'eval_case_draft':
      // A drafted case is not a change to the workflow snapshot — it lands on
      // the golden dataset through its own write path, which is where the
      // authoring gate lives.
      throw new Error('Non-workflow op staged for workflow apply (internal error)');

    default: {
      const u: never = op;
      throw new Error(`Exhaustive switch gap (workflow): ${String(u)}`);
    }
  }
}

/** Key-order-independent JSON for comparing two field value-domains. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The frozen part of an identity field — everything but label/description. */
function frozenIdentityShape(field: CampaignContractField): string {
  return canonicalJson({ schema: field.schema, mutable: field.mutable ?? false });
}

type ManifestChangeOp = Extract<
  StagedChangeOp,
  | { op: 'update_goal' }
  | { op: 'campaign.field.add' }
  | { op: 'campaign.field.update' }
  | { op: 'campaign.field.remove' }
>;

/**
 * Apply a single manifest op (mutates `manifest.goal` / `manifest.campaign`).
 * Whole-contract invariants (≥1 field, identity/mutable, key regex) are checked
 * by the caller via `SkillManifestSchema.safeParse` on the candidate.
 */
function applyManifestOp(manifest: SkillManifest, op: StagedChangeOp): void {
  if (op.op !== 'update_goal' && !op.op.startsWith('campaign.field.')) {
    throw new Error(`Non-manifest op '${op.op}' staged for manifest apply (internal error)`);
  }
  const manifestOp = op as ManifestChangeOp;
  switch (manifestOp.op) {
    case 'update_goal':
      manifest.goal = manifestOp.goal;
      return;
    case 'campaign.field.add': {
      if (manifest.campaign?.fields[manifestOp.fieldKey])
        throw new Error(`Campaign field '${manifestOp.fieldKey}' already exists`);
      manifest.campaign = {
        fields: { ...(manifest.campaign?.fields ?? {}), [manifestOp.fieldKey]: manifestOp.field },
      };
      return;
    }
    case 'campaign.field.update': {
      const existing = manifest.campaign?.fields[manifestOp.fieldKey];
      if (!existing) throw new Error(`Campaign field '${manifestOp.fieldKey}' not found`);
      const wasIdentity = existing.identity === true;
      // Identity defines a campaign's instance identity and is immutable —
      // flipping it is a DIFFERENT campaign. Force remove + add a new field.
      if (wasIdentity !== (manifestOp.field.identity === true))
        throw new Error(
          `Cannot change the identity flag of campaign field '${manifestOp.fieldKey}' — remove it and add a new field instead`,
        );
      // An identity field's value-domain (schema) and mutability are frozen too —
      // only its operator-facing label/description may change. Reshaping it is a
      // different campaign; force remove + add.
      if (wasIdentity && frozenIdentityShape(existing) !== frozenIdentityShape(manifestOp.field))
        throw new Error(
          `Cannot reshape identity field '${manifestOp.fieldKey}' (only its label/description may change) — remove it and add a new field instead`,
        );
      manifest.campaign = {
        fields: { ...(manifest.campaign?.fields ?? {}), [manifestOp.fieldKey]: manifestOp.field },
      };
      return;
    }
    case 'campaign.field.remove': {
      if (!manifest.campaign?.fields[manifestOp.fieldKey])
        throw new Error(`Campaign field '${manifestOp.fieldKey}' not found`);
      const next = { ...manifest.campaign.fields };
      delete next[manifestOp.fieldKey];
      // Last field removed ⇒ config-less skill (the contract rejects 0 fields).
      if (Object.keys(next).length > 0) manifest.campaign = { fields: next };
      else delete manifest.campaign;
      return;
    }
    default: {
      const u: never = manifestOp;
      throw new Error(`Exhaustive switch gap (manifest): ${String(u)}`);
    }
  }
}

type EvalCriterionChangeOp = Extract<
  StagedChangeOp,
  { op: 'eval.criterion.add' } | { op: 'eval.criterion.remove' } | { op: 'eval.criterion.update' }
>;

/**
 * Apply a single eval op to an in-memory CyberneticEvalSuite (mutable).
 * Throws on failure; caller maps to structured failure.
 */
function applyEvalOp(
  suite: CyberneticEvalSuite,
  op: StagedChangeOp,
  validWorkflowTaskIds: Set<string> | undefined,
  source: 'coach' | 'operator',
): void {
  if (!op.op.startsWith('eval.criterion.')) {
    throw new Error(`Non-eval op '${op.op}' staged for eval apply (internal error)`);
  }
  const evalOp = op as EvalCriterionChangeOp;
  switch (evalOp.op) {
    case 'eval.criterion.add': {
      if (evalOp.replacedCriterionId) {
        assertNotOperatorOwned(suite, evalOp.replacedCriterionId, source);
        const removed = removeCriterionByName(suite, evalOp.replacedCriterionId);
        if (!removed) {
          throw new Error(
            `Replacement target '${evalOp.replacedCriterionId}' not found in eval suite`,
          );
        }
      }
      // `source` is apply-owned, never trusted from the op payload — otherwise a
      // Coach proposal could mint an operator-owned (gate-protected) criterion.
      // Clone so we never mutate the caller's op, then set source deterministically.
      const criterion = { ...(evalOp.criterion as EvalCriterion) };
      if (source === 'operator') criterion.source = 'operator';
      else delete criterion.source;
      // `targetScope` has a Zod default of `'goal'`. Schema-parsed ops
      // always carry a value, but some unit-test callers bypass the
      // schema and pass raw op objects — keep the runtime fallback so
      // those paths don't break.
      const targetScope = evalOp.targetScope ?? 'goal';
      if (targetScope === 'goal') {
        suite.goalCriteria.push(criterion);
      } else if (targetScope === 'trajectory') {
        suite.trajectoryCriteria.push(criterion);
      } else {
        const taskId = evalOp.taskId;
        if (!taskId) {
          throw new Error('taskId is required for eval.criterion.add with targetScope="task"');
        }
        if (!validWorkflowTaskIds?.has(taskId)) {
          const valid = validWorkflowTaskIds ? [...validWorkflowTaskIds].join(', ') : 'none';
          throw new Error(
            `Task-scoped eval criterion references unknown taskId '${taskId}'. Valid taskIds: ${valid}`,
          );
        }
        if (!suite.taskCriteria[taskId]) {
          suite.taskCriteria[taskId] = [];
        }
        suite.taskCriteria[taskId].push(criterion);
      }
      break;
    }

    case 'eval.criterion.remove': {
      assertNotOperatorOwned(suite, evalOp.criterionId, source);
      const removed = removeCriterionByName(suite, evalOp.criterionId);
      if (!removed) {
        throw new Error(`Criterion '${evalOp.criterionId}' not found in eval suite`);
      }
      break;
    }

    case 'eval.criterion.update': {
      assertNotOperatorOwned(suite, evalOp.criterionId, source);
      // Strip any payload `source`; an operator mutation transfers ownership
      // (operator-touched ⇒ operator-owned), a coach one leaves it untouched.
      const { source: _ignored, ...rest } = evalOp.patch;
      void _ignored;
      const patch = source === 'operator' ? { ...rest, source: 'operator' } : rest;
      const updated = updateCriterionByName(suite, evalOp.criterionId, patch);
      if (!updated) {
        throw new Error(`Criterion '${evalOp.criterionId}' not found in eval suite`);
      }
      break;
    }
  }
}

/**
 * A `'coach'` apply may not mutate an operator-authored criterion (the operator
 * is sovereign over their own checks). The Coach re-routes such a change to a
 * proposal instead of clobbering. An `'operator'` apply may target anything.
 */
class EvalOwnershipError extends Error {}

function assertNotOperatorOwned(
  suite: CyberneticEvalSuite,
  name: string,
  source: 'coach' | 'operator',
): void {
  if (source === 'operator') return;
  const target = findCriterionByName(suite, name);
  if (target?.source === 'operator') {
    throw new EvalOwnershipError(
      `Criterion '${name}' is operator-authored and cannot be changed by the Coach. Propose the change instead.`,
    );
  }
}

function findCriterionByName(suite: CyberneticEvalSuite, name: string): EvalCriterion | undefined {
  return [
    ...suite.goalCriteria,
    ...suite.trajectoryCriteria,
    ...Object.values(suite.taskCriteria).flat(),
  ].find((c) => c.name === name);
}

// ============================================================================
// Internal helpers (pure)
// ============================================================================

function removeCriterionByName(suite: CyberneticEvalSuite, name: string): boolean {
  let found = false;
  const goalIdx = suite.goalCriteria.findIndex((c) => c.name === name);
  if (goalIdx !== -1) {
    suite.goalCriteria.splice(goalIdx, 1);
    found = true;
  }
  const trajIdx = suite.trajectoryCriteria.findIndex((c) => c.name === name);
  if (trajIdx !== -1) {
    suite.trajectoryCriteria.splice(trajIdx, 1);
    found = true;
  }
  for (const taskId of Object.keys(suite.taskCriteria)) {
    const arr = suite.taskCriteria[taskId];
    if (!arr) continue;
    const idx = arr.findIndex((c) => c.name === name);
    if (idx !== -1) {
      arr.splice(idx, 1);
      found = true;
    }
  }
  return found;
}

function updateCriterionByName(
  suite: CyberneticEvalSuite,
  name: string,
  patch: Record<string, unknown>,
): boolean {
  const allArrays: EvalCriterion[][] = [
    suite.goalCriteria,
    suite.trajectoryCriteria,
    ...Object.values(suite.taskCriteria),
  ];
  for (const arr of allArrays) {
    const criterion = arr.find((c) => c.name === name);
    if (criterion) {
      Object.assign(criterion, patch);
      return true;
    }
  }
  return false;
}

function findDuplicateCriterionNames(suite: CyberneticEvalSuite): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const allCriteria: EvalCriterion[] = [
    ...suite.goalCriteria,
    ...suite.trajectoryCriteria,
    ...Object.values(suite.taskCriteria).flat(),
  ];
  for (const c of allCriteria) {
    if (seen.has(c.name)) duplicates.add(c.name);
    seen.add(c.name);
  }
  return [...duplicates];
}

/**
 * Derive a stable failure code for the given op. Mirrors the
 * `RatificationApplyReason` codes that `applyRatifiedOps` uses, so
 * downstream telemetry can compare preview failures against apply failures
 * apples-to-apples.
 */
function deriveOpFailureCode(op: StagedChangeOp): string {
  switch (op.op) {
    case 'update_task_goal':
    case 'update_task_context_spec':
    case 'update_task_dependencies':
    case 'replace_task':
    case 'remove_task':
    case 'reorder_tasks':
    case 'promote_context_strategy':
    case 'update_outcome_threshold':
      return 'target_missing';
    case 'eval.criterion.remove':
    case 'eval.criterion.update':
      return 'eval_target_missing';
    case 'eval.criterion.add':
    case 'add_task':
    case 'update_activation_hint':
    case 'add_trigger_pattern':
    case 'update_iteration_policy':
    case 'update_workflow_contract':
    case 'flag_pattern':
    case 'platform_issue':
    case 'block_workflow':
    case 'unblock_workflow':
    case 'amend_directives':
    case 'skill_compose':
    case 'capability.definition.upsert':
    case 'capability.binding.remove':
    case 'store_install':
    case 'update_artifact':
    case 'eval_case_draft':
      return 'op_apply_error';
    case 'update_goal':
    case 'campaign.field.add':
    case 'campaign.field.update':
    case 'campaign.field.remove':
      return 'manifest_apply_error';
    default: {
      const exhaustive: never = op;
      void exhaustive;
      return 'op_apply_error';
    }
  }
}
