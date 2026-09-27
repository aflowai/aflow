/**
 * Batch rubric judging (Plan 269 P3, D8) — ADVISORY throughout: nothing in
 * this module changes a trial's deterministic verdict or any scorecard pass
 * metric. Pure decision functions live here (plan, model rule, merge); the
 * EvalBatchWorker owns the IO around `dispatchCaseRubricJudge`.
 */
import type { AIClient } from '@aflow/ai-client';
import type {
  CaseRubric,
  CyberneticEvalSuite,
  EvalBatchSubjectModel,
  EvalCaseRubricResult,
  EvalCaseTrialResults,
  EvalCaseTrialVerdict,
  JudgeCriterion,
} from '@aflow/schemas';
import { alignJudgeEntries, foldJudgeVerdict } from '@aflow/schemas';
import { EvalBatchProvenanceManifestSchema, EvalCaseTrialResultsSchema } from '@aflow/schemas';
import { callJudgeModel, type JudgeEvidence } from './judgeCall.js';
import { computeJudgeVersion } from './judgeVersion.js';

// ============================================================================
// Subject models — what the judge must never be
// ============================================================================

/**
 * The effective agent model configuration a workflow's runs execute under:
 * the space's runner default plus every per-task override. Frozen into the
 * batch provenance manifest at launch; derived identically by the production
 * suite's judge path (its analogue of the manifest).
 */
/**
 * Every model that will answer AS the subject, which the judge≠subject rule
 * then reads.
 *
 * A task naming an `agent` carries no `model` of its own — the model lives on
 * that agent's step config — so its entry has to be resolved by the caller and
 * passed in. Recording only the runner default for such a task is not a missing
 * detail: the guard compares the judge against this list, so a wrong entry
 * either blocks every judge (when it happens to equal the judge's model) or
 * lets the subject grade itself (when it does not). A desk running on one model
 * and recorded as another produced the first of those, and the rubric tier went
 * silent with an error nobody was looking at.
 */
export function deriveSubjectModels(
  workflowTasks: ReadonlyArray<{ taskId: string; model?: unknown }>,
  runnerDefaultModel: string,
  /**
   * Resolved model per agent-typed taskId. REQUIRED, with no default: a task
   * delegating to a custom agent carries no `task.model`, so an empty map
   * silently omits that agent's model from the subject set and the judge≠
   * subject guard stops seeing it. A caller with no agent tasks passes `{}`
   * knowingly; a caller that cannot resolve them must refuse instead.
   */
  agentTaskModels: Readonly<Record<string, string>>,
): EvalBatchSubjectModel[] {
  const models: EvalBatchSubjectModel[] = [{ scope: 'runner', modelRef: runnerDefaultModel }];
  for (const task of workflowTasks) {
    const resolved =
      typeof task.model === 'string' && task.model.length > 0
        ? task.model
        : agentTaskModels[task.taskId];
    if (typeof resolved === 'string' && resolved.length > 0) {
      models.push({ scope: `task:${task.taskId}`, modelRef: resolved });
    }
  }
  return models;
}

/**
 * Subject model refs from a persisted manifest, or null when the manifest
 * does not parse. Null is a REFUSAL input, never an empty allow-everything
 * list — an unparseable manifest must fail the dispatch closed
 * (`manifest_unavailable`), not silently disable the judge≠subject rule.
 */
export function subjectModelRefsFromManifest(manifestJson: unknown): string[] | null {
  const parsed = EvalBatchProvenanceManifestSchema.safeParse(manifestJson);
  return parsed.success ? parsed.data.subjectModels.map((m) => m.modelRef) : null;
}

// ============================================================================
// Judge model rule (D8): the subject must never grade itself
// ============================================================================

export type JudgeModelResolution =
  | { ok: true; model: string }
  | {
      ok: false;
      errorCode: 'judge_model_equals_subject';
      errorMessage: string;
    };

/**
 * Resolve the judge model for a rubric dispatch: criterion override first,
 * else the space's judge role model. When the resolved model equals any of
 * the subject run's agent models (from the batch provenance manifest), the
 * dispatch REFUSES with a typed error naming the knob to change — it never
 * silently picks a different model.
 */
export function resolveJudgeModelForDispatch(params: {
  criterionModel: string | undefined;
  spaceJudgeModel: string;
  subjectModelRefs: readonly string[];
}): JudgeModelResolution {
  const { criterionModel, spaceJudgeModel, subjectModelRefs } = params;
  const model = criterionModel ?? spaceJudgeModel;
  if (!subjectModelRefs.includes(model)) return { ok: true, model };

  const knob =
    criterionModel !== undefined
      ? `the criterion's judge model override ('model': '${model}')`
      : `the space judge model ('modelDefaults.judge' resolves to '${model}')`;
  return {
    ok: false,
    errorCode: 'judge_model_equals_subject',
    errorMessage:
      `Judge model '${model}' equals the subject run's agent model (batch provenance manifest). ` +
      `A model must not grade its own output — change ${knob} to a different model. ` +
      'The judge never silently picks another model.',
  };
}

// ============================================================================
// Rubric → criterion resolution
// ============================================================================

export function rubricCriterionId(rubric: CaseRubric): string {
  return rubric.kind === 'suite_criterion' ? rubric.criterionId : rubric.criterion.name;
}

/**
 * The scopeKey a rubric slot's verdicts and labels carry. Suite rubrics keep
 * their declared scope; a scope-less suite ref and a case-local criterion
 * get fixed namespace keys so same-named criteria across kinds cannot
 * collide on any (criterionId, scopeKey) identity.
 */
export function rubricScopeKey(rubric: CaseRubric): string {
  if (rubric.kind === 'suite_criterion') return rubric.scopeKey ?? 'suite';
  return 'case_local';
}

/**
 * Key of a rubric slot in the manifest's `judgeVersions` record: suite refs
 * are scope-qualified (same-named criteria across scopes hold distinct
 * versions); case-local rubrics are namespaced by revision (same-named local
 * rubrics on different cases are different judges).
 */
export function manifestJudgeVersionKey(rubric: CaseRubric, caseRevisionId: string): string {
  if (rubric.kind === 'case_local') return `${caseRevisionId}/${rubric.criterion.name}`;
  return `${rubricScopeKey(rubric)}:${rubric.criterionId}`;
}

function scopeMatches(scopeKey: string | undefined, scope: string): boolean {
  return scopeKey === undefined || scopeKey === scope;
}

/**
 * Resolve a `suite_criterion` rubric against the production suite: the judge
 * criterion with the referenced name, disambiguated by `scopeKey`
 * ('goal' | 'trajectory' | 'task:{taskId}') when present.
 */
export function resolveSuiteRubricCriterion(
  suite: CyberneticEvalSuite,
  criterionId: string,
  scopeKey: string | undefined,
): JudgeCriterion | null {
  for (const c of suite.goalCriteria) {
    if (c.type === 'judge' && c.name === criterionId && scopeMatches(scopeKey, 'goal')) return c;
  }
  for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
    for (const c of criteria) {
      if (
        c.type === 'judge' &&
        c.name === criterionId &&
        scopeMatches(scopeKey, `task:${taskId}`)
      ) {
        return c;
      }
    }
  }
  for (const c of suite.trajectoryCriteria) {
    if (c.type === 'judge' && c.name === criterionId && scopeMatches(scopeKey, 'trajectory')) {
      return c;
    }
  }
  return null;
}

// ============================================================================
// Per-trial rubric plan
// ============================================================================

/** Matches `EvalCaseRubricResultSchema`'s cap; the producer trims to it. */
const JUDGE_ERROR_MESSAGE_MAX_CHARS = 2000;

export type TrialRubricPlanEntry =
  | { action: 'judge'; criterionId: string; scopeKey: string; criterion: JudgeCriterion }
  | { action: 'skipped_run_error'; criterionId: string; scopeKey: string }
  | { action: 'not_selected'; criterionId: string; scopeKey: string }
  | { action: 'unresolved'; criterionId: string; scopeKey: string; detail: string };

/**
 * Decide, per rubric slot, what the judge stage does for one trial:
 *
 * - A trial that ERRORED is skipped: there is no answer to read.
 * - A trial that FAILED a deterministic check is judged like any other. The
 *   judge is advisory and cannot promote a fail, so this costs a verdict
 *   nothing; and a failure is where the second reading earns most, because a
 *   deterministic check that fires on a correct answer looks identical to a
 *   correct check firing on a wrong one until something else reads the reply.
 * - A `suite_criterion` rubric inherits the suite's `judgeSamplingRate`;
 *   sampled-out slots are recorded `not_selected`, never silent.
 *   `case_local` rubrics are always dispatched.
 */
export function planTrialRubricJudges(params: {
  rubrics: readonly CaseRubric[];
  suite: CyberneticEvalSuite | null;
  deterministicVerdict: EvalCaseTrialVerdict;
  random?: () => number;
}): TrialRubricPlanEntry[] {
  const { rubrics, suite, deterministicVerdict } = params;
  const random = params.random ?? Math.random;

  return rubrics.map((rubric): TrialRubricPlanEntry => {
    const criterionId = rubricCriterionId(rubric);
    const scopeKey = rubricScopeKey(rubric);
    if (deterministicVerdict === 'error') {
      return { action: 'skipped_run_error', criterionId, scopeKey };
    }
    if (rubric.kind === 'case_local') {
      return { action: 'judge', criterionId, scopeKey, criterion: rubric.criterion };
    }
    if (suite === null) {
      return {
        action: 'unresolved',
        criterionId,
        scopeKey,
        detail: `No production eval suite exists to resolve suite criterion '${rubric.criterionId}'.`,
      };
    }
    const criterion = resolveSuiteRubricCriterion(suite, rubric.criterionId, rubric.scopeKey);
    if (criterion === null) {
      return {
        action: 'unresolved',
        criterionId,
        scopeKey,
        detail:
          `Suite criterion '${rubric.criterionId}'` +
          (rubric.scopeKey !== undefined ? ` (scope '${rubric.scopeKey}')` : '') +
          ' is not a judge criterion in the production suite.',
      };
    }
    const rate = suite.judgeSamplingRate ?? 1;
    if (random() >= rate) {
      return { action: 'not_selected', criterionId, scopeKey };
    }
    return { action: 'judge', criterionId, scopeKey, criterion };
  });
}

// ============================================================================
// Dispatch (IO — worker-called)
// ============================================================================

export interface CaseRubricJudgeDispatch {
  result: EvalCaseRubricResult;
  /** The dispatch's LLM spend in fractional cents; 0 on a failed dispatch. */
  costCents: number;
}

export async function dispatchCaseRubricJudge(params: {
  client: AIClient;
  model: string;
  criterionId: string;
  scopeKey: string;
  criterion: JudgeCriterion;
  evidence: JudgeEvidence;
  tenantId: string;
  runId: string;
}): Promise<CaseRubricJudgeDispatch> {
  const { client, model, criterionId, scopeKey, criterion, evidence, tenantId, runId } = params;
  const judgeVersion = computeJudgeVersion(criterion.rubric, model);
  try {
    const { verdict, costCents } = await callJudgeModel({
      client,
      model,
      criterion,
      evidence,
      tenantId,
      attributionId: runId,
    });
    const entries = alignJudgeEntries(criterion.rubric, verdict);
    const folded = foldJudgeVerdict(entries);
    return {
      result: {
        status: 'judged',
        criterionId,
        scopeKey,
        judgeVersion,
        rationale: folded.rationale,
        verdict: folded.verdict,
        score: folded.score,
        entries,
      },
      costCents,
    };
  } catch (err) {
    return {
      result: {
        status: 'error',
        criterionId,
        scopeKey,
        errorCode: 'judge_dispatch_failed',
        // Trimmed to the field's own limit: a provider's validation dump runs
        // to thousands of characters, and an over-long message would fail the
        // very row meant to record WHY the judge failed.
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(
          0,
          JUDGE_ERROR_MESSAGE_MAX_CHARS,
        ),
        judgeVersion,
      },
      costCents: 0,
    };
  }
}

// ============================================================================
// Merge — provably advisory
// ============================================================================

/**
 * Attach rubric outcomes to a trial's results. The deterministic fields
 * (`verdict` is not even an input here; `expectationResults`,
 * `fractionPassed`) pass through untouched — the merge cannot change a
 * verdict by construction. Resolved slots leave `pendingRubrics`.
 */
export function applyRubricResultsToTrialResults(
  results: EvalCaseTrialResults,
  rubricResults: readonly EvalCaseRubricResult[],
): EvalCaseTrialResults {
  const resolved = new Set(rubricResults.map((r) => r.criterionId));
  return EvalCaseTrialResultsSchema.parse({
    ...results,
    pendingRubrics: results.pendingRubrics.filter((slot) => !resolved.has(slot)),
    rubricResults: [...results.rubricResults, ...rubricResults],
  });
}

// ============================================================================
// Launch-time provenance (D9 → D5 manifest)
// ============================================================================

/**
 * The `judgeVersions` record frozen into the batch provenance manifest:
 * advisory provenance for batch comparability — the authoritative version is
 * the one carried on each persisted verdict. Keys come from
 * `manifestJudgeVersionKey`; unresolvable suite refs are omitted — the
 * grading stage records their typed error.
 */
export function deriveBatchJudgeVersions(params: {
  cases: ReadonlyArray<{ revisionId: string; rubrics: readonly CaseRubric[] }>;
  suite: CyberneticEvalSuite | null;
  spaceJudgeModel: string;
}): Record<string, string> {
  const { cases, suite, spaceJudgeModel } = params;
  const versions: Record<string, string> = {};
  for (const caseEntry of cases) {
    for (const rubric of caseEntry.rubrics) {
      const key = manifestJudgeVersionKey(rubric, caseEntry.revisionId);
      if (rubric.kind === 'case_local') {
        versions[key] = computeJudgeVersion(
          rubric.criterion.rubric,
          rubric.criterion.model ?? spaceJudgeModel,
        );
        continue;
      }
      if (suite === null) continue;
      const criterion = resolveSuiteRubricCriterion(suite, rubric.criterionId, rubric.scopeKey);
      if (criterion === null) continue;
      versions[key] = computeJudgeVersion(criterion.rubric, criterion.model ?? spaceJudgeModel);
    }
  }
  return versions;
}
