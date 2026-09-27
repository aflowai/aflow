/**
 * Workflow run result — output as a first-class citizen.
 *
 * `buildWorkflowRunResult` assembles the structured "what did this run
 * produce" block (`WorkflowRunResult` in `@aflow/schemas`) from the
 * declarations the workflow already carries — `stateVariables` +
 * `promoteOutputs` (output values), the typed skill goal + campaign bar
 * (score), threshold/pattern `outcomes` (deterministic checks), task row
 * summaries, and the terminal render task's `presentation` (artifact
 * pointer). Nothing here is a second source of truth: the only *new*
 * declarations are `workflow.output.primary` / `workflow.output.guidance`.
 *
 * One builder, three consumers (so they can never disagree):
 *   - `completeRun` → waiter wakeup envelope (`workflow.run.start` tool result)
 *   - `completeRun` → terminal `WorkflowRunUpdate` (chat surface outcome block)
 *   - `buildWorkflowRunDetail` → `workflow.run.detail` / BFF hydration
 *
 * @packageDocumentation
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  Outcome,
  TenantId,
  Workflow,
  WorkflowLearning,
  WorkflowRunResult,
  WorkflowRunResultArtifact,
  WorkflowRunResultLearnings,
  WorkflowRunResultOutcomeCheck,
  WorkflowRunResultScore,
  WorkflowStateVariable,
  WorkflowTask,
} from '@aflow/schemas';
import {
  StepOutputPresentationSchema,
  WorkflowRunResultAdvisorySchema,
  compareWithThresholdOperator,
  resolveCampaignGoal,
  resolveCampaignTargetBar,
  resolveOutcomeEvaluatorParams,
} from '@aflow/schemas';
import { resolveWorkflowForRunRevision } from '@aflow/database';
import {
  resolvePromotedRunMetrics,
  derivePrimaryScore,
  bestScoreByDirection,
  coerceNumeric,
  type PromotionTaskResult,
} from './promotion.js';
import { buildEvalTaskResultsFromRows } from './evalRunner.js';
import { getCampaignById, getCampaignScoreSeries } from './campaigns.js';
import { getRunCampaignId } from './ledger/queries.js';
import { selectActiveLearningSet, resolveActiveSetBudget } from './activeLearningSet.js';
import { loadSpaceDirectives } from './modelResolution.js';
import { resolveSkillForWorkflow } from './skill.js';
import { getCyberneticLogger } from './logger.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from './ledger/types.js';

/**
 * Storage ceilings for the promoted bag, not a style guide. A promoted value
 * is a skill's deliverable — a review summary runs to thousands of characters
 * by contract — and a cap sized to what an author imagined turned that into a
 * sentence cut in half and a truncation marker. Sized for the largest field a
 * catalog skill declares, with room.
 */
const MAX_PROMOTED_STRING_CHARS = 32_000;
/** Non-string values whose JSON exceeds this collapse to a preview string. */
const MAX_PROMOTED_VALUE_JSON_CHARS = 32_000;

function capPromotedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_PROMOTED_STRING_CHARS
      ? `${value.slice(0, MAX_PROMOTED_STRING_CHARS)}… [truncated]`
      : value;
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json.length > MAX_PROMOTED_VALUE_JSON_CHARS) {
        return `${json.slice(0, 500)}… [truncated ${String(json.length)} chars — read the task output ref for the full value]`;
      }
    } catch {
      return '[unserializable value]';
    }
  }
  return value;
}

/**
 * Sanitize a promoted run-level state bag for caller-facing surfaces:
 * variables declared `sensitive` are dropped entirely; oversized values are
 * truncated (the full values stay readable via task output refs). Returns
 * `undefined` when nothing survives — callers omit the field.
 */
export function sanitizePromotedState(
  bag: Record<string, unknown>,
  stateVariables: readonly WorkflowStateVariable[] | undefined,
): Record<string, unknown> | undefined {
  const sensitive = new Set(
    (stateVariables ?? []).filter((v) => v.sensitive).map((v) => v.variableId),
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (sensitive.has(key) || value === undefined) continue;
    out[key] = capPromotedValue(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve ONE task's declared `promoteOutputs` against its decoded result —
 * the incremental slice of `resolvePromotedRunMetrics` the harness stamps on
 * the terminal `WorkflowTaskUpdate` (`promotedState`), so the chat surface
 * shows output values live as tasks finish instead of waiting for the
 * terminal run result.
 */
export function resolveTaskPromotedState(
  taskDef: WorkflowTask,
  taskResult: PromotionTaskResult,
  stateVariables: readonly WorkflowStateVariable[] | undefined,
): Record<string, unknown> | undefined {
  if (!taskDef.promoteOutputs || taskDef.promoteOutputs.length === 0) return undefined;
  const bag = resolvePromotedRunMetrics([taskDef], [taskResult]);
  return sanitizePromotedState(bag, stateVariables);
}

/**
 * Evaluate the workflow's deterministic outcome evaluators (threshold +
 * pattern) against the promoted run-level bag. `met: null` = the referenced
 * metric is absent (e.g. a skipped branch never produced it) or a `$campaign`
 * ref could not be resolved. Manual/judge outcomes are excluded — those
 * belong to the async eval plane, not the synchronous run result.
 */
export function evaluateDeterministicOutcomes(
  outcomes: readonly Outcome[],
  bag: Record<string, unknown>,
  campaignConfig: Record<string, unknown>,
): WorkflowRunResultOutcomeCheck[] | undefined {
  const checks: WorkflowRunResultOutcomeCheck[] = [];
  for (const outcome of outcomes) {
    const ev = outcome.evaluator;
    if (ev.type === 'threshold') {
      const resolved = resolveOutcomeEvaluatorParams(outcome, campaignConfig);
      if (!resolved.ok || resolved.outcome.evaluator.type !== 'threshold') {
        checks.push({ id: outcome.id, name: outcome.name, met: null });
        continue;
      }
      const rev = resolved.outcome.evaluator;
      const value = coerceNumeric(bag[rev.metric]);
      checks.push({
        id: outcome.id,
        name: outcome.name,
        met:
          value === null
            ? null
            : compareWithThresholdOperator(value, rev.operator, rev.target, rev.targetHigh),
      });
    } else if (ev.type === 'pattern') {
      const value = bag[ev.metric];
      let met: boolean | null = null;
      const text =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : null;
      if (text !== null) {
        try {
          met = new RegExp(ev.pattern).test(text);
        } catch {
          met = null;
        }
      }
      checks.push({ id: outcome.id, name: outcome.name, met });
    }
    // manual / judge — async eval plane, not listed here.
  }
  return checks.length > 0 ? checks : undefined;
}

export interface BuildWorkflowRunResultDeps {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
}

export interface BuildWorkflowRunResultArgs {
  tenantId: string;
  run: WorkflowRunDetail;
  /** Pre-resolved (pinned-revision) workflow, when the caller has one. */
  workflow?: Workflow | null;
  /**
   * `partial` (in-flight runs): promoted output values + latest summary only —
   * cheap enough for every `workflow.run.detail` read. `full` (terminal):
   * adds score (goal + campaign), deterministic outcome checks, and the
   * rendered-artifact pointer.
   */
  scope: 'partial' | 'full';
}

const RENDER_OP_IDS = new Set(['ui.artifact.render', 'ui.surface.visualize']);

/**
 * Build the structured run result. Best-effort by design: every sub-section
 * degrades to "omitted" on failure (a result with fewer fields is still
 * better than waking the caller with nothing but a status). Returns
 * `undefined` when no section could be derived at all.
 */
export async function buildWorkflowRunResult(
  deps: BuildWorkflowRunResultDeps,
  args: BuildWorkflowRunResultArgs,
): Promise<WorkflowRunResult | undefined> {
  const { db, payloadStore } = deps;
  const { tenantId, run, scope } = args;
  const logger = getCyberneticLogger();

  let workflow: Workflow | null = args.workflow ?? null;
  if (!workflow) {
    try {
      const resolved = await resolveWorkflowForRunRevision(
        db,
        tenantId as TenantId,
        run.spaceId,
        run.workflowSlug,
        run.workflowRevision,
      );
      workflow = resolved.workflow;
    } catch {
      workflow = null;
    }
  }
  if (!workflow) return undefined;

  // ── Output values: decode only the succeeded rows that promote ──────────
  const promotingTaskIds = new Set(
    workflow.tasks
      .filter((t) => t.promoteOutputs && t.promoteOutputs.length > 0)
      .map((t) => t.taskId),
  );
  const rowsToDecode = run.tasks.filter(
    (t) => promotingTaskIds.has(t.taskId) && t.status === 'succeeded',
  );
  let taskResults: PromotionTaskResult[] = [];
  if (rowsToDecode.length > 0) {
    try {
      taskResults = await buildEvalTaskResultsFromRows(rowsToDecode, payloadStore, {
        runId: run.runId,
      });
    } catch (err) {
      logger.warn(
        `[runResult] task output decode failed for run=${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const bag = resolvePromotedRunMetrics(workflow.tasks, taskResults);
  // Sensitive variables must not leave the server through ANY caller-facing
  // section — not just `output`. Score (`value`/`targetMet`) and outcome
  // checks (`met`) would leak a sensitive metric exactly or by range, so
  // they evaluate against this filtered bag: a sensitive goal metric yields
  // no score section, and outcomes referencing it report `met: null`.
  const sensitiveIds = new Set(
    workflow.stateVariables.filter((v) => v.sensitive).map((v) => v.variableId),
  );
  const safeBag =
    sensitiveIds.size > 0
      ? Object.fromEntries(Object.entries(bag).filter(([key]) => !sensitiveIds.has(key)))
      : bag;
  const output = sanitizePromotedState(bag, workflow.stateVariables);

  // ── Summary: most recent succeeded task summary, in workflow order ──────
  const rowByTaskId = new Map(run.tasks.map((t) => [t.taskId, t]));
  let summary: string | undefined;
  for (const task of workflow.tasks) {
    const row = rowByTaskId.get(task.taskId);
    if (row?.status === 'succeeded' && row.summary) summary = row.summary;
  }

  const declaration = workflow.output;
  const primaryOutput =
    declaration?.primary && output && declaration.primary in output
      ? declaration.primary
      : undefined;

  // A declared advisory state var surfaces as the typed `advisory` field (a
  // non-mutating recommendation), read from the raw promoted bag and dropped
  // from `output` so it isn't duplicated as a deliverable.
  let advisory: ReturnType<typeof WorkflowRunResultAdvisorySchema.safeParse>['data'];
  if (declaration?.advisory && bag[declaration.advisory] !== undefined) {
    const parsed = WorkflowRunResultAdvisorySchema.safeParse(bag[declaration.advisory]);
    if (parsed.success) advisory = parsed.data;
    if (output && declaration.advisory in output) delete output[declaration.advisory];
  }

  const result: WorkflowRunResult = {
    ...(workflow.goal ? { goal: workflow.goal } : {}),
    ...(output ? { output } : {}),
    ...(primaryOutput ? { primaryOutput } : {}),
    ...(summary ? { summary } : {}),
    ...(declaration?.guidance ? { guidance: declaration.guidance } : {}),
    ...(advisory ? { advisory } : {}),
  };

  if (scope === 'full') {
    const campaign = await loadCampaignContext(db, tenantId, run.runId);
    const [score, artifact, learnings] = await Promise.all([
      buildScoreSection(deps, { tenantId, run, workflow, bag: safeBag, campaign }),
      extractArtifactSection(payloadStore, workflow.tasks, run.tasks),
      buildLearningsSection(deps, { tenantId, run, campaign }),
    ]);
    if (score) result.score = score;
    if (artifact) result.artifact = artifact;
    const outcomes = evaluateDeterministicOutcomes(workflow.outcomes, safeBag, campaign.config);
    if (outcomes) result.outcomes = outcomes;
    if (learnings) result.learnings = learnings;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

interface CampaignContext {
  campaignId: string | null;
  config: Record<string, unknown>;
}

async function loadCampaignContext(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<CampaignContext> {
  try {
    const campaignId = await getRunCampaignId(db, tenantId, runId);
    if (!campaignId) return { campaignId: null, config: {} };
    const campaign = await getCampaignById(db, tenantId, campaignId);
    return { campaignId, config: campaign?.config ?? {} };
  } catch {
    // No campaign in scope — concrete (non-$campaign) params still resolve.
    return { campaignId: null, config: {} };
  }
}

/**
 * The run's newly recorded learnings (durable in `learnings_json` before the
 * run turns terminal, so race-free at wake time) plus the compact state of
 * the active set they join — the caller vets from the envelope alone, no
 * follow-up read.
 */
async function buildLearningsSection(
  deps: BuildWorkflowRunResultDeps,
  args: { tenantId: string; run: WorkflowRunDetail; campaign: CampaignContext },
): Promise<WorkflowRunResultLearnings | null> {
  const { db } = deps;
  const { tenantId, run, campaign } = args;
  const logger = getCyberneticLogger();
  try {
    const recorded = Array.isArray(run.learningsJson)
      ? (run.learningsJson as WorkflowLearning[])
      : [];
    const items = recorded.map((l) => ({
      id: l.id,
      kind: l.kind,
      category: l.category,
      observation: l.observation,
      ...(l.recommendation ? { recommendation: l.recommendation } : {}),
      ...(l.detailRef ? { detailRef: l.detailRef } : {}),
      confidence: l.confidence,
    }));
    const directives = await loadSpaceDirectives(db, tenantId, run.spaceId);
    const budget = resolveActiveSetBudget(directives);
    const set = await selectActiveLearningSet({
      db,
      tenantId,
      spaceId: run.spaceId,
      skillSlug: run.workflowSlug,
      ...(campaign.campaignId ? { campaignId: campaign.campaignId } : {}),
      budget,
    });
    const activeSetSize = set.selected.filter((e) => e.kind !== 'trajectory').length;
    const pendingCount = set.selected.filter((e) => e.kind === 'candidate').length;
    if (items.length === 0 && activeSetSize === 0 && !set.consolidationDue) return null;
    return {
      items,
      setState: { activeSetSize, budget, pendingCount, consolidationDue: set.consolidationDue },
    };
  } catch (err) {
    logger.warn(
      `[runResult] learnings section failed for run=${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Score from the typed goal: `derivePrimaryScore` over the promoted bag,
 * target check via the campaign-resolved threshold outcome on the goal
 * metric, best-so-far over the campaign series (including this run's value,
 * which is materialized into `workflow_runs.score` only later, after eval).
 */
async function buildScoreSection(
  deps: BuildWorkflowRunResultDeps,
  args: {
    tenantId: string;
    run: WorkflowRunDetail;
    workflow: Workflow;
    bag: Record<string, unknown>;
    campaign: CampaignContext;
  },
): Promise<WorkflowRunResultScore | null> {
  const { db } = deps;
  const { tenantId, run, workflow, bag, campaign } = args;
  const logger = getCyberneticLogger();
  try {
    const skill = await resolveSkillForWorkflow(
      { db, tenantId, spaceId: run.spaceId },
      run.workflowSlug,
    );
    if (!skill) return null;

    const resolvedGoal = resolveCampaignGoal(skill.manifest, campaign.config);
    if (!resolvedGoal.ok || resolvedGoal.goal.type !== 'numeric') return null;
    const goal = resolvedGoal.goal;

    const derived = derivePrimaryScore(goal, bag);
    if (!derived) return null;

    const section: WorkflowRunResultScore = {
      metricKey: goal.metricKey,
      value: derived.score,
      direction: goal.direction,
    };

    const bar = resolveCampaignTargetBar(workflow.outcomes, goal.metricKey, campaign.config);
    if (bar) {
      section.target = bar.target;
      section.targetMet = compareWithThresholdOperator(
        derived.score,
        bar.operator,
        bar.target,
        bar.targetHigh,
      );
    }

    if (campaign.campaignId) {
      try {
        const series = await getCampaignScoreSeries(db, tenantId, campaign.campaignId);
        const best = bestScoreByDirection(
          [...series.map((p) => p.score), derived.score],
          goal.direction,
        );
        if (best !== undefined) section.bestScore = best;
      } catch {
        // Best-effort — omit bestScore.
      }
    }

    return section;
  } catch (err) {
    logger.warn(
      `[runResult] score section failed for run=${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Pointer to the run's rendered UI deliverable: the LAST succeeded
 * `ui.artifact.render` / `ui.surface.visualize` task (workflow order), read
 * from the `presentation` block its handler stamped on the stored output.
 */
async function extractArtifactSection(
  payloadStore: PayloadStore,
  definitionTasks: readonly WorkflowTask[],
  rows: readonly WorkflowTaskRow[],
): Promise<WorkflowRunResultArtifact | null> {
  const rowByTaskId = new Map(rows.map((t) => [t.taskId, t]));
  let renderRow: WorkflowTaskRow | undefined;
  for (const task of definitionTasks) {
    const row = rowByTaskId.get(task.taskId);
    if (
      row?.status === 'succeeded' &&
      row.outputRef &&
      row.operationId &&
      RENDER_OP_IDS.has(row.operationId)
    ) {
      renderRow = row;
    }
  }
  if (!renderRow?.outputRef) return null;
  try {
    const raw = await payloadStore.retrieve(renderRow.outputRef);
    if (!raw || typeof raw !== 'object') return null;
    const candidate = (raw as Record<string, unknown>)['presentation'];
    const parsed = StepOutputPresentationSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.mode !== 'rendered_inline') return null;
    const presentation = parsed.data;
    if (presentation.substrate === 'artifact') {
      return {
        taskId: renderRow.taskId,
        kind: 'artifact',
        artifactId: presentation.artifactId,
        versionId: presentation.versionId,
      };
    }
    if (presentation.substrate === 'surface') {
      return { taskId: renderRow.taskId, kind: 'surface', surfaceId: presentation.surfaceId };
    }
    return null;
  } catch {
    return null;
  }
}
