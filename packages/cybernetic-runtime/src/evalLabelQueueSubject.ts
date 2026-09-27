/**
 * What a pending label-queue item must carry for a human to be able to label
 * it at all: the rubric under judgement, and the evidence the JUDGE received.
 *
 * A judge scorecard measures agreement between the judge and the human. If
 * the human labels from DIFFERENT evidence than the judge saw, the confusion
 * matrix is confounded and precision/recall/kappa stop describing the judge —
 * so this hydration composes the SAME builders the batch grading stage and
 * the offline re-judge use (`buildTrialRunRecord` → `collectGradingPayloadRefs`
 * → `buildCaseRubricJudgeEvidence`, which owns the per-artifact bound), never
 * a second projection that could drift.
 *
 * Same builders is necessary but not sufficient: the INPUTS age. An artifact
 * that no longer retrieves, or a suite rubric edited since the batch ran,
 * silently narrows or changes what the human reads. Both are counted and
 * reported rather than swallowed — a divergence the labeler cannot see is
 * the confound this hydration exists to prevent.
 *
 * It resolves the QUESTION and the MATERIAL, never the answer: no judge
 * verdict, score or rationale is read here.
 *
 * The trial run rows are looked up tenant-scoped by run id — the same read
 * the re-judge path already makes from the batch's home space — so no new
 * cross-space authorization edge appears (Plan 269 open question 0).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  CyberneticEvalSuite,
  EvalLabelQueueEvidence,
  EvalLabelQueueRubric,
  GoldenCaseRevision,
  JudgeCriterion,
  TenantId,
} from '@aflow/schemas';
import { EvalLabelQueueEvidenceSchema, resolveRoleModel } from '@aflow/schemas';
import {
  getGoldenCaseRevisionsByIds,
  loadTrialRunSnapshot,
  type TrialRunSnapshot,
} from './evalBatchStore.js';
import {
  resolveSuiteRubricCriterion,
  rubricCriterionId,
  rubricScopeKey,
} from './evalBatchJudge.js';
import { buildCaseRubricJudgeEvidence, buildTrialRunRecord } from './evalJudgeEvidence.js';
import { collectGradingPayloadRefs } from './evalTrialGrader.js';
import { computeJudgeVersion } from './judgeVersion.js';
import { loadEvalSuite } from './evalRunner.js';
import { loadSpaceDirectives } from './modelResolution.js';

/**
 * Artifact fetches in flight per item: the judge rebuilt one trial's pack
 * inside a worker, this listing rebuilds a page of them on the web tier —
 * enough parallelism to hide per-object latency, not enough to turn one
 * operator read into a burst against the payload store.
 */
const PAYLOAD_FETCH_CONCURRENCY = 4;

export interface LabelQueueSubjectRef {
  itemId: string;
  caseRevisionId: string;
  runId: string | null;
  /** Snapshotted at mint; present means the item survives its fixture space. */
  conversation?: { request: string | null; reply: string | null } | null;
  /**
   * The judge's pack as frozen at mint. Present means the item carries its own
   * evidence and nothing is rebuilt from a run that no longer exists.
   */
  frozenEvidence?: unknown;
  criterionId: string;
  scopeKey: string;
  /** Owning batch's skill — how a `suite_criterion` rubric reaches its suite. */
  workflowSlug: string | null;
  /** Judge identity the item's label gets stamped with; null when the batch recorded none. */
  judgeVersion: string | null;
}

export interface LabelQueueSubjectView {
  rubric: EvalLabelQueueRubric;
  evidence: EvalLabelQueueEvidence;
}

type PayloadFetch = (ref: string) => Promise<unknown>;

function unresolvedRubric(subject: LabelQueueSubjectRef, unresolved: string): EvalLabelQueueRubric {
  return {
    criterionId: subject.criterionId,
    scopeKey: subject.scopeKey,
    entries: [],
    unresolved,
  };
}

function rubricFromCriterion(
  subject: LabelQueueSubjectRef,
  criterion: JudgeCriterion,
  judgeVersionDrift?: string,
): EvalLabelQueueRubric {
  return {
    criterionId: subject.criterionId,
    scopeKey: subject.scopeKey,
    name: criterion.name,
    entries: [...criterion.rubric],
    ...(criterion.referenceAnswer !== undefined
      ? { referenceAnswer: criterion.referenceAnswer }
      : {}),
    ...(judgeVersionDrift !== undefined ? { judgeVersionDrift } : {}),
  };
}

/**
 * A `suite_criterion` resolves through the LIVE suite doc, which an operator
 * or the Coach edits in place, while the label this item produces is stamped
 * with the judge version frozen at grading. Recomputing the identity from
 * what was just read is the only available comparison — both minting paths
 * hash it under `criterion.model ?? spaceJudgeModel` — and a mismatch means
 * the human would answer a question the judge was never asked while the
 * label lands in the old version's confusion matrix.
 *
 * Case-local criteria load from an insert-only case revision and cannot
 * drift, so they are never checked: a mismatch there could only come from a
 * model or template change, which does not alter what the human reads.
 */
async function detectSuiteRubricDrift(
  subject: LabelQueueSubjectRef,
  criterion: JudgeCriterion,
  loadJudgeModel: () => Promise<string>,
): Promise<string | undefined> {
  if (subject.judgeVersion === null) return undefined;
  const current = computeJudgeVersion(
    criterion.rubric,
    criterion.model ?? (await loadJudgeModel()),
  );
  if (current === subject.judgeVersion) return undefined;
  return (
    `The production suite's '${subject.criterionId}' no longer matches the judge version this ` +
    'trial was graded under — its rubric, judge model or prompt template changed since the batch ' +
    'ran. The criterion below may not be the one the judge was given; dismiss rather than label ' +
    'if you cannot confirm it.'
  );
}

/**
 * Resolve the criterion the judge actually graded: the subject's OWN case
 * revision at the subject's OWN scope, suite refs through the skill's eval
 * suite — the same resolution the judge and re-judge paths perform.
 */
async function resolveSubjectRubric(
  subject: LabelQueueSubjectRef,
  revision: GoldenCaseRevision | undefined,
  loadSuite: (workflowSlug: string) => Promise<CyberneticEvalSuite | null>,
  loadJudgeModel: () => Promise<string>,
): Promise<EvalLabelQueueRubric> {
  if (revision === undefined) {
    return unresolvedRubric(subject, 'The golden case revision row is gone.');
  }
  const slot = revision.case.rubrics.find(
    (r) => rubricCriterionId(r) === subject.criterionId && rubricScopeKey(r) === subject.scopeKey,
  );
  if (slot === undefined) {
    return unresolvedRubric(
      subject,
      `Case '${revision.case.title}' has no rubric slot '${subject.criterionId}' at scope '${subject.scopeKey}'.`,
    );
  }
  if (slot.kind === 'case_local') return rubricFromCriterion(subject, slot.criterion);

  if (subject.workflowSlug === null) {
    return unresolvedRubric(
      subject,
      `Suite criterion '${subject.criterionId}' needs the batch's skill to resolve, and the batch row is gone.`,
    );
  }
  const suite = await loadSuite(subject.workflowSlug);
  if (suite === null) {
    return unresolvedRubric(
      subject,
      `No production eval suite exists for '${subject.workflowSlug}' to resolve suite criterion '${subject.criterionId}'.`,
    );
  }
  const criterion = resolveSuiteRubricCriterion(suite, slot.criterionId, slot.scopeKey);
  if (criterion === null) {
    return unresolvedRubric(
      subject,
      `Suite criterion '${subject.criterionId}' is not a judge criterion in the production suite.`,
    );
  }
  return rubricFromCriterion(
    subject,
    criterion,
    await detectSuiteRubricDrift(subject, criterion, loadJudgeModel),
  );
}

async function retrieveGradingPayloads(
  refs: readonly string[],
  retrieve: PayloadFetch,
): Promise<Map<string, unknown>> {
  const payloads = new Map<string, unknown>();
  const distinct = [...new Set(refs)];
  for (let i = 0; i < distinct.length; i += PAYLOAD_FETCH_CONCURRENCY) {
    await Promise.all(
      distinct.slice(i, i + PAYLOAD_FETCH_CONCURRENCY).map(async (ref) => {
        try {
          payloads.set(ref, await retrieve(ref));
        } catch {
          // Counted by the caller's tracker; a narrowed pack is reported, not hidden.
        }
      }),
    );
  }
  return payloads;
}

/**
 * A snapshot read that failed is NOT a reaped run — the first says come back
 * later, the second says dismiss the item — so the two travel separately.
 */
interface TrialRunLoad {
  snapshot: TrialRunSnapshot | null;
  error: string | null;
}

async function resolveSubjectEvidence(params: {
  subject: LabelQueueSubjectRef;
  revision: GoldenCaseRevision | undefined;
  run: TrialRunLoad;
  retrievePayload: PayloadFetch | undefined;
}): Promise<EvalLabelQueueEvidence> {
  const { subject, revision, run, retrievePayload } = params;
  if (subject.runId === null) {
    return {
      status: 'unavailable',
      reason: 'no_trial_run',
      detail: 'This item references no trial run — there is nothing to label; dismiss it.',
    };
  }
  if (retrievePayload === undefined) {
    return {
      status: 'unavailable',
      reason: 'payload_store_unavailable',
      detail:
        'The judge evidence is rebuilt from stored payloads; no payload store is configured on this server.',
    };
  }
  if (revision === undefined) {
    return {
      status: 'unavailable',
      reason: 'case_revision_missing',
      detail: "The golden case revision row is gone, so the judge's evidence cannot be rebuilt.",
    };
  }
  if (run.error !== null) {
    return {
      status: 'unavailable',
      reason: 'rebuild_failed',
      detail: `Trial run '${subject.runId}' could not be read (${run.error}) — the run may still exist; retry before dismissing this item.`,
    };
  }
  if (run.snapshot === null) {
    // The fixture space is gone, but the exchange was kept when the item was
    // minted — which is the material a reviewer reads. The judge's wider pack
    // cannot be rebuilt, and the item says so rather than implying parity.
    if (subject.conversation !== undefined && subject.conversation !== null) {
      return {
        status: 'available',
        taskSummaries: [],
        taskOutputs: [],
        conversation: subject.conversation,
        conversationOnly: true,
        unresolvedArtifacts: 0,
      };
    }
    return {
      status: 'unavailable',
      reason: 'run_reaped',
      detail: `The run behind this trial has been cleaned up, so there is no reply left to read. Dismiss this item.`,
    };
  }

  const unresolvedRefs = new Set<string>();
  const trackedRetrieve: PayloadFetch = async (ref) => {
    try {
      return await retrievePayload(ref);
    } catch (err) {
      unresolvedRefs.add(ref);
      throw err;
    }
  };

  const runRecord = buildTrialRunRecord(run.snapshot, revision.case.trigger.campaignConfig);
  const payloads = await retrieveGradingPayloads(
    [...collectGradingPayloadRefs(revision.case.expectations, runRecord)],
    trackedRetrieve,
  );
  const evidence = await buildCaseRubricJudgeEvidence({
    goldenCase: revision.case,
    runRecord,
    payloads,
    retrievePayload: trackedRetrieve,
  });
  return {
    status: 'available',
    taskSummaries: evidence.taskSummaries,
    taskOutputs: evidence.taskOutputs ?? [],
    conversation: {
      request: firstTextInput(revision.case.trigger.inputs),
      reply: evidence.reply ?? null,
    },
    ...(evidence.toolResults !== undefined ? { toolResults: evidence.toolResults } : {}),
    ...(evidence.referenceOutput !== undefined
      ? { referenceOutput: evidence.referenceOutput }
      : {}),
    unresolvedArtifacts: unresolvedRefs.size,
  };
}

/**
 * The message that opened the trial. A trigger carries whatever inputs the
 * case declared, so the conversational one is found by shape rather than by a
 * fixed key — a case that starts from structured input simply has none.
 */
function firstTextInput(inputs: Readonly<Record<string, unknown>>): string | null {
  for (const key of ['message', 'input', 'question', 'prompt']) {
    const value = inputs[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  for (const value of Object.values(inputs)) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Retrieval memo for ONE trial run, so the several criteria of a trial share
 * its artifacts. Failures are cached too: a ref that did not resolve for one
 * criterion will not resolve for its siblings, and re-asking would multiply
 * the round trips it already cost.
 */
function createRunScopedRetrieve(retrieve: PayloadFetch): PayloadFetch {
  const cache = new Map<string, { ok: true; value: unknown } | { ok: false }>();
  return async (ref) => {
    const cached = cache.get(ref);
    if (cached !== undefined) {
      if (cached.ok) return cached.value;
      throw new Error(`Payload '${ref}' did not resolve.`);
    }
    try {
      const value = await retrieve(ref);
      cache.set(ref, { ok: true, value });
      return value;
    } catch (err) {
      cache.set(ref, { ok: false });
      throw err;
    }
  };
}

function groupSubjectsByRun(
  subjects: readonly LabelQueueSubjectRef[],
): Map<string | null, LabelQueueSubjectRef[]> {
  const byRun = new Map<string | null, LabelQueueSubjectRef[]>();
  for (const subject of subjects) {
    const group = byRun.get(subject.runId);
    if (group === undefined) byRun.set(subject.runId, [subject]);
    else group.push(subject);
  }
  return byRun;
}

/**
 * Hydrate a page of queue items, keyed by item id. Case revisions load in one
 * query; the rest is walked one trial run at a time so a run's snapshot and
 * its artifacts are fetched once for all of that run's criteria and released
 * before the next run is touched — the judge held one trial's payloads at a
 * time and so does this, rather than a whole page's at once.
 *
 * Never throws: every failure becomes a typed marker on its item, because a
 * listing that 500s leaves the operator with no queue at all.
 */
/**
 * The pack frozen at mint, when the row carries one that still parses.
 *
 * A row written before the column existed has none, and one written by a
 * version whose shape has since changed is treated the same way: fall back to
 * the live rebuild rather than hand a reviewer a pack nobody can vouch for.
 */
function readFrozenEvidence(subject: LabelQueueSubjectRef): EvalLabelQueueEvidence | null {
  if (subject.frozenEvidence === undefined || subject.frozenEvidence === null) return null;
  const parsed = EvalLabelQueueEvidenceSchema.safeParse(subject.frozenEvidence);
  return parsed.success ? parsed.data : null;
}

export async function buildLabelQueueSubjectViews(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  subjects: readonly LabelQueueSubjectRef[];
  retrievePayload?: PayloadFetch | undefined;
}): Promise<Map<string, LabelQueueSubjectView>> {
  const { db, tenantId, spaceId, subjects, retrievePayload } = params;
  const views = new Map<string, LabelQueueSubjectView>();
  if (subjects.length === 0) return views;

  let revisionsById: ReadonlyMap<string, GoldenCaseRevision>;
  try {
    revisionsById = await getGoldenCaseRevisionsByIds(db, tenantId, [
      ...new Set(subjects.map((s) => s.caseRevisionId)),
    ]);
  } catch {
    revisionsById = new Map();
  }

  const suiteBySlug = new Map<string, CyberneticEvalSuite | null>();
  const loadSuite = async (workflowSlug: string): Promise<CyberneticEvalSuite | null> => {
    if (!suiteBySlug.has(workflowSlug)) {
      suiteBySlug.set(
        workflowSlug,
        await loadEvalSuite(db, tenantId as string, spaceId, workflowSlug),
      );
    }
    return suiteBySlug.get(workflowSlug) ?? null;
  };

  let judgeModel: string | undefined;
  const loadJudgeModel = async (): Promise<string> => {
    if (judgeModel === undefined) {
      const directives = await loadSpaceDirectives(db, tenantId as string, spaceId);
      judgeModel = resolveRoleModel(directives?.modelDefaults, 'judge');
    }
    return judgeModel;
  };

  for (const [runId, group] of groupSubjectsByRun(subjects)) {
    const run: TrialRunLoad = { snapshot: null, error: null };
    // A frozen pack needs no run, so a group that is entirely frozen reads
    // nothing — which is also the only reason the read still works at all once
    // the fixture space has been collected.
    const needsSnapshot =
      runId !== null &&
      retrievePayload !== undefined &&
      group.some(
        (subject) =>
          revisionsById.has(subject.caseRevisionId) && readFrozenEvidence(subject) === null,
      );
    if (needsSnapshot) {
      try {
        run.snapshot = await loadTrialRunSnapshot(db, tenantId, runId);
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
      }
    }
    const runScopedRetrieve =
      retrievePayload === undefined ? undefined : createRunScopedRetrieve(retrievePayload);

    for (const subject of group) {
      const revision = revisionsById.get(subject.caseRevisionId);
      let rubric: EvalLabelQueueRubric;
      try {
        rubric = await resolveSubjectRubric(subject, revision, loadSuite, loadJudgeModel);
      } catch (err) {
        rubric = unresolvedRubric(
          subject,
          `The rubric could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let evidence: EvalLabelQueueEvidence;
      const frozen = readFrozenEvidence(subject);
      if (frozen !== null) {
        views.set(subject.itemId, { rubric, evidence: frozen });
        continue;
      }
      try {
        evidence = await resolveSubjectEvidence({
          subject,
          revision,
          run,
          retrievePayload: runScopedRetrieve,
        });
      } catch (err) {
        evidence = {
          status: 'unavailable',
          reason: 'rebuild_failed',
          detail: `The trial's evidence could not be rebuilt: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      views.set(subject.itemId, { rubric, evidence });
    }
  }
  return views;
}
