import { createHash } from 'node:crypto';
import type {
  CyberneticEvalSuite,
  EvalCriterion,
  PreconditionConflict,
  PreconditionEntry,
  SkillManifest,
  StagedChange,
  StagedChangeOp,
  TargetDescriptor,
  Workflow,
} from '@aflow/schemas';
import { TARGET_HASH_PRESENT_SENTINEL } from '@aflow/schemas';

// ============================================================================
// Canonical JSON + hashing
// ============================================================================

/**
 * Stable string form of a JSON value: object keys are sorted recursively,
 * `undefined` is treated as absent (matching JSON.stringify semantics).
 * Numbers/strings/booleans/null pass through `JSON.stringify`.
 *
 * This is the input to SHA-256 for precondition hashing — any byte-level
 * normalization happens here so the same logical subtree always produces
 * the same hash regardless of insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

// ============================================================================
// Op → descriptor mapping
// ============================================================================

/**
 * Map a StagedChangeOp to the canonical target subtree it reads-and-mutates.
 * Returns `{ kind: 'none' }` for ops that have no preconditions (purely
 * informational ops, or kinds handled by dedicated dispatchers).
 *
 * The `skillSlugForEval` parameter is the eval suite slug for eval ops.
 * For workflow proposals it is typically `proposal.targetWorkflowSlug`;
 * for eval-only proposals each op carries its own `skillSlug`.
 */
export function computeOpTargetDescriptor(
  op: StagedChangeOp,
  skillSlugForEval?: string,
): TargetDescriptor {
  switch (op.op) {
    case 'update_task_goal':
      return { kind: 'task.goal', taskId: op.taskId };
    case 'update_task_context_spec':
      return { kind: 'task.context', taskId: op.taskId };
    case 'update_task_dependencies':
      return { kind: 'task.dependencies', taskId: op.taskId };
    case 'replace_task':
      return { kind: 'task.whole', taskId: op.taskId };
    case 'promote_context_strategy':
      // Writes the same field as update_task_context_spec — same descriptor
      // so the two ops would conflict on the same task, which is correct.
      return { kind: 'task.context', taskId: op.taskId };
    case 'add_task':
      return { kind: 'task.absent', taskId: op.task.taskId };
    case 'remove_task':
      return { kind: 'task.whole', taskId: op.taskId };
    case 'reorder_tasks':
      return { kind: 'tasks.order' };
    case 'update_outcome_threshold':
      return { kind: 'outcome.threshold', outcomeId: op.outcomeId };
    case 'update_activation_hint':
      return { kind: 'activation.hint' };
    case 'add_trigger_pattern':
      return { kind: 'activation.trigger.absent', pattern: op.pattern };
    case 'update_iteration_policy':
      return { kind: 'iteration' };
    case 'update_workflow_contract':
      return { kind: 'workflow.contract' };
    case 'block_workflow':
    case 'unblock_workflow':
      return { kind: 'workflow.status' };
    case 'eval.criterion.add': {
      // Verified key: criteria are addressed by `name` in applyRatifiedOps.ts
      // (`removeCriterionByName`, `updateCriterionByName`). `op.criterion.name`
      // is the canonical key.
      const slug =
        'skillSlug' in op && typeof op.skillSlug === 'string' ? op.skillSlug : skillSlugForEval;
      if (!slug) return { kind: 'none' };
      const criterion = op.criterion as EvalCriterion;
      return {
        kind: 'eval.criterion.absent',
        skillSlug: slug,
        name: criterion.name,
        scope: op.targetScope ?? 'goal',
        ...(op.taskId ? { taskId: op.taskId } : {}),
      };
    }
    case 'eval.criterion.update':
    case 'eval.criterion.remove': {
      const slug =
        'skillSlug' in op && typeof op.skillSlug === 'string' ? op.skillSlug : skillSlugForEval;
      if (!slug) return { kind: 'none' };
      // op.criterionId carries the criterion `name` (verified — see
      // `removeCriterionByName` / `updateCriterionByName` in applyRatifiedOps.ts).
      return { kind: 'eval.criterion.byName', skillSlug: slug, name: op.criterionId };
    }
    case 'update_goal':
      return { kind: 'manifest.goal' };
    case 'campaign.field.add':
      return { kind: 'manifest.campaign.field.absent', fieldKey: op.fieldKey };
    case 'campaign.field.update':
    case 'campaign.field.remove':
      return { kind: 'manifest.campaign.field', fieldKey: op.fieldKey };
    case 'flag_pattern':
    case 'platform_issue':
    case 'amend_directives':
    case 'skill_compose':
    case 'capability.definition.upsert':
    case 'capability.binding.remove':
    case 'store_install':
    case 'update_artifact':
    case 'eval_case_draft':
      // The precondition a drafted case has to meet is the authoring gate,
      // which runs at apply against the skill revision it names — not a
      // snapshot version this proposal could pin.
      return { kind: 'none' };
    default: {
      const exhaustive: never = op;
      void exhaustive;
      return { kind: 'none' };
    }
  }
}

// ============================================================================
// Reading the target subtree
// ============================================================================

/**
 * Resolve a target descriptor against the current workflow / eval suite and
 * return the canonical hash of the subtree (or `null` for absent-target
 * sentinels — the precondition is "still absent").
 *
 * Returns `null` (with `present: false`) if the descriptor targets an
 * artifact that wasn't passed in. Callers must pass both `workflow` and the
 * relevant eval suite when those op kinds are present in the proposal.
 */
export function readTargetHash(
  descriptor: TargetDescriptor,
  artifacts: {
    workflow?: Workflow | null;
    evalSuites?: Map<string, CyberneticEvalSuite>;
    manifest?: SkillManifest | null;
  },
): { hash: string | null; present: boolean } {
  switch (descriptor.kind) {
    case 'none':
      return { hash: null, present: true };
    case 'manifest.goal': {
      if (!artifacts.manifest) return { hash: null, present: false };
      return { hash: hashCanonical(artifacts.manifest.goal), present: true };
    }
    case 'manifest.campaign.field': {
      const field = artifacts.manifest?.campaign?.fields[descriptor.fieldKey];
      if (!field) return { hash: null, present: false };
      return { hash: hashCanonical(field), present: true };
    }
    case 'manifest.campaign.field.absent': {
      if (!artifacts.manifest) return { hash: null, present: false };
      const exists = artifacts.manifest.campaign?.fields[descriptor.fieldKey] !== undefined;
      return exists
        ? { hash: TARGET_HASH_PRESENT_SENTINEL, present: true }
        : { hash: null, present: true };
    }
    case 'task.goal': {
      const task = artifacts.workflow?.tasks.find((t) => t.taskId === descriptor.taskId);
      if (!task) return { hash: null, present: false };
      return { hash: hashCanonical(task.goal), present: true };
    }
    case 'task.context': {
      const task = artifacts.workflow?.tasks.find((t) => t.taskId === descriptor.taskId);
      if (!task) return { hash: null, present: false };
      return { hash: hashCanonical(task.context ?? null), present: true };
    }
    case 'task.dependencies': {
      const task = artifacts.workflow?.tasks.find((t) => t.taskId === descriptor.taskId);
      if (!task) return { hash: null, present: false };
      return { hash: hashCanonical(task.dependsOn ?? []), present: true };
    }
    case 'task.whole': {
      const task = artifacts.workflow?.tasks.find((t) => t.taskId === descriptor.taskId);
      if (!task) return { hash: null, present: false };
      return { hash: hashCanonical(task), present: true };
    }
    case 'task.absent': {
      const exists = artifacts.workflow?.tasks.some((t) => t.taskId === descriptor.taskId) ?? false;
      // Absent-target sentinel: precondition holds iff task is still absent.
      // We model "absent" as `hash: null`; "present" as a sentinel string so
      // an equality check correctly flips to a conflict if someone added a
      // task with this id in the meantime.
      return exists
        ? { hash: TARGET_HASH_PRESENT_SENTINEL, present: true }
        : { hash: null, present: true };
    }
    case 'tasks.order': {
      if (!artifacts.workflow) return { hash: null, present: false };
      const ids = artifacts.workflow.tasks.map((t) => t.taskId);
      return { hash: hashCanonical(ids), present: true };
    }
    case 'outcome.threshold': {
      const outcome = artifacts.workflow?.outcomes.find((o) => o.id === descriptor.outcomeId);
      if (!outcome) return { hash: null, present: false };
      // Mirror applyWorkflowOp `update_outcome_threshold`: the field written
      // is `outcome.evaluator.target`. Hash the same subtree.
      const target = (outcome.evaluator as Record<string, unknown>)['target'];
      return { hash: hashCanonical(target ?? null), present: true };
    }
    case 'activation.hint': {
      const hint = artifacts.workflow?.activation?.activationHint ?? null;
      return { hash: hashCanonical(hint), present: true };
    }
    case 'activation.trigger.absent': {
      const patterns = artifacts.workflow?.activation?.triggerPatterns ?? [];
      const exists = patterns.includes(descriptor.pattern);
      return exists
        ? { hash: TARGET_HASH_PRESENT_SENTINEL, present: true }
        : { hash: null, present: true };
    }
    case 'iteration': {
      if (!artifacts.workflow) return { hash: null, present: false };
      return { hash: hashCanonical(artifacts.workflow.iteration ?? null), present: true };
    }
    case 'workflow.status': {
      if (!artifacts.workflow) return { hash: null, present: false };
      // Capture status + blockReason since `block_workflow` writes both.
      const wf = artifacts.workflow as Record<string, unknown>;
      return {
        hash: hashCanonical({ status: wf['status'], blockReason: wf['blockReason'] ?? null }),
        present: true,
      };
    }
    case 'workflow.contract': {
      if (!artifacts.workflow) return { hash: null, present: false };
      return {
        hash: hashCanonical({
          stateVariables: artifacts.workflow.stateVariables,
          output: artifacts.workflow.output ?? null,
        }),
        present: true,
      };
    }
    case 'eval.criterion.byName': {
      const suite = artifacts.evalSuites?.get(descriptor.skillSlug);
      if (!suite) return { hash: null, present: false };
      const criterion = findCriterionByName(suite, descriptor.name);
      if (!criterion) return { hash: null, present: false };
      return { hash: hashCanonical(criterion), present: true };
    }
    case 'eval.criterion.absent': {
      const suite = artifacts.evalSuites?.get(descriptor.skillSlug);
      if (!suite) return { hash: null, present: false };
      const exists = findCriterionByName(suite, descriptor.name) !== null;
      return exists
        ? { hash: TARGET_HASH_PRESENT_SENTINEL, present: true }
        : { hash: null, present: true };
    }
    default: {
      const exhaustive: never = descriptor;
      void exhaustive;
      return { hash: null, present: false };
    }
  }
}

function findCriterionByName(suite: CyberneticEvalSuite, name: string): EvalCriterion | null {
  const inGoal = suite.goalCriteria.find((c) => c.name === name);
  if (inGoal) return inGoal;
  const inTraj = suite.trajectoryCriteria.find((c) => c.name === name);
  if (inTraj) return inTraj;
  for (const taskId of Object.keys(suite.taskCriteria)) {
    const arr = suite.taskCriteria[taskId];
    if (!arr) continue;
    const hit = arr.find((c) => c.name === name);
    if (hit) return hit;
  }
  return null;
}

// ============================================================================
// Proposal-level helpers
// ============================================================================

export function computeProposalPreconditions(
  staged: Pick<StagedChange, 'kind' | 'proposal' | 'targetWorkflowSlug'>,
  artifacts: {
    workflow?: Workflow | null;
    evalSuites?: Map<string, CyberneticEvalSuite>;
    manifest?: SkillManifest | null;
  },
): PreconditionEntry[] | undefined {
  if (!isInScopeForPinning(staged.kind)) return undefined;

  const skillSlugForEval = staged.targetWorkflowSlug;
  return staged.proposal.ops.map((op, opIndex) => {
    const descriptor = computeOpTargetDescriptor(op, skillSlugForEval);
    const { hash } = readTargetHash(descriptor, artifacts);
    return { opIndex, descriptor, targetHash: hash };
  });
}

export function evaluateProposalPreconditions(
  staged: Pick<StagedChange, 'preconditions' | 'proposal'>,
  artifacts: {
    workflow?: Workflow | null;
    evalSuites?: Map<string, CyberneticEvalSuite>;
    manifest?: SkillManifest | null;
  },
): PreconditionConflict[] | null {
  const pins = staged.preconditions;
  if (!pins) return null;

  const conflicts: PreconditionConflict[] = [];
  for (const entry of pins) {
    const op = staged.proposal.ops[entry.opIndex];
    if (!op) continue;
    const { hash: currentHash } = readTargetHash(entry.descriptor, artifacts);
    if (currentHash !== entry.targetHash) {
      conflicts.push({
        opIndex: entry.opIndex,
        opKind: op.op,
        descriptor: entry.descriptor,
        pinnedHash: entry.targetHash,
        currentHash,
      });
    }
  }
  return conflicts;
}

export function isInScopeForPinning(kind: StagedChange['kind']): boolean {
  return kind === 'workflow_refinement' || kind === 'eval_criterion_change';
}

/**
 * Collect the set of skill slugs referenced by a proposal's eval ops so the
 * caller knows which eval suites to load when populating preconditions or
 * checking them at apply time.
 */
export function collectEvalSkillSlugs(
  staged: Pick<StagedChange, 'proposal' | 'targetWorkflowSlug'>,
): string[] {
  const slugs = new Set<string>();
  for (const op of staged.proposal.ops) {
    if (!op.op.startsWith('eval.criterion.')) continue;
    const slug =
      'skillSlug' in op && typeof op.skillSlug === 'string'
        ? op.skillSlug
        : staged.targetWorkflowSlug;
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}
