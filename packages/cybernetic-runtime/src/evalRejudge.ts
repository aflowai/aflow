/**
 * Replay-cheap re-judging (Plan 269 D9): an operator re-runs a criterion's
 * judge at its CURRENT judgeVersion over the stored evidence of already
 * labeled trials — no runs re-executed, no verdict overwritten. New verdicts
 * land in `eval_rejudge_verdicts` keyed by judgeVersion alongside the
 * batch-time records, so scorecards recompute per version and compare.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AIClient } from '@aflow/ai-client';
import type {
  CyberneticEvalSuite,
  GoldenCaseRevision,
  JudgeCriterion,
  TenantId,
} from '@aflow/schemas';
import { alignJudgeEntries, foldJudgeVerdict } from '@aflow/schemas';
import { resolveRoleModel } from '@aflow/schemas';
import { collectGradingPayloadRefs } from './evalTrialGrader.js';
import {
  getEvalBatchHead,
  getGoldenCaseRevisionsByIds,
  loadTrialRunSnapshot,
} from './evalBatchStore.js';
import {
  resolveJudgeModelForDispatch,
  resolveSuiteRubricCriterion,
  rubricCriterionId,
  rubricScopeKey,
} from './evalBatchJudge.js';
import { computeJudgeVersion } from './judgeVersion.js';
import { callJudgeModel } from './judgeCall.js';
import { checkEvidenceSatisfaction } from './judgeEvidenceSatisfaction.js';
import { buildCaseRubricJudgeEvidence, buildTrialRunRecord } from './evalJudgeEvidence.js';
import { insertRejudgeVerdict, listCaseScopedLabelsForBatches } from './evalLabelQueueStore.js';
import { collectJudgeVerdictRecords, resolveSubjectConfigGroup } from './judgeScorecardBuild.js';
import { loadSpaceDirectives } from './modelResolution.js';
import { loadEvalSuite } from './evalRunner.js';

/**
 * Hard cap on judge calls per re-judge action: the cost is
 * subjects × one generateJson, and the action REFUSES above the cap rather
 * than truncating — a silently partial replay would bias the version
 * comparison toward whichever subjects sorted first.
 */
export const REJUDGE_MAX_SUBJECTS = 50;

export interface RejudgeSubject {
  batchId: string;
  caseRevisionId: string;
  trial: number;
  runId: string;
  scopeKey: string;
}

export type RejudgeSubjectPlan =
  | {
      action: 'judge';
      subject: RejudgeSubject;
      criterion: JudgeCriterion;
      model: string;
      judgeVersion: string;
    }
  | { action: 'skip_existing'; subject: RejudgeSubject; judgeVersion: string }
  | { action: 'error'; subject: RejudgeSubject; message: string };

export function rejudgeSubjectKey(subject: {
  batchId: string;
  caseRevisionId: string;
  trial: number;
  scopeKey: string;
}): string {
  return `${subject.batchId} ${subject.caseRevisionId} ${String(subject.trial)} ${subject.scopeKey}`;
}

/**
 * Pure per-subject plan: resolve the criterion from the subject's OWN case
 * revision at the subject's OWN scope (same-named rubrics across cases or
 * scopes are different judges), enforce judge ≠ subject, derive the current
 * judgeVersion, and skip subjects that already hold a verdict at that
 * version — the replay is idempotent per (subject, judgeVersion).
 */
export function planRejudgeSubjects(params: {
  subjects: readonly RejudgeSubject[];
  revisionsById: ReadonlyMap<string, GoldenCaseRevision>;
  suite: CyberneticEvalSuite | null;
  criterionId: string;
  spaceJudgeModel: string;
  subjectModelRefs: readonly string[];
  /** `${rejudgeSubjectKey(subject)} ${judgeVersion}` keys already on record. */
  existingVerdictKeys: ReadonlySet<string>;
}): RejudgeSubjectPlan[] {
  const {
    subjects,
    revisionsById,
    suite,
    criterionId,
    spaceJudgeModel,
    subjectModelRefs,
    existingVerdictKeys,
  } = params;

  return subjects.map((subject): RejudgeSubjectPlan => {
    const revision = revisionsById.get(subject.caseRevisionId);
    if (revision === undefined) {
      return { action: 'error', subject, message: 'Golden case revision row is gone.' };
    }
    const rubric = revision.case.rubrics.find(
      (r) => rubricCriterionId(r) === criterionId && rubricScopeKey(r) === subject.scopeKey,
    );
    if (rubric === undefined) {
      return {
        action: 'error',
        subject,
        message: `Case '${revision.case.title}' has no rubric slot '${criterionId}' at scope '${subject.scopeKey}'.`,
      };
    }
    let criterion: JudgeCriterion | null;
    if (rubric.kind === 'case_local') {
      criterion = rubric.criterion;
    } else if (suite === null) {
      return {
        action: 'error',
        subject,
        message: `No production eval suite exists to resolve suite criterion '${criterionId}'.`,
      };
    } else {
      criterion = resolveSuiteRubricCriterion(suite, rubric.criterionId, rubric.scopeKey);
      if (criterion === null) {
        return {
          action: 'error',
          subject,
          message: `Suite criterion '${criterionId}' is not a judge criterion in the production suite.`,
        };
      }
    }
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: criterion.model,
      spaceJudgeModel,
      subjectModelRefs,
    });
    if (!resolution.ok) {
      return { action: 'error', subject, message: resolution.errorMessage };
    }
    const judgeVersion = computeJudgeVersion(criterion.rubric, resolution.model);
    if (existingVerdictKeys.has(`${rejudgeSubjectKey(subject)} ${judgeVersion}`)) {
      return { action: 'skip_existing', subject, judgeVersion };
    }
    return { action: 'judge', subject, criterion, model: resolution.model, judgeVersion };
  });
}

// ============================================================================
// Execution (IO)
// ============================================================================

export type RejudgeResult =
  | {
      ok: true;
      criterionId: string;
      /** Every judgeVersion the replay produced verdicts under. */
      judgeVersions: string[];
      subjects: number;
      judged: number;
      skippedExisting: number;
      errors: Array<{ caseRevisionId: string; trial: number; message: string }>;
    }
  | {
      ok: false;
      code: 'batch_not_found' | 'no_labeled_subjects' | 'too_many_subjects';
      message: string;
    };

export async function executeRejudgeForCriterion(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  batchId: string;
  criterionId: string;
  retrievePayload: (ref: string) => Promise<unknown>;
  resolveClient: (model: string) => Promise<AIClient>;
  maxSubjects?: number;
}): Promise<RejudgeResult> {
  const { db, tenantId, spaceId, batchId, criterionId } = params;
  const maxSubjects = params.maxSubjects ?? REJUDGE_MAX_SUBJECTS;

  const head = await getEvalBatchHead(db, tenantId, { spaceId, batchId });
  if (head === null) {
    return { ok: false, code: 'batch_not_found', message: `No eval batch '${batchId}'.` };
  }
  const group = await resolveSubjectConfigGroup(db, tenantId, { spaceId, head });
  if (group === null) {
    return { ok: false, code: 'batch_not_found', message: 'Batch provenance manifest unreadable.' };
  }

  const labels = await listCaseScopedLabelsForBatches(db, tenantId, {
    spaceId,
    batchIds: group.batchIds,
    criterionId,
  });
  const subjectsByKey = new Map<string, RejudgeSubject>();
  for (const label of labels) {
    if (label.batchId === null || label.caseRevisionId === null || label.trial === null) continue;
    if (label.runId.length === 0) continue;
    const subject: RejudgeSubject = {
      batchId: label.batchId,
      caseRevisionId: label.caseRevisionId,
      trial: label.trial,
      runId: label.runId,
      scopeKey: label.scopeKey,
    };
    subjectsByKey.set(rejudgeSubjectKey(subject), subject);
  }
  const subjects = [...subjectsByKey.values()];
  if (subjects.length === 0) {
    return {
      ok: false,
      code: 'no_labeled_subjects',
      message: `No labeled trials exist for criterion '${criterionId}' in this batch's subject configuration — label queue items must be submitted first.`,
    };
  }

  const revisionsById = await getGoldenCaseRevisionsByIds(db, tenantId, [
    ...new Set(subjects.map((s) => s.caseRevisionId)),
  ]);
  const needsSuite = [...revisionsById.values()].some((revision) =>
    revision.case.rubrics.some(
      (r) => r.kind === 'suite_criterion' && rubricCriterionId(r) === criterionId,
    ),
  );
  const suite = needsSuite
    ? await loadEvalSuite(db, tenantId as string, spaceId, head.workflowSlug)
    : null;
  const directives = await loadSpaceDirectives(db, tenantId as string, spaceId);

  const existingRecords = await collectJudgeVerdictRecords(db, tenantId, {
    spaceId,
    batchIds: group.batchIds,
    criterionId,
  });
  const existingVerdictKeys = new Set(
    existingRecords.map((record) => `${rejudgeSubjectKey(record)} ${record.judgeVersion}`),
  );

  const plans = planRejudgeSubjects({
    subjects,
    revisionsById,
    suite,
    criterionId,
    spaceJudgeModel: resolveRoleModel(directives?.modelDefaults, 'judge'),
    subjectModelRefs: group.subjectModels.map((m) => m.modelRef),
    existingVerdictKeys,
  });

  const toJudge = plans.filter((plan) => plan.action === 'judge');
  if (toJudge.length > maxSubjects) {
    return {
      ok: false,
      code: 'too_many_subjects',
      message:
        `Re-judging '${criterionId}' would make ${String(toJudge.length)} judge calls, above the ` +
        `${String(maxSubjects)}-call cap (REJUDGE_MAX_SUBJECTS). Re-judge a narrower batch or raise the cap.`,
    };
  }

  const errors: Array<{ caseRevisionId: string; trial: number; message: string }> = plans
    .filter((plan) => plan.action === 'error')
    .map((plan) => ({
      caseRevisionId: plan.subject.caseRevisionId,
      trial: plan.subject.trial,
      message: plan.message,
    }));
  const judgeVersions = new Set<string>();
  let judged = 0;

  // Sequential on purpose: concurrency 1 IS the concurrency bound — the cap
  // above bounds total cost, this bounds instantaneous provider pressure.
  for (const plan of toJudge) {
    const revision = revisionsById.get(plan.subject.caseRevisionId)!;
    try {
      const snapshot = await loadTrialRunSnapshot(db, tenantId, plan.subject.runId);
      if (snapshot === null) {
        errors.push({
          caseRevisionId: plan.subject.caseRevisionId,
          trial: plan.subject.trial,
          message: `Trial run '${plan.subject.runId}' is gone — its evidence cannot be rebuilt.`,
        });
        continue;
      }
      const runRecord = buildTrialRunRecord(snapshot, revision.case.trigger.campaignConfig);
      const payloads = new Map<string, unknown>();
      for (const ref of collectGradingPayloadRefs(revision.case.expectations, runRecord)) {
        try {
          payloads.set(ref, await params.retrievePayload(ref));
        } catch {
          // Same contract as batch grading: absent evidence narrows, never blocks.
        }
      }
      const evidence = await buildCaseRubricJudgeEvidence({
        goldenCase: revision.case,
        runRecord,
        payloads,
        retrievePayload: params.retrievePayload,
      });
      // The same guard the live stage applies. A replay that skipped it would
      // pay for a verdict on evidence the criterion declared it needs and this
      // trial does not carry — and a judge shown nothing about a fact reads its
      // absence as an invention, so the replayed verdict would be worse than
      // the original rather than a correction of it.
      const satisfaction = checkEvidenceSatisfaction(evidence, plan.criterion.reads);
      if (!satisfaction.satisfied) {
        errors.push({
          caseRevisionId: plan.subject.caseRevisionId,
          trial: plan.subject.trial,
          message: `This trial's evidence does not carry ${satisfaction.missing.join(' or ')}, which '${plan.criterion.name}' reads — no verdict was bought for it.`,
        });
        continue;
      }

      const client = await params.resolveClient(plan.model);
      const { verdict } = await callJudgeModel({
        client,
        model: plan.model,
        criterion: plan.criterion,
        evidence,
        tenantId: tenantId as string,
        attributionId: plan.subject.runId,
      });
      const folded = foldJudgeVerdict(alignJudgeEntries(plan.criterion.rubric, verdict));
      await insertRejudgeVerdict(db, tenantId, {
        spaceId,
        batchId: plan.subject.batchId,
        caseRevisionId: plan.subject.caseRevisionId,
        trial: plan.subject.trial,
        runId: plan.subject.runId,
        criterionId,
        scopeKey: plan.subject.scopeKey,
        judgeVersion: plan.judgeVersion,
        judgeModel: plan.model,
        verdict: folded.verdict,
        rationale: folded.rationale,
        score: String(folded.score),
      });
      judgeVersions.add(plan.judgeVersion);
      judged += 1;
    } catch (err) {
      errors.push({
        caseRevisionId: plan.subject.caseRevisionId,
        trial: plan.subject.trial,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const plan of plans) {
    if (plan.action === 'skip_existing') judgeVersions.add(plan.judgeVersion);
  }

  return {
    ok: true,
    criterionId,
    judgeVersions: [...judgeVersions].sort(),
    subjects: subjects.length,
    judged,
    skippedExisting: plans.filter((plan) => plan.action === 'skip_existing').length,
    errors,
  };
}
