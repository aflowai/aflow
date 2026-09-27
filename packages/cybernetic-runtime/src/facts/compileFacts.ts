import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type {
  CoachObservation,
  CoachObservationReason,
  CoachReviewFacts,
  FailureCategory,
  IssueCategory,
  RunnerReflection,
  TenantId,
} from '@aflow/schemas';
import {
  CoachObservationSchema,
  CoachReviewFactsSchema,
  FailureCategorySchema,
} from '@aflow/schemas';
import {
  createMemoryDocRepository,
  createTenantContext,
  withTenantSchema,
  workflowRunTasks,
} from '@aflow/database';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';
import { getCyberneticLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileCoachFactsInput {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  spaceId: string;
  runId: string;
  /**
   * Slug of the skill being reviewed. Used to scope prior proposal /
   * observation history.
   */
  workflowSlug: string;
  /** Eval verdict + scores when available. */
  evalResult?: {
    verdict: 'pass' | 'fail' | 'partial' | 'error';
    scores: { overall: number };
    regressionDetected: boolean;
  };
  /**
   * Optional baseline overall score for `evalDeltas.overall`. Falls back
   * to a no-delta record when undefined.
   */
  evalBaselineOverall?: number;
}

export async function compileCoachFacts(input: CompileCoachFactsInput): Promise<CoachReviewFacts> {
  const logger = getCyberneticLogger();
  const { db, redis, tenantId, spaceId, runId, workflowSlug } = input;

  // Lift all the I/O up front so the rest of the compiler is pure-ish.
  const [taskRows, observations, recentProposalEvents] = await Promise.all([
    loadTaskRows(db, tenantId, runId),
    loadRecentObservations(db, tenantId, spaceId, workflowSlug),
    loadRecentProposalEvents(redis, tenantId, spaceId, workflowSlug),
  ]);

  const reflections = collectReflections(taskRows);

  const taskFailures = compileTaskFailures(taskRows);
  const missingInputs = compileMissingInputs(reflections);
  const missingTools = compileMissingTools(reflections);
  const platformEnvironmentSignals = compilePlatformEnvironmentSignals(taskRows);
  const costLatencyAnomalies = compileCostLatencyAnomalies(taskRows);
  const repeatedToolShapes = compileRepeatedToolShapes(taskRows);
  const priorProposalHistory = compilePriorProposalHistory(recentProposalEvents);
  const priorObservationRollup = compileObservationRollup(observations);

  // Eval delta — deterministic when we have a verdict + baseline.
  let evalDeltas: CoachReviewFacts['evalDeltas'];
  if (input.evalResult) {
    const overall =
      input.evalBaselineOverall !== undefined
        ? input.evalResult.scores.overall - input.evalBaselineOverall
        : undefined;
    evalDeltas = {
      ...(overall !== undefined ? { overall } : {}),
      perCriterion: [],
      regressionConfirmed: input.evalResult.regressionDetected,
    };
  }

  const candidate: Record<string, unknown> = {
    factsId: randomUUID(),
    runId,
    compiledAt: new Date().toISOString(),
    taskFailures,
    missingInputs,
    missingTools,
    contractViolations: [], // Phase 3b — port/output-shape validation events
    dataflowBreaks: [], // Phase 3b — graph-validator output interpretation
    ...(evalDeltas ? { evalDeltas } : {}),
    costLatencyAnomalies,
    platformEnvironmentSignals,
    repeatedToolShapes,
    priorProposalHistory,
    priorObservationRollup,
  };

  try {
    return CoachReviewFactsSchema.parse(candidate);
  } catch (err) {
    // Defensive — if the compiler produced something the schema can't
    // accept, fall back to an empty facts record rather than aborting
    // the Coach activation. Telemetry surfaces the parse failure.
    logger.warn(
      `compileCoachFacts: schema parse failed for run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return CoachReviewFactsSchema.parse({
      factsId: randomUUID(),
      runId,
      compiledAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface TaskRow {
  taskId: string;
  attempt: number;
  status: string;
  durationMs: number | null;
  costCents: number | null;
  metricsJson: unknown;
  failureReason: string | null;
  errorCode: string | null;
  errorClassification: string | null;
  reflectionJson: unknown;
  stepExecutionId: string | null;
  operationId: string | null;
  inputRef: string | null;
}

async function loadTaskRows(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<TaskRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  try {
    return await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({
          taskId: workflowRunTasks.taskId,
          attempt: workflowRunTasks.attempt,
          status: workflowRunTasks.status,
          durationMs: workflowRunTasks.durationMs,
          costCents: workflowRunTasks.costCents,
          metricsJson: workflowRunTasks.metricsJson,
          failureReason: workflowRunTasks.failureReason,
          errorCode: workflowRunTasks.errorCode,
          errorClassification: workflowRunTasks.errorClassification,
          reflectionJson: workflowRunTasks.reflectionJson,
          stepExecutionId: workflowRunTasks.stepExecutionId,
          operationId: workflowRunTasks.operationId,
          inputRef: workflowRunTasks.inputRef,
        })
        .from(workflowRunTasks)
        .where(eq(workflowRunTasks.runId, runId)),
    );
  } catch {
    return [];
  }
}

// Observation docs sit at `/coach/observations/<uuid>.json`, so
// `MemoryDocRepository.list` orders them alphabetically by UUID —
// NOT by `createdAt`. A single capped call silently dropped a
// skill's newest observations whenever their UUIDs sorted after
// the cap in a busy space (PR-377 review finding — same shape as
// the `loadRecentLearnings` pagination fix). Paginate the prefix
// until exhausted or `OBSERVATIONS_MAX_SCANNED` reached, then
// sort matches by `createdAt`.
const OBSERVATIONS_SCAN_PAGE_SIZE = 200;
const OBSERVATIONS_MAX_SCANNED = 5000;
/** Cap newest matches returned to the rollup — keeps fact compilation bounded. */
const OBSERVATIONS_RETURN_CAP = 100;

async function loadRecentObservations(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<CoachObservation[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  try {
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const observations: CoachObservation[] = [];
    let cursor: string | undefined = undefined;
    let scanned = 0;
    while (scanned < OBSERVATIONS_MAX_SCANNED) {
      const page: Awaited<ReturnType<typeof docRepo.list>> = await docRepo.list({
        pathPrefix: '/coach/observations/',
        scope: { spaceId },
        limit: OBSERVATIONS_SCAN_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (page.length === 0) break;
      scanned += page.length;
      for (const entry of page) {
        const doc = await docRepo.getByPath(entry.path, spaceId);
        if (!doc?.inlineContent) continue;
        try {
          const parsed = CoachObservationSchema.parse(JSON.parse(doc.inlineContent));
          if (parsed.workflowSlug !== workflowSlug) continue;
          observations.push(parsed);
        } catch {
          // skip malformed
        }
      }
      cursor = page[page.length - 1]?.path;
      if (page.length < OBSERVATIONS_SCAN_PAGE_SIZE) break;
    }
    observations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return observations.slice(0, OBSERVATIONS_RETURN_CAP);
  } catch {
    return [];
  }
}

interface ProposalEventEntry {
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

async function loadRecentProposalEvents(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<ProposalEventEntry[]> {
  try {
    const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
    // Oversample — most events aren't proposal-related.
    const raw = await redis.xrevrange(streamKey, '+', '-', 'COUNT', 500);
    const out: ProposalEventEntry[] = [];
    for (const [, fields] of raw) {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i];
        const v = fields[i + 1];
        if (k !== undefined && v !== undefined) fieldObj[k] = v;
      }
      const eventType = fieldObj['eventType'];
      if (!eventType) continue;
      if (
        eventType !== 'entity.coach.proposal' &&
        eventType !== 'entity.coach.ratified' &&
        eventType !== 'entity.coach.rejected' &&
        eventType !== 'entity.coach.apply_failed'
      ) {
        continue;
      }
      let payload: Record<string, unknown> = {};
      try {
        const raw = fieldObj['payload'];
        if (raw) payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      // Slug naming drift across event emitters:
      //   - `entity.coach.proposal` payload uses `targetSlug`
      //   - `entity.coach.apply_failed` payload uses `targetSlug`
      //   - `entity.coach.ratified` / `.rejected` payloads use `targetWorkflowSlug`
      // Accept all three to keep priorProposalHistory complete.
      if (
        payload['targetSlug'] !== workflowSlug &&
        payload['targetWorkflowSlug'] !== workflowSlug &&
        payload['workflowSlug'] !== workflowSlug
      ) {
        continue;
      }
      out.push({
        eventType,
        payload,
        timestamp: Number(fieldObj['timestamp'] ?? Date.now()),
      });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure compilers
// ---------------------------------------------------------------------------

function collectReflections(rows: TaskRow[]): RunnerReflection[] {
  const out: RunnerReflection[] = [];
  for (const row of rows) {
    if (!row.reflectionJson) continue;
    out.push(row.reflectionJson as RunnerReflection);
  }
  return out;
}

function compileTaskFailures(rows: TaskRow[]): CoachReviewFacts['taskFailures'] {
  const out: CoachReviewFacts['taskFailures'] = [];
  const errorShapeCounts = new Map<string, number>();

  // First pass: count repeated error shapes (taskId + errorCode + classification).
  for (const row of rows) {
    if (row.status !== 'failed') continue;
    const fingerprint = `${row.taskId}::${row.errorCode ?? ''}::${row.errorClassification ?? ''}`;
    errorShapeCounts.set(fingerprint, (errorShapeCounts.get(fingerprint) ?? 0) + 1);
  }

  for (const row of rows) {
    if (row.status !== 'failed') continue;
    const errorMessage: string =
      row.failureReason ?? row.errorCode ?? row.errorClassification ?? 'unknown';
    const fingerprint = `${row.taskId}::${row.errorCode ?? ''}::${row.errorClassification ?? ''}`;
    out.push({
      taskId: row.taskId,
      attempt: row.attempt,
      errorCategory: classifyFailureCategory(row),
      errorMessage: errorMessage.slice(0, 2000),
      repeatedShapeCount: errorShapeCounts.get(fingerprint) ?? 1,
      ...(row.stepExecutionId ? { stepExecutionId: row.stepExecutionId } : {}),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Best-effort mapping from the workflow_run_tasks `error_classification`
 * column to the closed-set `FailureCategory`. The classification column
 * carries the executor's own classification (e.g. 'validation',
 * 'provider_error', 'timeout'); we accept matches verbatim and fall
 * back to `'unknown'` for anything outside the closed set.
 */
function classifyFailureCategory(row: TaskRow): FailureCategory {
  const cand = (row.errorClassification ?? '').toLowerCase();
  const parsed = FailureCategorySchema.safeParse(cand);
  if (parsed.success) return parsed.data;
  // Coarse heuristics on the failure reason text.
  const text = `${row.failureReason ?? ''} ${row.errorCode ?? ''}`.toLowerCase();
  if (text.includes('timeout')) return 'timeout';
  if (text.includes('rate') && text.includes('limit')) return 'rate_limit';
  if (text.includes('permission') || text.includes('forbidden') || text.includes('unauthor')) {
    return 'permission';
  }
  if (
    text.includes('5xx') ||
    text.includes('502') ||
    text.includes('503') ||
    text.includes('504')
  ) {
    return 'provider_error';
  }
  if (text.includes('binding') || text.includes('capability') || text.includes('credential')) {
    return 'config';
  }
  if (text.includes('schema') || text.includes('invalid')) return 'validation';
  return 'unknown';
}

function compileMissingInputs(reflections: RunnerReflection[]): CoachReviewFacts['missingInputs'] {
  const out: CoachReviewFacts['missingInputs'] = [];
  for (const r of reflections) {
    if (!r.missingInputs) continue;
    for (const key of r.missingInputs) {
      out.push({
        taskId: r.taskId,
        inputKey: key,
        askedAt: r.emittedAt,
        source: 'runner_reflection',
      });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

function compileMissingTools(reflections: RunnerReflection[]): CoachReviewFacts['missingTools'] {
  const out: CoachReviewFacts['missingTools'] = [];
  for (const r of reflections) {
    if (!r.missingTools) continue;
    for (const tool of r.missingTools) {
      out.push({
        taskId: r.taskId,
        toolName: tool,
        askedAt: r.emittedAt,
        source: 'runner_reflection',
      });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

function compilePlatformEnvironmentSignals(
  rows: TaskRow[],
): CoachReviewFacts['platformEnvironmentSignals'] {
  const counts = new Map<
    | 'provider_5xx'
    | 'capability_not_granted'
    | 'rate_limited'
    | 'binding_missing'
    | 'definition_not_found',
    { count: number; detail: string }
  >();

  for (const row of rows) {
    if (row.status !== 'failed') continue;
    const reason = `${row.failureReason ?? ''} ${row.errorCode ?? ''}`.toLowerCase();
    const code = (row.errorCode ?? '').toLowerCase();

    if (reason.includes('5xx') || /\b50[2-4]\b/.test(reason)) {
      bumpEnvCount(counts, 'provider_5xx', row.failureReason ?? row.errorCode ?? '');
    } else if (reason.includes('rate') && reason.includes('limit')) {
      bumpEnvCount(counts, 'rate_limited', row.failureReason ?? row.errorCode ?? '');
    } else if (code === 'binding_missing' || reason.includes('binding missing')) {
      bumpEnvCount(counts, 'binding_missing', row.failureReason ?? row.errorCode ?? '');
    } else if (code === 'definition_not_found' || reason.includes('definition not found')) {
      bumpEnvCount(counts, 'definition_not_found', row.failureReason ?? row.errorCode ?? '');
    } else if (
      code === 'capability_not_granted' ||
      reason.includes('capability not granted') ||
      reason.includes('not allowed by capability')
    ) {
      bumpEnvCount(counts, 'capability_not_granted', row.failureReason ?? row.errorCode ?? '');
    }
  }

  const out: CoachReviewFacts['platformEnvironmentSignals'] = [];
  for (const [kind, value] of counts) {
    out.push({ kind, count: value.count, detail: value.detail.slice(0, 500) });
  }
  return out;
}

function bumpEnvCount<
  K extends
    | 'provider_5xx'
    | 'capability_not_granted'
    | 'rate_limited'
    | 'binding_missing'
    | 'definition_not_found',
>(counts: Map<K, { count: number; detail: string }>, kind: K, detail: string): void {
  const existing = counts.get(kind);
  if (existing) {
    existing.count += 1;
  } else {
    counts.set(kind, { count: 1, detail });
  }
}

function compileCostLatencyAnomalies(rows: TaskRow[]): CoachReviewFacts['costLatencyAnomalies'] {
  if (rows.length === 0) return [];

  // Build per-metric baseline + flag anomalies (|value - median| > 2*MAD).
  // We only have THIS run's tasks, so the "baseline median" comes from
  // the run itself. This catches one outlier task within a run — a more
  // sophisticated cross-run baseline is a Phase 3b follow-up.
  const durations: number[] = [];
  const costs: number[] = [];
  for (const row of rows) {
    if (row.durationMs !== null) durations.push(row.durationMs);
    if (row.costCents !== null) costs.push(row.costCents);
  }

  const out: CoachReviewFacts['costLatencyAnomalies'] = [];
  flagOutliers(rows, durations, 'duration_ms', out, (r) => r.durationMs);
  flagOutliers(rows, costs, 'cost_cents', out, (r) => r.costCents);
  // Token count lives in `metricsJson` — best-effort extraction.
  const tokens: number[] = [];
  for (const row of rows) {
    const t = readTokenTotal(row.metricsJson);
    if (t !== null) tokens.push(t);
  }
  flagOutliers(rows, tokens, 'token_count', out, (r) => readTokenTotal(r.metricsJson));

  return out.slice(0, 50);
}

function flagOutliers(
  rows: TaskRow[],
  series: number[],
  metric: 'duration_ms' | 'cost_cents' | 'token_count',
  out: CoachReviewFacts['costLatencyAnomalies'],
  getter: (row: TaskRow) => number | null,
): void {
  if (series.length < 3) return;
  const sorted = [...series].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)] ?? 0;
  if (mad === 0) return;

  for (const row of rows) {
    const v = getter(row);
    if (v === null) continue;
    const deviations = Math.abs(v - median) / mad;
    if (deviations >= 3) {
      out.push({
        metric,
        taskId: row.taskId,
        value: v,
        baselineMedian: median,
        stddevsAboveBaseline: deviations,
      });
    }
  }
}

function readTokenTotal(metricsJson: unknown): number | null {
  if (!metricsJson || typeof metricsJson !== 'object') return null;
  const obj = metricsJson as Record<string, unknown>;
  const t = obj['totalTokens'] ?? obj['tokens'] ?? obj['token_count'];
  return typeof t === 'number' ? t : null;
}

function compileRepeatedToolShapes(rows: TaskRow[]): CoachReviewFacts['repeatedToolShapes'] {
  // Without per-step tool-call arg payloads in `workflow_run_tasks`, we
  // detect shape repetition at the task granularity: the same
  // `operationId` × `inputRef`-prefix fingerprint counts as repeat.
  // The hot shape signal — multiple agent loops calling the same tool
  // with identical args — fires on per-step tool calls; that lives in
  // step_executions and is a richer source for Phase 3b. The task-level
  // signal here is still useful when the workflow itself emits multiple
  // instances of the same operation task.
  const groups = new Map<string, { operationId: string; count: number; allSucceeded: boolean }>();

  for (const row of rows) {
    if (!row.operationId) continue;
    const ref = (row.inputRef ?? '').slice(0, 256);
    const shape = createHash('sha256').update(`${row.operationId}|${ref}`).digest('hex');
    const existing = groups.get(shape);
    const succeeded = row.status === 'succeeded';
    if (existing) {
      existing.count += 1;
      if (!succeeded) existing.allSucceeded = false;
    } else {
      groups.set(shape, { operationId: row.operationId, count: 1, allSucceeded: succeeded });
    }
  }

  const out: CoachReviewFacts['repeatedToolShapes'] = [];
  for (const [shape, value] of groups) {
    if (value.count < 2) continue;
    out.push({
      operationId: value.operationId,
      argShapeFingerprint: shape.slice(0, 32),
      count: value.count,
      allSucceeded: value.allSucceeded,
    });
  }
  return out.slice(0, 50);
}

function compilePriorProposalHistory(
  events: ProposalEventEntry[],
): CoachReviewFacts['priorProposalHistory'] {
  const out: CoachReviewFacts['priorProposalHistory'] = [];
  for (const e of events) {
    const proposalIdRaw = e.payload['stagedChangeId'];
    const proposalId = typeof proposalIdRaw === 'string' ? proposalIdRaw : undefined;
    if (!proposalId) continue;
    let status: 'ratified' | 'rejected' | 'expired' | 'apply_failed';
    switch (e.eventType) {
      case 'entity.coach.ratified':
        status = 'ratified';
        break;
      case 'entity.coach.rejected':
        status = 'rejected';
        break;
      case 'entity.coach.apply_failed':
        status = 'apply_failed';
        break;
      default:
        continue; // 'entity.coach.proposal' isn't a final status
    }
    // `issueCategory` is opaque on the entity-event payload; the
    // CoachReviewFactsSchema parse step at the end of the compiler
    // rejects any value outside the closed `IssueCategorySchema` set.
    const issueCategory = e.payload['issueCategory'];
    const issueCategoryField: { issueCategory?: IssueCategory } = {};
    if (typeof issueCategory === 'string') {
      issueCategoryField.issueCategory = issueCategory as IssueCategory;
    }
    out.push({
      proposalId,
      status,
      ...issueCategoryField,
      summary: extractEventSummary(e),
      at: new Date(e.timestamp).toISOString(),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function extractEventSummary(e: ProposalEventEntry): string {
  const candidate = e.payload['summary'];
  if (typeof candidate === 'string') return candidate.slice(0, 200);
  const stagedChangeId = e.payload['stagedChangeId'];
  const idText = typeof stagedChangeId === 'string' ? stagedChangeId : 'unknown';
  return `${e.eventType.replace(/^entity\.coach\./, '')} (${idText})`.slice(0, 200);
}

function compileObservationRollup(
  observations: CoachObservation[],
): CoachReviewFacts['priorObservationRollup'] {
  const byReason = new Map<
    CoachObservationReason,
    { count: number; firstSeen: string; lastSeen: string; samples: string[] }
  >();
  // Newest-last so `firstSeen` / `lastSeen` come out correctly when we
  // walk the array.
  const sorted = [...observations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const obs of sorted) {
    const existing = byReason.get(obs.reason);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = obs.createdAt;
      if (existing.samples.length < 3) existing.samples.push(obs.summary.slice(0, 200));
    } else {
      byReason.set(obs.reason, {
        count: 1,
        firstSeen: obs.createdAt,
        lastSeen: obs.createdAt,
        samples: [obs.summary.slice(0, 200)],
      });
    }
  }

  const out: CoachReviewFacts['priorObservationRollup'] = [];
  for (const [reason, value] of byReason) {
    out.push({
      reason,
      count: value.count,
      firstSeen: value.firstSeen,
      lastSeen: value.lastSeen,
      sampleSummaries: value.samples,
    });
  }
  return out;
}
