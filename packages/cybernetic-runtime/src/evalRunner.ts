import { alignJudgeEntries, foldJudgeVerdict } from '@aflow/schemas';
import { createHash, randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type {
  TenantId,
  CyberneticEvalSuite,
  CriterionResult,
  DirectiveModelDefaults,
  EvalResult,
  FaultLayer,
  JudgeCriterion,
  JudgeCriterionSelection,
  WorkflowTask,
} from '@aflow/schemas';
import {
  CyberneticEvalSuiteSchema,
  EvalResultSchema,
  DEFAULT_CYBERNETIC_MODEL,
  NON_SCORABLE_CRITERION_TYPES,
  resolveRoleModel,
} from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  memoryDocs,
  memoryDocVersions,
  evalLabels,
  resolveWorkflowForStart,
} from '@aflow/database';
import { appendEntityEvent } from '@aflow/redis';
import type { AIClient } from '@aflow/ai-client';
import type { PayloadStore } from '@aflow/payload-store';
import { getPlatformEvalSuite } from '@aflow/platform-artifacts';
import { getCyberneticLogger } from './logger.js';
import type { WorkflowTaskRow } from './ledger/types.js';
import { updateBaseline } from './baselineManager.js';
import { callJudgeModel } from './judgeCall.js';
import { deriveSubjectModels, resolveJudgeModelForDispatch } from './evalBatchJudge.js';
import { loadSpaceDirectives } from './modelResolution.js';
import { evaluateCriterion } from './evalRunnerCriterion.js';
import { judgeSelectionKey, selectJudgeCriteria } from './evalRunnerJudgeSelection.js';
import { buildGoalMetrics, evaluateGoalCriteria } from './evalRunnerGoalCriteria.js';
import { applyRunTerminalCoverage, type RunTerminalCoverage } from './evalRunnerCoverage.js';
import { resolveSuiteCampaignRefs, suiteHasCampaignRefs } from './evalRunnerCampaignResolution.js';
import { getRunCampaignId } from './ledger/queries.js';
import { getCampaignById } from './campaigns.js';
import { selectIneligibleTaskCriteria } from './skillValidity/skillValidity.js';

export { evaluateCriterion } from './evalRunnerCriterion.js';

// ============================================================================
// Types
// ============================================================================

export interface EvalRunnerParams {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  sessionId: string;
  /** Lets the runner exclude structurally-dead eval criteria from the verdict. */
  workflowTasks?: WorkflowTask[];
  /** Task results from the completed workflow run. */
  taskResults: Array<{
    taskId: string;
    status: string;
    metrics?: Record<string, unknown>;
    /**
     * The task's decoded output payload, when available. Agents only write
     * to outputs (via submit_output); there is no agent-facing primitive to
     * write `metrics`. Without this, `taskCriteria` of type `contains` /
     * `threshold` that name an output field (e.g. `validationScore`) score
     * 0 every run because `metrics` is null. Callers should decode
     * `outputRef` from the task row via PayloadStore.retrieve and pass the
     * result here. Optional — older call sites that don't have a
     * PayloadStore handle can omit it and the evaluator falls back to
     * `metrics` (unchanged behavior).
     */
    output?: Record<string, unknown>;
    summary?: string;
    durationMs: number;
    costCents: number;
    /**
     * Set for operation-typed tasks (the op the task ran). Drives fault
     * attribution: a failed operation task is never the agent's fault —
     * the agent isn't in the loop.
     */
    operationId?: string;
    /** Typed error class persisted on the task row (AflowError fields). */
    errorCode?: string;
    errorClassification?: string;
  }>;
  /** Workflow outcomes evaluation (from workflow.evaluate). */
  outcomeResults?: {
    met: number;
    total: number;
    details: Array<{ outcomeId: string; met: boolean }>;
  };
  runLevelMetrics?: Record<string, unknown>;
  runTerminal: RunTerminalCoverage;
  /**
   * BYOK judge-client resolver, space-scoped by the caller (the same
   * `ByokAiClientFactory.getClientForModel` chain the batch lane uses).
   * Absent → every judge criterion resolves `judge_error` (no client, no
   * silent env-key fallback).
   */
  resolveJudgeClient?: (model: string) => Promise<AIClient>;
  db: PostgresJsDatabase;
  redis: Redis;
}

/**
 * Build the `EvalRunnerParams.taskResults` shape from raw workflow_run_tasks
 * rows. Decodes each task's `outputRef` via PayloadStore when available so
 * task-output fields (e.g. `validationScore`) become first-class lookups for
 * `contains` / `threshold` criteria. PayloadStore is optional; without it
 * the helper falls back to `metricsJson` + `summary` only (unchanged
 * pre-Plan-167 behavior). Decode failures are logged and swallowed — a
 * stale/missing payload should not block eval from running on the
 * remaining tasks.
 */
export async function buildEvalTaskResultsFromRows(
  tasks: readonly WorkflowTaskRow[],
  payloadStore: PayloadStore | undefined,
  logCtx: { runId: string } = { runId: '' },
): Promise<EvalRunnerParams['taskResults']> {
  const logger = getCyberneticLogger();
  return Promise.all(
    tasks.map(async (t) => {
      const entry: EvalRunnerParams['taskResults'][number] = {
        taskId: t.taskId,
        status: t.status,
        durationMs: t.durationMs ?? 0,
        costCents: t.costCents ?? 0,
      };
      if (t.metricsJson) entry.metrics = t.metricsJson as Record<string, unknown>;
      if (t.summary) entry.summary = t.summary;
      if (t.operationId) entry.operationId = t.operationId;
      if (t.errorCode) entry.errorCode = t.errorCode;
      if (t.errorClassification) entry.errorClassification = t.errorClassification;
      if (payloadStore && t.outputRef) {
        try {
          const decoded = await payloadStore.retrieve(t.outputRef);
          if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
            entry.output = decoded as Record<string, unknown>;
          }
        } catch (err) {
          logger.warn(
            `[evalRunner] Output decode failed for task=${t.taskId} run=${logCtx.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Reserved-`summary` fallback: when the row summary is
      // absent but the task's output embeds a string `summary` field, use it
      // — covers output-contract summaries and any persist race on the
      // run's final task.
      if (entry.summary === undefined && entry.output) {
        const outputSummary = entry.output['summary'];
        if (typeof outputSummary === 'string' && outputSummary.length > 0) {
          entry.summary = outputSummary;
        }
      }
      return entry;
    }),
  );
}

export interface EvalRunResult {
  resultId: string;
  verdict: 'pass' | 'fail' | 'partial' | 'error';
  scores: {
    goalScore?: number;
    taskScore?: number;
    trajectoryScore?: number;
    overall: number;
  };
  faultLayer?: FaultLayer;
  faultEvidence?: string;
  suggestedRemediationOwner?: 'learner' | 'operator' | 'platform_team' | 'none';
  regressionDetected: boolean;
}

/**
 * The typed decision `runEvaluation` hands back for the run's evaluation
 * envelope — every path is explicit, none is a silent skip.
 */
export type EvalRunOutcome =
  | { decision: 'no_suite' }
  | {
      decision: 'no_scorable_criteria';
      suiteContentHash: string;
      judgeSelection?: JudgeCriterionSelection[];
    }
  | {
      decision: 'error';
      suiteContentHash?: string;
      message: string;
      result?: EvalRunResult;
      judgeSelection?: JudgeCriterionSelection[];
    }
  | {
      decision: 'ran';
      suiteContentHash: string;
      result: EvalRunResult;
      judgeSelection?: JudgeCriterionSelection[];
    };

// ============================================================================
// Internal helpers
// ============================================================================

function computeContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Load recent human labels for a criterion from the eval_labels table.
 * Returns a formatted string for inclusion in the Judge prompt, or
 * undefined if no labels exist.
 */
async function loadCalibrationNotes(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  evalSuitePath: string,
  criterionId: string,
  scopeKey: string,
): Promise<string | undefined> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  try {
    const rows = await withTenantSchema(db, tenantContext, async (tx) =>
      tx
        .select({
          verdict: evalLabels.verdict,
          judgeLabel: evalLabels.judgeLabel,
          critique: evalLabels.critique,
          labeledAt: evalLabels.labeledAt,
        })
        .from(evalLabels)
        .where(
          and(
            eq(evalLabels.spaceId, spaceId),
            eq(evalLabels.evalSuitePath, evalSuitePath),
            eq(evalLabels.criterionId, criterionId),
            eq(evalLabels.scopeKey, scopeKey),
          ),
        )
        .orderBy(sql`${evalLabels.labeledAt} DESC`)
        .limit(10),
    );
    if (rows.length === 0) return undefined;

    const lines = rows.map((r) => {
      const date = r.labeledAt.toISOString().slice(0, 10);
      const agreement =
        r.judgeLabel === null ? 'LABELED' : r.verdict === r.judgeLabel ? 'AGREED' : 'DISAGREED';
      const judgePart = r.judgeLabel === null ? '' : ` judge=${r.judgeLabel}`;
      return `- ${date} ${agreement}: operator=${r.verdict}${judgePart} — "${r.critique}"`;
    });
    return lines.join('\n');
  } catch {
    // Non-critical: if calibration load fails, proceed without notes
    return undefined;
  }
}

// ============================================================================
// LLM-as-Judge — advisory eval infrastructure (104e §4.3)
// ============================================================================

/** Default model for Judge calls when no criterion-level or directive override. */
const DEFAULT_JUDGE_MODEL = DEFAULT_CYBERNETIC_MODEL;

/**
 * Shape returned by `evaluateJudgeCriterion` — the verdict plus V2 advisory
 * enforcement fields.
 */
export interface JudgeEvalResult {
  criterionResult: CriterionResult;
  /** Always 'stage_for_review' in V2. */
  effectiveAuthority: 'stage_for_review';
  /** Always true in V2. */
  v2AdvisoryOnly: true;
}

/**
 * Evaluate a single JudgeCriterion via `ai.text.generate_json`.
 *
 * Budget: one call per JudgeCriterion per run. No retry loop, no turn-taking.
 * The Judge is eval infrastructure, not an agent.
 *
 * In V2, every verdict is advisory-only — it surfaces as review evidence and
 * never triggers auto-apply.
 */
export async function evaluateJudgeCriterion(
  criterion: JudgeCriterion,
  context: {
    tenantId: string;
    sessionId: string;
    taskResults: EvalRunnerParams['taskResults'];
    finalResult?: string;
    calibrationNotes?: string;
    /** BYOK client bound to the caller's credential chain — never env keys. */
    client?: AIClient;
    /** Judge model already resolved (criterion override → space judge role) with judge≠subject checked. */
    model?: string;
  },
): Promise<JudgeEvalResult> {
  const logger = getCyberneticLogger();
  const model = context.model ?? criterion.model ?? DEFAULT_JUDGE_MODEL;

  try {
    const client = context.client;
    if (!client)
      throw new Error('judge client not provided — resolve via BYOK and pass context.client');

    const { verdict } = await callJudgeModel({
      client,
      model,
      criterion,
      evidence: {
        taskSummaries: context.taskResults.map((t) => {
          const entry: { taskId: string; status: string; summary?: string } = {
            taskId: t.taskId,
            status: t.status,
          };
          if (t.summary !== undefined) entry.summary = t.summary;
          return entry;
        }),
        ...(context.finalResult !== undefined ? { finalResult: context.finalResult } : {}),
        ...(context.calibrationNotes !== undefined
          ? { calibrationNotes: context.calibrationNotes }
          : {}),
      },
      tenantId: context.tenantId,
      attributionId: context.sessionId,
    });

    const folded = foldJudgeVerdict(alignJudgeEntries(criterion.rubric, verdict));
    return {
      criterionResult: {
        criterionName: criterion.name,
        criterionType: 'judge',
        passed: folded.verdict === 'pass',
        score: folded.score,
        evidence: `Judge [${model}]: ${folded.verdict} (${String(folded.score)})`,
        judgeRationale: folded.rationale,
      },
      effectiveAuthority: 'stage_for_review',
      v2AdvisoryOnly: true,
    };
  } catch (error) {
    logger.warn(
      `evalRunner: Judge criterion "${criterion.name}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    // Judge dispatch failure: use criterionType 'judge_error' so scoring
    // excludes it. Infrastructure failures must not depress skill scores or
    // trigger agent-fault classification.
    return {
      criterionResult: {
        criterionName: criterion.name,
        criterionType: 'judge_error',
        passed: false,
        score: undefined,
        evidence: `Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      effectiveAuthority: 'stage_for_review',
      v2AdvisoryOnly: true,
    };
  }
}

/**
 * Judge≠subject enforcement for the PRODUCTION suite path (D8), mirroring
 * the batch lane's rule with the production analogue of the provenance
 * manifest: the subject is the space's runner default plus the workflow's
 * per-task model overrides. `workflowTasks === undefined` means the subject
 * is genuinely unresolvable (the workflow definition could not be loaded) —
 * a typed skip, never an unchecked judge.
 */
export type ProductionJudgeDispatchResolution =
  | { ok: true; model: string }
  | { ok: false; kind: 'subject_unresolvable' | 'judge_model_equals_subject'; message: string };

export function resolveProductionJudgeDispatch(params: {
  criterionModel: string | undefined;
  modelDefaults: DirectiveModelDefaults | undefined;
  workflowTasks: ReadonlyArray<{ taskId: string; model?: unknown; agent?: unknown }> | undefined;
}): ProductionJudgeDispatchResolution {
  if (params.workflowTasks === undefined) {
    return {
      ok: false,
      kind: 'subject_unresolvable',
      message:
        'Judge skipped: the workflow definition could not be loaded, so the subject models ' +
        '(runner default + per-task overrides) are unknown and the judge≠subject rule cannot be checked.',
    };
  }
  // A task delegating to a custom agent is measured on THAT agent's model,
  // which lives in the agent's own definition and is not resolvable here. The
  // guard cannot be checked without it, and the same refusal the unloadable
  // workflow gets is the honest answer — a judge that cannot prove it is not
  // the subject must not run.
  //
  // Detected by `task.agent`, NOT by a missing `model`: operation and human
  // tasks legitimately carry no model, and treating their absence as a
  // delegation would disable every production judge on any mixed workflow.
  const agentTasks = params.workflowTasks.filter(
    (task) => typeof task.agent === 'string' && task.agent.length > 0,
  );
  if (agentTasks.length > 0) {
    return {
      ok: false,
      kind: 'subject_unresolvable',
      message:
        `Judge skipped: ${String(agentTasks.length)} task(s) delegate to a custom agent whose ` +
        'model is not resolvable here, so the judge≠subject rule cannot be checked.',
    };
  }
  const runnerModel = resolveRoleModel(params.modelDefaults, 'runner');
  const subjectModelRefs = deriveSubjectModels(params.workflowTasks, runnerModel, {}).map(
    (m) => m.modelRef,
  );
  const resolution = resolveJudgeModelForDispatch({
    criterionModel: params.criterionModel,
    spaceJudgeModel: resolveRoleModel(params.modelDefaults, 'judge'),
    subjectModelRefs,
  });
  if (!resolution.ok) {
    return { ok: false, kind: 'judge_model_equals_subject', message: resolution.errorMessage };
  }
  return { ok: true, model: resolution.model };
}

export async function loadEvalSuite(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<CyberneticEvalSuite | null> {
  const platformSuite = getPlatformEvalSuite(workflowSlug);
  if (platformSuite) {
    try {
      return CyberneticEvalSuiteSchema.parse(platformSuite);
    } catch (error) {
      getCyberneticLogger().warn(
        `evalRunner: platform eval suite for '${workflowSlug}' failed validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  // Non-platform eval suite: load from space memory docs.
  const tenantContext = createTenantContext(tenantId as TenantId);
  const suitePath = `/evals/${workflowSlug}/suite.json`;

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, suitePath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row?.inlineContent) return null;

  try {
    return CyberneticEvalSuiteSchema.parse(JSON.parse(row.inlineContent));
  } catch (error) {
    getCyberneticLogger().warn(
      `evalRunner: failed to parse eval suite at ${suitePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

// ============================================================================
// Fault classification
// ============================================================================

/**
 * Classify the fault layer for a failed evaluation based on deterministic signals.
 * Exported for unit tests (pure).
 */
export function classifyFault(
  taskResults: EvalRunnerParams['taskResults'],
  criterionResults: {
    goalResults: CriterionResult[];
    taskResults: Record<string, CriterionResult[]>;
    trajectoryResults: CriterionResult[];
  },
): { layer: FaultLayer; evidence: string } | undefined {
  // Check for task-level failures with tool/infrastructure errors
  const failedTasks = taskResults.filter((t) => t.status === 'failed');

  for (const task of failedTasks) {
    // A failed OPERATION task is never the agent's fault — the agent is not
    // in the loop (the op ran on platform-assembled input). Classify by the
    // typed error class persisted on the task row.
    if (task.operationId) {
      const cls = task.errorClassification ?? '';
      const code = task.errorCode ?? 'unknown';
      const evidence = `Operation task ${task.taskId} (${task.operationId}) failed with ${code}${cls ? ` [${cls}]` : ''}`;
      // Upstream/provider conditions — not ours, not the skill's.
      if (cls === 'provider' || cls === 'rate_limit' || cls === 'budget') {
        return { layer: 'environment', evidence };
      }
      // Wiring/permission problems an operator can fix.
      if (cls === 'permission' || cls === 'configuration' || cls === 'not_found') {
        return { layer: 'configuration', evidence };
      }
      // validation / timeout / internal / transient / unknown → the op or
      // its platform-assembled input is broken, not the skill's reasoning.
      return { layer: 'platform', evidence };
    }

    // If a task failed and has error-like metrics, classify as platform or environment
    const errorType = task.metrics?.['errorType'];
    if (typeof errorType === 'string') {
      if (
        errorType.includes('timeout') ||
        errorType.includes('5xx') ||
        errorType.includes('internal')
      ) {
        return {
          layer: 'platform',
          evidence: `Task ${task.taskId} failed with ${errorType}`,
        };
      }
      if (
        errorType.includes('rate_limit') ||
        errorType.includes('unavailable') ||
        errorType.includes('external')
      ) {
        return {
          layer: 'environment',
          evidence: `Task ${task.taskId} failed with ${errorType}`,
        };
      }
      if (
        errorType.includes('auth') ||
        errorType.includes('permission') ||
        errorType.includes('4xx')
      ) {
        return {
          layer: 'configuration',
          evidence: `Task ${task.taskId} failed with ${errorType}`,
        };
      }
    }

    // Generic task failure without specific error type → likely agent issue
    if (!errorType) {
      return {
        layer: 'agent',
        evidence: `Task ${task.taskId} failed without specific error classification`,
      };
    }
  }

  // If no task failed but evaluated criteria failed, attribute to agent behavior.
  // Exclude judge_error / judge_skipped — an infrastructure failure or a
  // refused dispatch must not be blamed on the skill.
  const allCriterionResults = [
    ...criterionResults.goalResults,
    ...Object.values(criterionResults.taskResults).flat(),
    ...criterionResults.trajectoryResults,
  ];
  const evaluatedCriteria = allCriterionResults.filter(
    (r) => !NON_SCORABLE_CRITERION_TYPES.has(r.criterionType),
  );

  const failedCriteria = evaluatedCriteria.filter((r) => !r.passed);
  if (failedCriteria.length > 0) {
    return {
      layer: 'agent',
      evidence: `${String(failedCriteria.length)} criteria failed: ${failedCriteria.map((c) => c.criterionName).join(', ')}`,
    };
  }

  return undefined;
}

// ============================================================================
// Result storage
// ============================================================================

/**
 * Store an eval result in space memory.
 */
async function storeEvalResult(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
  runId: string,
  result: EvalResult,
): Promise<void> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const resultPath = `/evals/${workflowSlug}/results/${runId}.json`;
  const content = JSON.stringify(result, null, 2);
  const contentHash = computeContentHash(content);
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const now = new Date();

  await withTenantSchema(db, tenantContext, async (tx) => {
    // Check for existing doc (shouldn't exist for a unique runId, but handle upsert)
    const existing = await tx
      .select({
        id: memoryDocs.id,
        currentVersion: memoryDocs.currentVersion,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, resultPath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1);

    const existingRow = existing[0];

    if (existingRow) {
      const newVersion = existingRow.currentVersion + 1;

      await tx
        .update(memoryDocs)
        .set({
          inlineContent: content,
          contentHash,
          sizeBytes,
          currentVersion: newVersion,
          updatedAt: now,
        })
        .where(eq(memoryDocs.id, existingRow.id));

      await tx.insert(memoryDocVersions).values({
        docId: existingRow.id,
        version: newVersion,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: 'system:eval-runner',
      });
    } else {
      const [inserted] = await tx
        .insert(memoryDocs)
        .values({
          path: resultPath,
          spaceId,
          docType: 'json',
          mimeType: 'application/json',
          sizeBytes,
          contentHash,
          inlineContent: content,
          currentVersion: 1,
          embeddingStatus: 'disabled',
          indexingMode: 'disabled',
          tags: ['eval', 'result', workflowSlug],
          summary: `Eval ${result.verdict}: overall=${String(result.scores.overall)}`,
          createdByActor: 'system:eval-runner',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(memoryDocVersions).values({
        docId: inserted!.id,
        version: 1,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: 'system:eval-runner',
      });
    }
  });
}

// ============================================================================
// Entity event emission
// ============================================================================

async function emitEvalCompleted(
  redis: Redis,
  params: {
    tenantId: string;
    spaceId: string;
    sessionId: string;
    workflowSlug: string;
    runId: string;
    result: EvalResult;
  },
): Promise<void> {
  await appendEntityEvent(redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    event: {
      eventId: randomUUID(),
      eventType: 'entity.eval.completed',
      spaceId: params.spaceId,
      tenantId: params.tenantId,
      timestamp: Date.now(),
      causedBySessionId: params.sessionId,
      workflowSlug: params.workflowSlug,
      workflowRunId: params.runId,
      operatingMode: 'procedural',
      payload: {
        verdict: params.result.verdict,
        scores: params.result.scores,
        faultLayer: params.result.faultLayer ?? null,
      },
      summary: `Eval ${params.result.verdict} for ${params.workflowSlug}: overall=${String(params.result.scores.overall)}`,
    },
  });
}

async function emitEvalRegression(
  redis: Redis,
  params: {
    tenantId: string;
    spaceId: string;
    sessionId: string;
    workflowSlug: string;
    runId: string;
    breachCount: number;
    overallScore: number;
  },
): Promise<void> {
  await appendEntityEvent(redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    event: {
      eventId: randomUUID(),
      eventType: 'entity.eval.regression',
      spaceId: params.spaceId,
      tenantId: params.tenantId,
      timestamp: Date.now(),
      causedBySessionId: params.sessionId,
      workflowSlug: params.workflowSlug,
      workflowRunId: params.runId,
      operatingMode: 'procedural',
      payload: {
        breachCount: params.breachCount,
        overallScore: params.overallScore,
      },
      summary: `Regression detected for ${params.workflowSlug}: ${String(params.breachCount)} consecutive breaches, overall=${String(params.overallScore)}`,
    },
  });
}

// ============================================================================
// Main eval runner
// ============================================================================

/**
 * Run evaluation for a terminal codified procedure run. Deterministic
 * evaluation is unconditional when a suite exists — the only cost lever is
 * the suite's `judgeSamplingRate`, applied per judge criterion (failed runs
 * are always judged).
 *
 * Evaluates the criteria, computes scores, classifies faults, stores the
 * result, checks for regression, and emits entity events.
 *
 * @returns The typed decision for the run's evaluation envelope.
 */
export async function runEvaluation(params: EvalRunnerParams): Promise<EvalRunOutcome> {
  const {
    tenantId,
    spaceId,
    workflowSlug,
    runId,
    sessionId,
    taskResults,
    outcomeResults,
    runLevelMetrics,
    workflowTasks,
    db,
    redis,
  } = params;
  const logger = getCyberneticLogger();
  const startTime = Date.now();
  let suiteContentHash: string | undefined;
  let judgeSelections: JudgeCriterionSelection[] | undefined;

  try {
    // 1. Load eval suite
    const loadedSuite = await loadEvalSuite(db, tenantId, spaceId, workflowSlug);
    if (!loadedSuite) {
      logger.debug(`evalRunner: no eval suite for ${workflowSlug} — skipping`);
      return { decision: 'no_suite' };
    }
    suiteContentHash = computeContentHash(JSON.stringify(loadedSuite));

    const runFailed =
      params.runTerminal.runStatus === 'failed' ||
      params.runTerminal.failedRequiredTaskIds.length > 0 ||
      taskResults.some((t) => t.status === 'failed');

    let suite = loadedSuite;
    let prefailedGoal: CriterionResult[] = [];
    let prefailedTask: Record<string, CriterionResult[]> = {};
    let prefailedTrajectory: CriterionResult[] = [];
    if (suiteHasCampaignRefs(loadedSuite)) {
      let campaignConfig: Record<string, unknown> | null = null;
      try {
        const campaignId = await getRunCampaignId(db, tenantId, runId);
        if (campaignId) {
          const campaign = await getCampaignById(db, tenantId, campaignId);
          if (campaign) campaignConfig = campaign.config ?? {};
        }
      } catch (err) {
        logger.warn(
          `evalRunner: campaign config read failed for run=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const resolution = resolveSuiteCampaignRefs(loadedSuite, campaignConfig);
      suite = resolution.suite;
      prefailedGoal = resolution.prefailedGoal;
      prefailedTask = resolution.prefailedTask;
      prefailedTrajectory = resolution.prefailedTrajectory;
    }

    // 3. Compute aggregate trace metrics
    const aggregateMetrics = {
      stepCount: taskResults.length,
      durationMs: taskResults.reduce((sum, t) => sum + t.durationMs, 0),
      costCents: taskResults.reduce((sum, t) => sum + t.costCents, 0),
    };

    const goalMetrics = buildGoalMetrics({ runLevelMetrics, outcomeResults });
    const goalResults = evaluateGoalCriteria({
      suite,
      goalMetrics,
      outcomeResults,
      aggregateMetrics,
    });
    goalResults.push(...prefailedGoal);

    // 5. Run task criteria. A criterion that can never resolve (dead ref, or a
    // task that didn't run) is skipped, not graded — grading it would score a
    // false fail and poison the score/regression/Coach signal. Load the
    // workflow when a caller didn't supply it so the gate is universal across
    // every eval entry point, not just the postRunHooks finalize path. The
    // judge path needs the tasks too — per-task model overrides are half of
    // the judge≠subject subject set.
    const suiteHasJudgeCriteria = [
      ...suite.goalCriteria,
      ...Object.values(suite.taskCriteria).flat(),
      ...suite.trajectoryCriteria,
    ].some((c) => c.type === 'judge');
    let tasksForEligibility = workflowTasks;
    if (
      !tasksForEligibility &&
      (Object.keys(suite.taskCriteria).length > 0 || suiteHasJudgeCriteria)
    ) {
      try {
        const wf = await resolveWorkflowForStart(db, tenantId as TenantId, spaceId, workflowSlug);
        tasksForEligibility = wf?.tasks;
      } catch (err) {
        logger.debug(
          `evalRunner: workflow load for eligibility failed for ${workflowSlug}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const ineligible = tasksForEligibility
      ? selectIneligibleTaskCriteria(tasksForEligibility, suite.taskCriteria)
      : new Set<string>();
    const evalTaskResults: Record<string, CriterionResult[]> = {};
    for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
      const taskResult = taskResults.find((t) => t.taskId === taskId);
      const criterionResults: CriterionResult[] = [];
      const taskRan = taskResult !== undefined && taskResult.status !== 'skipped';

      for (const criterion of criteria) {
        if (!taskRan || ineligible.has(`${taskId} ${criterion.name}`)) continue;
        const evalData: {
          metrics?: Record<string, unknown>;
          output?: Record<string, unknown>;
          summary?: string;
          aggregateMetrics?: { stepCount: number; durationMs: number; costCents: number };
        } = {};
        if (taskResult.metrics) evalData.metrics = taskResult.metrics;
        if (taskResult.output) evalData.output = taskResult.output;
        if (taskResult.summary) evalData.summary = taskResult.summary;
        evalData.aggregateMetrics = {
          stepCount: 1, // Individual task = 1 step
          durationMs: taskResult.durationMs,
          costCents: taskResult.costCents,
        };
        const result = evaluateCriterion(criterion, evalData);
        if (result) criterionResults.push(result);
      }

      if (criterionResults.length > 0) {
        evalTaskResults[taskId] = criterionResults;
      }
    }
    for (const [taskId, results] of Object.entries(prefailedTask)) {
      evalTaskResults[taskId] = [...(evalTaskResults[taskId] ?? []), ...results];
    }

    // 6. Run trajectory criteria
    const trajectoryResults: CriterionResult[] = [];
    for (const criterion of suite.trajectoryCriteria) {
      const result = evaluateCriterion(criterion, {
        aggregateMetrics,
      });
      if (result) trajectoryResults.push(result);
    }
    trajectoryResults.push(...prefailedTrajectory);

    // 6b. Run Judge criteria (Tier 3 — 104e §4.3)
    //     One ai.text.generate_json call per selected JudgeCriterion.
    //     Advisory-only in V2. Iterate each scope directly to avoid
    //     name-collision routing bugs.
    const judgeSelection = selectJudgeCriteria(suite, runFailed);
    if (judgeSelection.selections.length > 0) judgeSelections = judgeSelection.selections;
    {
      const suitePath = `/evals/${workflowSlug}/suite.json`;
      const judgeFinalResult = outcomeResults
        ? `Outcomes: ${String(outcomeResults.met)}/${String(outcomeResults.total)} met`
        : undefined;

      // Judge environment (D8): the space's judge/runner role models, loaded
      // once. A directives read failure makes the subject unresolvable —
      // typed skip, never an unchecked judge.
      let judgeEnv:
        | { available: true; modelDefaults: DirectiveModelDefaults | undefined }
        | { available: false; message: string } = { available: true, modelDefaults: undefined };
      if (judgeSelection.selected.size > 0) {
        try {
          const directives = await loadSpaceDirectives(db, tenantId, spaceId);
          judgeEnv = { available: true, modelDefaults: directives?.modelDefaults };
        } catch (err) {
          judgeEnv = {
            available: false,
            message:
              'Judge skipped: space directives could not be read, so the subject and judge ' +
              `models are unknown — ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      const judgeSkippedResult = (criterionName: string, message: string): CriterionResult => ({
        criterionName,
        criterionType: 'judge_skipped',
        passed: false,
        applicable: false,
        evidence: message.slice(0, 1000),
      });

      const dispatchJudge = async (
        criterion: JudgeCriterion,
        baseCtx: {
          tenantId: string;
          sessionId: string;
          taskResults: EvalRunnerParams['taskResults'];
          finalResult?: string;
          calibrationNotes?: string;
        },
      ): Promise<CriterionResult> => {
        if (!judgeEnv.available) return judgeSkippedResult(criterion.name, judgeEnv.message);
        const resolution = resolveProductionJudgeDispatch({
          criterionModel: criterion.model,
          modelDefaults: judgeEnv.modelDefaults,
          workflowTasks: tasksForEligibility,
        });
        if (!resolution.ok) return judgeSkippedResult(criterion.name, resolution.message);
        let client: AIClient | undefined;
        if (params.resolveJudgeClient) {
          try {
            client = await params.resolveJudgeClient(resolution.model);
          } catch (err) {
            return {
              criterionName: criterion.name,
              criterionType: 'judge_error',
              passed: false,
              evidence: `Judge client unavailable for '${resolution.model}': ${
                err instanceof Error ? err.message : String(err)
              }`.slice(0, 1000),
            };
          }
        }
        const judgeResult = await evaluateJudgeCriterion(criterion, {
          ...baseCtx,
          model: resolution.model,
          ...(client !== undefined ? { client } : {}),
        });
        return judgeResult.criterionResult;
      };

      // Goal-level judge criteria — evaluated against whole-run context
      for (const gc of suite.goalCriteria) {
        if (gc.type !== 'judge') continue;
        if (!judgeSelection.selected.has(judgeSelectionKey('goal', gc.name))) continue;
        const notes = await loadCalibrationNotes(db, tenantId, spaceId, suitePath, gc.name, 'goal');
        const baseCtx: {
          tenantId: string;
          sessionId: string;
          taskResults: EvalRunnerParams['taskResults'];
          finalResult?: string;
          calibrationNotes?: string;
        } = { tenantId, sessionId, taskResults };
        if (judgeFinalResult !== undefined) baseCtx.finalResult = judgeFinalResult;
        if (notes !== undefined) baseCtx.calibrationNotes = notes;
        goalResults.push(await dispatchJudge(gc, baseCtx));
      }

      // Task-level judge criteria — evaluated against task-local artifacts only.
      // If the target task is missing from results, skip with an evidence note
      // rather than silently grading the wrong artifact set.
      for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
        for (const tc of criteria) {
          if (tc.type !== 'judge') continue;
          if (!judgeSelection.selected.has(judgeSelectionKey('task', tc.name, taskId))) continue;
          const taskResult = taskResults.find((t) => t.taskId === taskId);
          if (!taskResult) {
            if (!evalTaskResults[taskId]) evalTaskResults[taskId] = [];
            evalTaskResults[taskId].push({
              criterionName: tc.name,
              criterionType: 'judge_error',
              passed: false,
              evidence: `Task "${taskId}" not found in run results — cannot evaluate`,
            });
            continue;
          }
          const notes = await loadCalibrationNotes(
            db,
            tenantId,
            spaceId,
            suitePath,
            tc.name,
            `task:${taskId}`,
          );
          const baseCtx: {
            tenantId: string;
            sessionId: string;
            taskResults: EvalRunnerParams['taskResults'];
            finalResult?: string;
            calibrationNotes?: string;
          } = { tenantId, sessionId, taskResults: [taskResult] };
          if (taskResult.summary !== undefined) baseCtx.finalResult = taskResult.summary;
          if (notes !== undefined) baseCtx.calibrationNotes = notes;
          const criterionResult = await dispatchJudge(tc, baseCtx);
          if (!evalTaskResults[taskId]) evalTaskResults[taskId] = [];
          evalTaskResults[taskId].push(criterionResult);
        }
      }

      // Trajectory-level judge criteria — evaluated against whole-run context
      for (const tc of suite.trajectoryCriteria) {
        if (tc.type !== 'judge') continue;
        if (!judgeSelection.selected.has(judgeSelectionKey('trajectory', tc.name))) continue;
        const notes = await loadCalibrationNotes(
          db,
          tenantId,
          spaceId,
          suitePath,
          tc.name,
          'trajectory',
        );
        const baseCtx: {
          tenantId: string;
          sessionId: string;
          taskResults: EvalRunnerParams['taskResults'];
          finalResult?: string;
          calibrationNotes?: string;
        } = { tenantId, sessionId, taskResults };
        if (judgeFinalResult !== undefined) baseCtx.finalResult = judgeFinalResult;
        if (notes !== undefined) baseCtx.calibrationNotes = notes;
        trajectoryResults.push(await dispatchJudge(tc, baseCtx));
      }
    }

    // 7. Compute scores — exclude non-scorable criteria from scoring.
    //    judge_error / judge_skipped (infrastructure failure or a refused
    //    dispatch — must not blame the skill) and INAPPLICABLE results
    //    (applicable === false: the criterion's input was absent so it
    //    measured nothing) are recorded as evidence but never scored — a
    //    measurement defect must not count as a 0/fail and drag down an
    //    otherwise-valid run.
    const isScorable = (r: CriterionResult) =>
      !NON_SCORABLE_CRITERION_TYPES.has(r.criterionType) && r.applicable !== false;

    // Use numeric score when present (judge criteria produce 0-1 scores),
    // fall back to boolean passed → 1/0 for deterministic criteria.
    const criterionScore = (r: CriterionResult): number =>
      r.score !== undefined ? r.score : r.passed ? 1 : 0;

    const evaluatedGoal = goalResults.filter(isScorable);
    const goalScoreSum = evaluatedGoal.reduce((sum, r) => sum + criterionScore(r), 0);
    const totalGoal = evaluatedGoal.length;
    const goalScore = totalGoal > 0 ? goalScoreSum / totalGoal : undefined;

    const allTaskCriterionResults = Object.values(evalTaskResults).flat();
    const evaluatedTask = allTaskCriterionResults.filter(isScorable);
    const taskScoreSum = evaluatedTask.reduce((sum, r) => sum + criterionScore(r), 0);
    const totalTask = evaluatedTask.length;
    const taskScore = totalTask > 0 ? taskScoreSum / totalTask : undefined;

    const evaluatedTrajectory = trajectoryResults.filter(isScorable);
    const trajectoryScoreSum = evaluatedTrajectory.reduce((sum, r) => sum + criterionScore(r), 0);
    const totalTrajectory = evaluatedTrajectory.length;
    const trajectoryScore = totalTrajectory > 0 ? trajectoryScoreSum / totalTrajectory : undefined;

    // Weighted average — only include dimensions that have criteria
    let weightedSum = 0;
    let weightSum = 0;
    if (goalScore !== undefined) {
      weightedSum += goalScore * suite.weights.goal;
      weightSum += suite.weights.goal;
    }
    if (taskScore !== undefined) {
      weightedSum += taskScore * suite.weights.task;
      weightSum += suite.weights.task;
    }
    if (trajectoryScore !== undefined) {
      weightedSum += trajectoryScore * suite.weights.trajectory;
      weightSum += suite.weights.trajectory;
    }
    // No criterion actually scored this run — every criterion was ineligible
    // (Plane B), inapplicable (input absent), skipped, sampled out, or
    // errored (judge_error). On a CLEAN run, skip the eval rather than emit
    // a misleading 0/fail verdict that would poison score/regression/Coach
    // signal. A genuinely failed run still falls through to run-terminal
    // coverage below, which forces 'fail' (Plan 183c).
    const allResults = [...goalResults, ...allTaskCriterionResults, ...trajectoryResults];
    const hasScorableCriteria = allResults.some(isScorable);
    const terminalFailed =
      params.runTerminal.runStatus === 'failed' ||
      params.runTerminal.failedRequiredTaskIds.length > 0;
    if (!hasScorableCriteria && !terminalFailed) {
      logger.info(
        `evalRunner: ${workflowSlug} run=${runId} — no scorable criteria (all ineligible/skipped/errored), skipping eval`,
      );
      return {
        decision: 'no_scorable_criteria',
        suiteContentHash,
        ...(judgeSelections !== undefined ? { judgeSelection: judgeSelections } : {}),
      };
    }

    // Conservative default: empty suites get 0 (not 1). Trust must be earned, not assumed.
    const overall = weightSum > 0 ? weightedSum / weightSum : 0;

    // 8. Determine verdict
    let verdict: 'pass' | 'fail' | 'partial';
    if (overall >= 1) {
      verdict = 'pass';
    } else if (overall <= 0) {
      verdict = 'fail';
    } else {
      // Pass if overall >= 0.7, partial otherwise
      verdict = overall >= 0.7 ? 'pass' : overall >= 0.3 ? 'partial' : 'fail';
    }

    const coverage = applyRunTerminalCoverage({
      verdict,
      overall,
      coverage: params.runTerminal,
    });
    verdict = coverage.verdict;
    const coveredOverall = coverage.overall;
    if (coverage.syntheticResult) {
      goalResults.push(coverage.syntheticResult);
    }

    // 9. Classify faults
    const fault =
      verdict !== 'pass'
        ? classifyFault(taskResults, {
            goalResults,
            taskResults: evalTaskResults,
            trajectoryResults,
          })
        : undefined;

    // 10. Determine remediation owner
    let suggestedRemediationOwner: 'learner' | 'operator' | 'platform_team' | 'none' | undefined;
    if (fault) {
      switch (fault.layer) {
        case 'agent':
          suggestedRemediationOwner = 'learner';
          break;
        case 'configuration':
          suggestedRemediationOwner = 'operator';
          break;
        case 'platform':
          suggestedRemediationOwner = 'platform_team';
          break;
        case 'environment':
          suggestedRemediationOwner = 'none';
          break;
      }
    }

    const evaluationDurationMs = Date.now() - startTime;

    // 11. Build EvalResult
    const evalResult: EvalResult = EvalResultSchema.parse({
      id: randomUUID(),
      runId,
      sessionId,
      verdict,
      goalResults,
      taskResults: evalTaskResults,
      trajectoryResults,
      faultLayer: fault?.layer,
      faultEvidence: fault?.evidence,
      scores: {
        goalScore,
        taskScore,
        trajectoryScore,
        overall: coveredOverall,
      },
      confidence: judgeSelection.selections.some((s) => s.selection === 'evaluated')
        ? 'medium'
        : 'high',
      suggestedRemediationOwner,
      evaluatedAt: new Date().toISOString(),
      evaluationDurationMs,
    });

    // 12. Store result
    await storeEvalResult(db, tenantId, spaceId, workflowSlug, runId, evalResult);

    // 13. Check baseline for regression
    const baselineResult = await updateBaseline({
      tenantId,
      spaceId,
      workflowSlug,
      newResult: evalResult,
      db,
    });

    // 14. Emit entity events
    await emitEvalCompleted(redis, {
      tenantId,
      spaceId,
      sessionId,
      workflowSlug,
      runId,
      result: evalResult,
    });

    if (baselineResult.regressionDetected) {
      await emitEvalRegression(redis, {
        tenantId,
        spaceId,
        sessionId,
        workflowSlug,
        runId,
        breachCount: baselineResult.breachCount,
        overallScore: evalResult.scores.overall,
      });
    }

    logger.info(
      `evalRunner: ${workflowSlug} run=${runId} verdict=${verdict} overall=${String(overall)} ` +
        `(goal=${String(goalScore ?? 'n/a')} task=${String(taskScore ?? 'n/a')} trajectory=${String(trajectoryScore ?? 'n/a')})` +
        (baselineResult.regressionDetected
          ? ` REGRESSION (${String(baselineResult.breachCount)} breaches)`
          : ''),
    );

    const returnScores: EvalRunResult['scores'] = { overall: evalResult.scores.overall };
    if (evalResult.scores.goalScore !== undefined)
      returnScores.goalScore = evalResult.scores.goalScore;
    if (evalResult.scores.taskScore !== undefined)
      returnScores.taskScore = evalResult.scores.taskScore;
    if (evalResult.scores.trajectoryScore !== undefined)
      returnScores.trajectoryScore = evalResult.scores.trajectoryScore;

    const returnResult: EvalRunResult = {
      resultId: evalResult.id,
      verdict: evalResult.verdict,
      scores: returnScores,
      regressionDetected: baselineResult.regressionDetected,
    };
    if (evalResult.faultLayer) returnResult.faultLayer = evalResult.faultLayer;
    if (evalResult.faultEvidence) returnResult.faultEvidence = evalResult.faultEvidence;
    if (evalResult.suggestedRemediationOwner) {
      returnResult.suggestedRemediationOwner = evalResult.suggestedRemediationOwner;
    }

    return {
      decision: 'ran',
      suiteContentHash,
      result: returnResult,
      ...(judgeSelections !== undefined ? { judgeSelection: judgeSelections } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`evalRunner: failed to evaluate ${workflowSlug} run=${runId}: ${message}`);

    // Eval errors don't block the procedure run — log and return error verdict
    const errorResult: EvalResult = EvalResultSchema.parse({
      id: randomUUID(),
      runId,
      sessionId,
      verdict: 'error',
      goalResults: [],
      taskResults: {},
      trajectoryResults: [],
      scores: { overall: 0 },
      confidence: 'low',
      evaluatedAt: new Date().toISOString(),
      evaluationDurationMs: Date.now() - startTime,
    });

    // Best-effort storage of error result
    try {
      await storeEvalResult(db, tenantId, spaceId, workflowSlug, runId, errorResult);
    } catch {
      // Swallow — the primary error is more important
    }

    return {
      decision: 'error',
      ...(suiteContentHash !== undefined ? { suiteContentHash } : {}),
      ...(judgeSelections !== undefined ? { judgeSelection: judgeSelections } : {}),
      message,
      result: {
        resultId: errorResult.id,
        verdict: 'error',
        scores: { overall: 0 },
        regressionDetected: false,
      },
    };
  }
}
