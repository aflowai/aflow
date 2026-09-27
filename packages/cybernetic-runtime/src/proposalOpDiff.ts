/**
 * Proposal op diff: a card showing each
 * op's NEW values with no before makes "what would actually change"
 * unreadable. This derives a compact, per-op before→after view against the
 * CURRENT workflow config (what ratify would apply onto), at read time, so a
 * drifted target shows real befores (pairing with the existing rebase/stale
 * machinery rather than a propose-time snapshot).
 *
 * Pure; consumed by the proposal detail route and rendered by
 * `ProposalDiffView`.
 */
import type { SkillManifest, StagedChange, Workflow, WorkflowTask } from '@aflow/schemas';

export interface ProposalOpDiffEntry {
  field: string;
  before?: string;
  after?: string;
}

export interface ProposalOpDiff {
  /** Index into proposal.ops — the card renders ops positionally. */
  opIndex: number;
  op: string;
  taskId?: string;
  entries: ProposalOpDiffEntry[];
}

/** Display truncation for long values (goals, prompts). */
const DIFF_VALUE_MAX_CHARS = 400;

function clip(value: unknown): string {
  const s =
    typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 0);
  return s.length > DIFF_VALUE_MAX_CHARS ? `${s.slice(0, DIFF_VALUE_MAX_CHARS)}…` : s;
}

function taskSummary(task: WorkflowTask | undefined): string {
  if (!task) return '';
  const family =
    task.type ?? (task.operation ? 'operation' : task.pauseInstruction ? 'human' : 'agent');
  const target = task.operation ?? task.agent ?? '';
  return clip(`${task.taskId} (${family}${target ? `: ${target}` : ''}) — ${task.goal}`);
}

export function buildProposalOpDiffs(
  workflow: Pick<Workflow, 'tasks' | 'activation' | 'iteration' | 'outcomes'> | null,
  ops: StagedChange['proposal']['ops'],
  manifest?: Pick<SkillManifest, 'goal' | 'campaign'> | null,
): ProposalOpDiff[] {
  const taskById = new Map((workflow?.tasks ?? []).map((t) => [t.taskId, t] as const));
  const diffs: ProposalOpDiff[] = [];

  ops.forEach((op, opIndex) => {
    const o = op as Record<string, unknown>;
    const kind = typeof o['op'] === 'string' ? o['op'] : '';
    const taskId = typeof o['taskId'] === 'string' ? o['taskId'] : undefined;
    const task = taskId ? taskById.get(taskId) : undefined;
    const entries: ProposalOpDiffEntry[] = [];

    switch (kind) {
      case 'update_task_goal':
        entries.push({
          field: 'goal',
          ...(task?.goal !== undefined ? { before: clip(task.goal) } : {}),
          after: clip(o['newGoal']),
        });
        break;
      case 'update_task_context_spec':
        entries.push({
          field: 'context',
          ...(task?.context !== undefined ? { before: clip(task.context) } : {}),
          after: clip(o['contextSpec']),
        });
        break;
      case 'add_task': {
        const t = o['task'] as WorkflowTask | undefined;
        entries.push({ field: 'task', after: taskSummary(t) });
        break;
      }
      case 'remove_task':
        entries.push({
          field: 'task',
          ...(task !== undefined ? { before: taskSummary(task) } : {}),
        });
        break;
      case 'reorder_tasks':
        entries.push({
          field: 'order',
          before: clip((workflow?.tasks ?? []).map((t) => t.taskId)),
          after: clip(o['order'] ?? o['taskIds']),
        });
        break;
      case 'update_outcome_threshold': {
        const outcomeId = typeof o['outcomeId'] === 'string' ? o['outcomeId'] : undefined;
        const outcome = (workflow?.outcomes ?? []).find(
          (oc) => (oc as { id?: string }).id === outcomeId,
        ) as { evaluator?: { target?: unknown } } | undefined;
        // The threshold lives on the evaluator (OutcomeSchema.evaluator.target)
        // — the same path applyOpsToSnapshot writes (review fix).
        const current = outcome?.evaluator?.target;
        entries.push({
          field: `outcome ${outcomeId ?? ''} target`,
          ...(current !== undefined ? { before: clip(current) } : {}),
          after: clip(o['newTarget']),
        });
        break;
      }
      case 'update_task_dependencies':
        entries.push({
          field: 'dependsOn',
          ...(task !== undefined ? { before: clip(task.dependsOn ?? []) } : {}),
          after: clip(o['dependsOn']),
        });
        break;
      case 'update_activation_hint':
        entries.push({
          field: 'activation hint',
          ...(workflow?.activation?.activationHint !== undefined
            ? { before: clip(workflow.activation.activationHint) }
            : {}),
          after: clip(o['newHint']),
        });
        break;
      case 'update_iteration_policy':
        for (const key of ['maxConsecutiveRuns', 'cooldownMs', 'stopOnOutcomesMet'] as const) {
          if (o[key] !== undefined) {
            const current = (workflow?.iteration as Record<string, unknown> | undefined)?.[key];
            entries.push({
              field: key,
              ...(current !== undefined ? { before: clip(current) } : {}),
              after: clip(o[key]),
            });
          }
        }
        break;
      case 'update_goal':
        entries.push({
          field: 'goal',
          ...(manifest?.goal !== undefined ? { before: clip(manifest.goal) } : {}),
          after: clip(o['goal']),
        });
        break;
      case 'campaign.field.add': {
        const fieldKey = typeof o['fieldKey'] === 'string' ? o['fieldKey'] : '';
        entries.push({ field: `campaign field ${fieldKey}`, after: clip(o['field']) });
        break;
      }
      case 'campaign.field.update': {
        const fieldKey = typeof o['fieldKey'] === 'string' ? o['fieldKey'] : '';
        const current = manifest?.campaign?.fields[fieldKey];
        entries.push({
          field: `campaign field ${fieldKey}`,
          ...(current !== undefined ? { before: clip(current) } : {}),
          after: clip(o['field']),
        });
        break;
      }
      case 'campaign.field.remove': {
        const fieldKey = typeof o['fieldKey'] === 'string' ? o['fieldKey'] : '';
        const current = manifest?.campaign?.fields[fieldKey];
        entries.push({
          field: `campaign field ${fieldKey}`,
          ...(current !== undefined ? { before: clip(current) } : {}),
        });
        break;
      }
      default:
        // Op kinds without a current-value lookup (eval.criterion.*, flags,
        // platform_issue, …) — the card keeps its existing new-value render.
        break;
    }

    if (entries.length > 0) {
      diffs.push({ opIndex, op: kind, ...(taskId !== undefined ? { taskId } : {}), entries });
    }
  });

  return diffs;
}
