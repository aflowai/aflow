/**
 * Judge scorecard assembly (Plan 269 D11) — recompute-at-read IO around the
 * pure `computeJudgeScorecards`. Calibration is scoped to the subject
 * configuration: labels and verdicts are gathered across the space's batches
 * of the same skill whose provenance manifests share the batch's
 * subjectConfigKey, never across configurations.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  EntityDirectives,
  EvalBatchProvenanceManifest,
  EvalBatchSubjectModel,
  JudgeScorecard,
  TenantId,
} from '@aflow/schemas';
import {
  DirectiveLearningPolicySchema,
  EvalBatchProvenanceManifestSchema,
  EvalCaseTrialResultsSchema,
} from '@aflow/schemas';
import type { EvalBatchRow } from '@aflow/database';
import { getEvalBatchHead, listEvalBatches, listTrialRows } from './evalBatchStore.js';
import {
  listCaseScopedLabelsForBatches,
  listRejudgeVerdictsForBatches,
} from './evalLabelQueueStore.js';
import {
  computeJudgeScorecards,
  deriveSubjectConfigKey,
  type JudgeMeasurementLabel,
  type JudgeMeasurementVerdict,
  type JudgeTrustKnobs,
} from './judgeScorecard.js';
import { loadSpaceDirectives } from './modelResolution.js';

/** Upper bound on sibling batches scanned for a subject-config group. */
const SCORECARD_BATCH_SCAN_LIMIT = 100;

export function resolveJudgeTrustKnobs(directives: EntityDirectives | null): JudgeTrustKnobs {
  const judgeTrustSchema = DirectiveLearningPolicySchema.shape.judgeTrust;
  const parsed = judgeTrustSchema.safeParse(
    (directives?.learningPolicy as { judgeTrust?: unknown } | undefined)?.judgeTrust,
  );
  const knobs = parsed.success ? parsed.data : judgeTrustSchema.parse(undefined);
  return {
    judgeTrustKappa: knobs.judgeTrustKappa,
    judgeTrustMinLabels: knobs.judgeTrustMinLabels,
  };
}

function parseManifest(row: EvalBatchRow): EvalBatchProvenanceManifest | null {
  const parsed = EvalBatchProvenanceManifestSchema.safeParse(row.provenanceManifestJson);
  return parsed.success ? parsed.data : null;
}

export interface SubjectConfigGroup {
  subjectConfigKey: string;
  subjectModels: EvalBatchSubjectModel[];
  /** Batches of the same skill sharing the configuration, the head included. */
  batchIds: string[];
}

export async function resolveSubjectConfigGroup(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; head: EvalBatchRow },
): Promise<SubjectConfigGroup | null> {
  const headManifest = parseManifest(params.head);
  if (headManifest === null) return null;
  const subjectConfigKey = deriveSubjectConfigKey(headManifest.subjectModels);
  const siblings = await listEvalBatches(db, tenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.head.workflowSlug,
    limit: SCORECARD_BATCH_SCAN_LIMIT,
  });
  const batchIds = new Set<string>([params.head.id]);
  for (const sibling of siblings) {
    const manifest = parseManifest(sibling);
    if (manifest === null) continue;
    if (deriveSubjectConfigKey(manifest.subjectModels) === subjectConfigKey) {
      batchIds.add(sibling.id);
    }
  }
  return {
    subjectConfigKey,
    subjectModels: headManifest.subjectModels,
    batchIds: [...batchIds],
  };
}

/**
 * Every judge verdict on record for the batches, per subject and version:
 * the batch-time record in `results_json` is authoritative; re-judge replay
 * rows fill versions the batch never produced and never displace one.
 */
export async function collectJudgeVerdictRecords(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchIds: readonly string[]; criterionId?: string | undefined },
): Promise<JudgeMeasurementVerdict[]> {
  const byIdentity = new Map<string, JudgeMeasurementVerdict>();
  const identity = (v: JudgeMeasurementVerdict): string =>
    `${v.batchId} ${v.caseRevisionId} ${String(v.trial)} ${v.criterionId} ${v.scopeKey} ${v.judgeVersion}`;

  for (const batchId of params.batchIds) {
    const rows = await listTrialRows(db, tenantId, batchId);
    for (const row of rows) {
      if (row.disposition !== 'graded') continue;
      const parsed = EvalCaseTrialResultsSchema.safeParse(row.resultsJson);
      if (!parsed.success) continue;
      for (const rubricResult of parsed.data.rubricResults) {
        if (rubricResult.status !== 'judged') continue;
        // An abstention is not a prediction. Counting it would put a verdict
        // the judge declined to give into precision and recall, which are
        // defined over judgements — it belongs to the abstention rate instead.
        if (rubricResult.verdict === 'unclear') continue;
        if (params.criterionId !== undefined && rubricResult.criterionId !== params.criterionId) {
          continue;
        }
        const record: JudgeMeasurementVerdict = {
          batchId,
          caseRevisionId: row.caseRevisionId,
          trial: row.trial,
          criterionId: rubricResult.criterionId,
          scopeKey: rubricResult.scopeKey,
          judgeVersion: rubricResult.judgeVersion,
          verdict: rubricResult.verdict,
        };
        byIdentity.set(identity(record), record);
      }
    }
  }

  const replays = await listRejudgeVerdictsForBatches(db, tenantId, {
    spaceId: params.spaceId,
    batchIds: params.batchIds,
    criterionId: params.criterionId,
  });
  for (const replay of replays) {
    if (replay.verdict !== 'pass' && replay.verdict !== 'fail') continue;
    const record: JudgeMeasurementVerdict = {
      batchId: replay.batchId,
      caseRevisionId: replay.caseRevisionId,
      trial: replay.trial,
      criterionId: replay.criterionId,
      scopeKey: replay.scopeKey,
      judgeVersion: replay.judgeVersion,
      verdict: replay.verdict,
    };
    if (!byIdentity.has(identity(record))) byIdentity.set(identity(record), record);
  }
  return [...byIdentity.values()];
}

/**
 * D11 scorecards for one batch's subject configuration, recomputed at read.
 * Returns [] when no validation labels exist for the configuration.
 */
export async function buildJudgeScorecardsForBatch(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchId: string },
): Promise<JudgeScorecard[]> {
  const head = await getEvalBatchHead(db, tenantId, params);
  if (head === null) return [];
  const group = await resolveSubjectConfigGroup(db, tenantId, {
    spaceId: params.spaceId,
    head,
  });
  if (group === null) return [];

  const labelRows = await listCaseScopedLabelsForBatches(db, tenantId, {
    spaceId: params.spaceId,
    batchIds: group.batchIds,
  });
  const labels: JudgeMeasurementLabel[] = labelRows.flatMap((row) => {
    if (row.caseRevisionId === null || row.batchId === null || row.trial === null) return [];
    if (row.verdict !== 'pass' && row.verdict !== 'fail') return [];
    if (row.partition !== 'exemplar' && row.partition !== 'validation') return [];
    return [
      {
        batchId: row.batchId,
        caseRevisionId: row.caseRevisionId,
        trial: row.trial,
        criterionId: row.criterionId,
        scopeKey: row.scopeKey,
        verdict: row.verdict,
        partition: row.partition,
        subjectConfigKey: group.subjectConfigKey,
      },
    ];
  });
  if (!labels.some((label) => label.partition === 'validation')) return [];

  const verdicts = await collectJudgeVerdictRecords(db, tenantId, {
    spaceId: params.spaceId,
    batchIds: group.batchIds,
  });
  const directives = await loadSpaceDirectives(db, tenantId as string, params.spaceId);
  return computeJudgeScorecards({
    labels,
    verdicts,
    subjectModelsByConfigKey: new Map([[group.subjectConfigKey, group.subjectModels]]),
    trust: resolveJudgeTrustKnobs(directives),
  });
}
