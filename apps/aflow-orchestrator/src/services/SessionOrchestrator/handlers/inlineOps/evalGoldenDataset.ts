/**
 * Inline handlers for the agent-permitted eval-plane slice (Plan 269 D7):
 * golden-dataset reads and run→draft-case promotion. Every dataset WRITE
 * (case add/update/remove, ratification, labels) is an operator-only server
 * route — these handlers never mutate an active dataset version, and the
 * promote path only ever inserts a draft.
 */
import { Buffer } from 'node:buffer';
import type { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  createTenantContext,
  campaigns,
  getDatabase,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import {
  EvalCasePromoteInputSchema,
  EvalCasePromoteOutputSchema,
  EvalDatasetGetInputSchema,
  EvalDatasetGetOutputSchema,
  EvalDatasetListInputSchema,
  EvalDatasetListOutputSchema,
  type FixtureMemoryDoc,
  type PayloadRef,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import {
  buildDraftCaseFromRun,
  extractMemoryReadCandidates,
  extractOtherMemoryReads,
  insertGoldenCaseDraft,
  listGoldenDatasets,
  loadGoldenDatasetBundle,
  memoryDocFromOutput,
  selectReferenceOutputTask,
  type PromotableTaskFacts,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

/** CLAUDE.md payload discipline: small (<64KB) → inline ref. */
const INLINE_REF_MAX_BYTES = 64 * 1024;

function inlineRef(data: unknown): PayloadRef | null {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > INLINE_REF_MAX_BYTES) return null;
  return `inline:${Buffer.from(json, 'utf8').toString('base64')}`;
}

/**
 * A golden case is permanent while run payloads are TTL-bound on the Redis
 * backend, so every ref a case carries must be durable: inline when small,
 * else PayloadStore with `persist` (D1). The `slot`-derived stepExecutionId
 * gives each stored artifact its own deterministic path — payload paths are
 * per (step, attempt, kind), and the promote step stores several.
 */
async function durableRef(
  args: InlineHandlerArgs,
  data: unknown,
  slot: string,
): Promise<PayloadRef> {
  const inline = inlineRef(data);
  if (inline !== null) return inline;
  return args.payloadStore.store({
    tenantId: args.context.tenantId,
    runId: args.context.runId,
    stepExecutionId: `${args.stepExecutionId}:${slot}` as StepExecutionId,
    attempt: args.attempt,
    kind: 'body',
    data,
    persist: true,
  });
}

function decodeInlineRef(ref: string): unknown {
  if (!ref.startsWith('inline:')) return null;
  try {
    return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export async function parseEvalOpInput<Output>(
  args: InlineHandlerArgs,
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  errorCode: string,
  startTime: number,
): Promise<Output | null> {
  let raw: unknown = decodeInlineRef(args.resolvedInputRef);
  if (raw === null && !args.resolvedInputRef.startsWith('inline:')) {
    try {
      raw = await args.payloadStore.retrieve(args.resolvedInputRef);
    } catch {
      raw = null;
    }
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    await emitStepError(
      args,
      errorCode,
      `Invalid input for ${args.stepDef.operation}: ${issues}`,
      startTime,
      'validation',
    );
    return null;
  }
  return parsed.data;
}

// ============================================================================
// eval.dataset.get
// ============================================================================

export async function handleEvalDatasetGetInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const input = await parseEvalOpInput(
      args,
      EvalDatasetGetInputSchema,
      'EVAL_DATASET_GET_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const loaded = await loadGoldenDatasetBundle(getDatabase(), args.context.tenantId, {
      spaceId,
      workflowSlug: input.workflowSlug,
      version: input.version,
    });
    if (!loaded.ok) {
      if (loaded.code === 'version_not_found') {
        await emitStepError(
          args,
          'EVAL_DATASET_VERSION_NOT_FOUND',
          `Dataset version ${String(input.version)} does not exist for skill '${input.workflowSlug}' — ` +
            `the dataset is at version ${String(loaded.currentVersion)}. Versions are monotonic and only ` +
            `past versions can be reconstructed; omit 'version' for the latest.`,
          startTime,
          'validation',
        );
        return;
      }
      await emitStepError(
        args,
        'EVAL_DATASET_NOT_FOUND',
        `No golden dataset exists for skill '${input.workflowSlug}' in this space. One is created when the operator adds a case or a run is promoted to a draft.`,
        startTime,
        'validation',
      );
      return;
    }

    const output = EvalDatasetGetOutputSchema.parse(loaded.bundle);
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[eval.dataset.get] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_DATASET_GET_FAILED', 'operation failed', startTime);
  }
}

// ============================================================================
// eval.dataset.list
// ============================================================================

export async function handleEvalDatasetListInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const input = await parseEvalOpInput(
      args,
      EvalDatasetListInputSchema,
      'EVAL_DATASET_LIST_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const datasets = await listGoldenDatasets(getDatabase(), args.context.tenantId, spaceId);
    const output = EvalDatasetListOutputSchema.parse({ datasets });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[eval.dataset.list] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_DATASET_LIST_FAILED', 'operation failed', startTime);
  }
}

// ============================================================================
// eval.case.promote (D14)
// ============================================================================

export async function handleEvalCasePromoteInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId: TenantId = args.context.tenantId;
    const input = await parseEvalOpInput(
      args,
      EvalCasePromoteInputSchema,
      'EVAL_CASE_PROMOTE_INVALID_INPUT',
      startTime,
    );
    if (!input) return;

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const loaded = await withTenantSchema(db, tenantCtx, async (tx) => {
      const [runRow] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.runId, input.runId), eq(workflowRuns.spaceId, spaceId)))
        .limit(1);
      if (!runRow) return null;
      const taskRows = await tx
        .select()
        .from(workflowRunTasks)
        .where(eq(workflowRunTasks.runId, input.runId));
      const [campaignRow] = runRow.campaignId
        ? await tx
            .select({ config: campaigns.config })
            .from(campaigns)
            .where(eq(campaigns.id, runRow.campaignId))
            .limit(1)
        : [];
      return { runRow, taskRows, campaignConfig: campaignRow?.config ?? undefined };
    });

    if (!loaded) {
      await emitStepError(
        args,
        'EVAL_CASE_PROMOTE_RUN_NOT_FOUND',
        `Run '${input.runId}' was not found in this space.`,
        startTime,
        'validation',
      );
      return;
    }

    const { runRow, taskRows, campaignConfig } = loaded;
    const tasks: PromotableTaskFacts[] = taskRows.map((row) => ({
      taskId: row.taskId,
      status: row.status,
      operationId: row.operationId,
      outputRef: row.outputRef,
      ...(row.completedAt ? { completedAtMs: row.completedAt.getTime() } : {}),
      failureReason: row.failureReason,
    }));

    // Best-effort memory-read mining: fetch each plain-get output and
    // re-store the doc body durably into the fixture. Non-get reads
    // (search/query/list/…) are never attempted — the miner notes them
    // distinctly instead of recording a false recovery gap.
    const memoryDocs: FixtureMemoryDoc[] = [];
    const memoryGapTaskIds: string[] = [];
    const seenPaths = new Set<string>();
    for (const candidate of extractMemoryReadCandidates(tasks)) {
      try {
        const output = await args.payloadStore.retrieve(candidate.outputRef);
        const doc = memoryDocFromOutput(output);
        if (!doc) {
          memoryGapTaskIds.push(candidate.taskId);
          continue;
        }
        if (seenPaths.has(doc.path)) continue;
        const contentRef = await durableRef(
          args,
          { path: doc.path, content: doc.content },
          `doc-${String(memoryDocs.length)}`,
        );
        seenPaths.add(doc.path);
        memoryDocs.push({ path: doc.path, contentRef });
      } catch {
        memoryGapTaskIds.push(candidate.taskId);
      }
    }

    const failureRef =
      runRow.failureJson != null
        ? await durableRef(args, runRow.failureJson, 'failure')
        : undefined;

    // The provenance ref the miner will pick (reference output, or the
    // counterexample fallback when the run failed without a failure payload)
    // is re-stored durably in place; a ref that is already unreadable is
    // dropped so the miner records the gap instead of enshrining a dangling
    // pointer. Paused runs carry no provenance ref — nothing to re-store.
    const wantsProvenanceOutput =
      runRow.status === 'completed' || (runRow.status === 'failed' && failureRef === undefined);
    if (wantsProvenanceOutput) {
      let referenceTask = selectReferenceOutputTask(tasks);
      while (referenceTask && typeof referenceTask.outputRef === 'string') {
        try {
          const output = await args.payloadStore.retrieve(referenceTask.outputRef);
          referenceTask.outputRef = await durableRef(args, output, 'reference-output');
          break;
        } catch {
          referenceTask.outputRef = null;
          referenceTask = selectReferenceOutputTask(tasks);
        }
      }
    }

    const draft = buildDraftCaseFromRun({
      run: {
        runId: runRow.runId,
        workflowSlug: runRow.workflowSlug,
        status: runRow.status,
        pausedReason: runRow.pausedReason,
        workflowRevision: runRow.workflowRevision,
        campaignId: runRow.campaignId,
        metadata: runRow.metadata,
        ...(failureRef !== undefined ? { failureRef } : {}),
      },
      tasks,
      ...(campaignConfig !== undefined
        ? { campaignConfig: campaignConfig as Record<string, unknown> }
        : {}),
      memoryDocs,
      memoryGapTaskIds,
      otherMemoryReads: extractOtherMemoryReads(tasks),
      title: input.title,
      notes: input.notes,
    });
    if (!draft.ok) {
      await emitStepError(
        args,
        `EVAL_CASE_PROMOTE_${draft.code.toUpperCase()}`,
        draft.detail,
        startTime,
        'validation',
      );
      return;
    }

    const inserted = await insertGoldenCaseDraft(db, tenantId, {
      spaceId,
      workflowSlug: runRow.workflowSlug,
      content: draft.content,
    });

    const output = EvalCasePromoteOutputSchema.parse({
      draftRevisionId: inserted.revisionId,
      caseId: inserted.caseId,
      datasetId: inserted.datasetId,
      workflowSlug: runRow.workflowSlug,
      status: 'draft',
      datasetVersion: inserted.datasetVersion,
      mined: draft.mined,
      missing: draft.missing,
      summary:
        `Drafted a golden case from ${runRow.status} run ${runRow.runId} of '${runRow.workflowSlug}'. ` +
        `Mined: ${draft.mined.join('; ') || 'nothing'}. ` +
        (draft.missing.length > 0 ? `Needs the operator: ${draft.missing.join('; ')}. ` : '') +
        'The draft awaits operator review and ratification — it is not part of the dataset yet.',
    });

    logger.info(
      `[eval.case.promote] run=${runRow.runId} → draft=${inserted.revisionId} dataset=${inserted.datasetId} mined=${String(draft.mined.length)} missing=${String(draft.missing.length)}`,
    );
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    logger.error(
      `[eval.case.promote] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(args, 'EVAL_CASE_PROMOTE_FAILED', 'operation failed', startTime);
  }
}
