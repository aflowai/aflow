/**
 * Inline handlers for the eval-batch slice (Plan 269 D17). `eval.batch.run`
 * is the VALIDATE-then-persist launch: it freezes the dataset membership,
 * pins the skill revision, runs the cost preflight against the operator's
 * ceiling, assembles the provenance manifest, and hands the queued batch to
 * the durable worker — it never dispatches a trial itself. The reads
 * narrate durable state only. Authority is structural, not prose: only the
 * Helmsman preset carries these ops, and every Runner surface excludes the
 * `eval.` prefix. The launch/view/compare assemblies live in
 * `@aflow/cybernetic-runtime` — shared verbatim with the operator
 * Measurement REST surface so the two trusted surfaces cannot drift.
 */
import { createByokAiClientFactory } from '@aflow/credential-resolver';
import { getDatabase } from '@aflow/database';
import { getSessionStateSafe } from '@aflow/redis';
import { readDurableSessionCreatedBy } from '../../../cybernetic/harness/helpers.js';
import {
  EvalBatchCompareInputSchema,
  EvalBatchCompareOutputSchema,
  EvalBatchGetInputSchema,
  EvalBatchListInputSchema,
  EvalBatchListOutputSchema,
  EvalBatchRunInputSchema,
  type EvalBatchComparison,
  type TenantId,
} from '@aflow/schemas';
import {
  buildEvalBatchDetail,
  buildEvalBatchList,
  launchEvalBatch,
  resolveEvalBatchComparison,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { parseEvalOpInput } from './evalGoldenDataset.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

const DEFAULT_LIST_LIMIT = 20;

// ============================================================================
// eval.batch.run
// ============================================================================

/**
 * Whether this space can obtain a client for the judge model. The judge
 * resolves at space scope only, so a personal key does not answer for it.
 */
async function probeSpaceJudgeCredential(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  spaceId: string,
  model: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    await createByokAiClientFactory(db).getClientForModel(model, { tenantId, spaceId });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleEvalBatchRunInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId: TenantId = args.context.tenantId;
    const input = await parseEvalOpInput(
      args,
      EvalBatchRunInputSchema,
      'EVAL_BATCH_RUN_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    // The batch runs on the credentials of the operator behind this session,
    // not on the agent's behalf: `createdBy` is what every trial's agent turn
    // resolves its model against. Hot state can be gone (terminal flush), so
    // fall back to the durable session row before giving up.
    const callerState = await getSessionStateSafe(args.redis, tenantId, args.context.runId);
    const createdByUserId =
      (callerState.ok ? callerState.state.createdBy : undefined) ??
      (await readDurableSessionCreatedBy(getDatabase(), tenantId, args.context.runId));

    const result = await launchEvalBatch({
      db: getDatabase(),
      tenantId,
      spaceId,
      input,
      createdByUserId,
      probeJudgeCredential: (model) =>
        probeSpaceJudgeCredential(getDatabase(), tenantId as string, spaceId, model),
    });
    if (!result.ok) {
      await emitStepError(args, result.code, result.message, startTime, 'validation');
      return;
    }

    const { output } = result;
    logger.info(
      `[eval.batch.run] batch=${output.batchId} slug=${output.workflowSlug} r${String(output.workflowRevision)} ` +
        `cases=${String(output.caseCount)} trials=${String(output.trialsPerCase)} ceiling=${String(input.costCeilingCents)}`,
    );
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[eval.batch.run] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_BATCH_RUN_FAILED', 'operation failed', startTime);
  }
}

// ============================================================================
// eval.batch.get / list
// ============================================================================

export async function handleEvalBatchGetInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId: TenantId = args.context.tenantId;
    const input = await parseEvalOpInput(
      args,
      EvalBatchGetInputSchema,
      'EVAL_BATCH_GET_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const detail = await buildEvalBatchDetail(getDatabase(), tenantId, {
      spaceId,
      batchId: input.batchId,
    });
    if (!detail) {
      await emitStepError(
        args,
        'EVAL_BATCH_NOT_FOUND',
        `No eval batch '${input.batchId}' exists in this space. Discover batches with eval.batch.list.`,
        startTime,
        'validation',
      );
      return;
    }
    await emitStepSuccess(args, detail, startTime);
  } catch (err) {
    logger.error(
      `[eval.batch.get] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_BATCH_GET_FAILED', 'operation failed', startTime);
  }
}

// ============================================================================
// eval.batch.compare
// ============================================================================

function formatSigned(value: number): string {
  const pct = (value * 100).toFixed(1);
  return value >= 0 ? `+${pct}pp` : `${pct}pp`;
}

function comparisonSummary(comparison: EvalBatchComparison): string {
  if (comparison.pairedCases === 0 || comparison.perCaseSuccess === undefined) {
    return `No paired deltas are computable. ${comparison.uncertaintyNote}`;
  }
  const d = comparison.perCaseSuccess;
  const investigation = comparison.flips.filter((f) => f.finding === 'investigation').length;
  const headline =
    `pass^k ${(d.rateA * 100).toFixed(1)}% → ${(d.rateB * 100).toFixed(1)}% ` +
    `(Δ ${formatSigned(d.delta)}, 95% CI [${formatSigned(d.intervalLower)}, ${formatSigned(d.intervalUpper)}], ` +
    `n=${String(comparison.pairedCases)} paired cases).`;
  const flipLine =
    comparison.flips.length > 0
      ? ` ${String(comparison.flips.length)} per-case flip(s), ${String(investigation)} regression-tier (investigation — read the linked transcripts).`
      : ' No per-case flips.';
  return `${headline}${flipLine} ${comparison.uncertaintyNote}`;
}

export async function handleEvalBatchCompareInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId: TenantId = args.context.tenantId;
    const input = await parseEvalOpInput(
      args,
      EvalBatchCompareInputSchema,
      'EVAL_BATCH_COMPARE_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const resolution = await resolveEvalBatchComparison(getDatabase(), tenantId, spaceId, input);
    if (!resolution.ok) {
      await emitStepError(args, resolution.code, resolution.message, startTime, 'validation');
      return;
    }
    const output = EvalBatchCompareOutputSchema.parse({
      comparison: resolution.comparison,
      ...(resolution.baselineBatchId !== undefined
        ? { baselineBatchId: resolution.baselineBatchId }
        : {}),
      graduationCandidates: resolution.graduationCandidates,
      summary: comparisonSummary(resolution.comparison),
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[eval.batch.compare] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_BATCH_COMPARE_FAILED', 'operation failed', startTime);
  }
}

export async function handleEvalBatchListInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId: TenantId = args.context.tenantId;
    const input = await parseEvalOpInput(
      args,
      EvalBatchListInputSchema,
      'EVAL_BATCH_LIST_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const batches = await buildEvalBatchList(getDatabase(), tenantId, {
      spaceId,
      workflowSlug: input.workflowSlug,
      limit: input.limit ?? DEFAULT_LIST_LIMIT,
    });
    await emitStepSuccess(args, EvalBatchListOutputSchema.parse({ batches }), startTime);
  } catch (err) {
    logger.error(
      `[eval.batch.list] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_BATCH_LIST_FAILED', 'operation failed', startTime);
  }
}
