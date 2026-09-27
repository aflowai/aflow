import { and, eq } from 'drizzle-orm';
import type {
  ArtifactInspectListInput,
  ArtifactInspectListOutput,
  ArtifactInspectReadInput,
  ArtifactInspectReadOutput,
  ArtifactInspectTargetKind,
  EntityDirectives,
  TenantId,
} from '@aflow/schemas';
import { EntityDirectivesSchema, isStableInspectPath } from '@aflow/schemas';
import {
  getDatabase,
  createTenantContext,
  withTenantSchema,
  sessions,
  stepExecutions,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { loadCoachReviewContext } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================
// Router
// ============================================================================

export async function handleArtifactInspectInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input falls through to schema validation */
    }

    switch (operationId) {
      case 'artifact.inspect.list':
        await handleInspectList(args, input as unknown as ArtifactInspectListInput, startTime);
        break;
      case 'artifact.inspect.read':
        await handleInspectRead(args, input as unknown as ArtifactInspectReadInput, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown artifact.inspect operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'ARTIFACT_INSPECT_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================
// Shared gate
// ============================================================================

interface InspectGateOk {
  ok: true;
  directives: EntityDirectives['learningPolicy']['coachEvidenceExploration'];
}
interface InspectGateRejected {
  ok: false;
  code: string;
  message: string;
}

async function runInspectGate(
  args: InlineHandlerArgs,
  targetKind: ArtifactInspectTargetKind,
): Promise<InspectGateOk | InspectGateRejected> {
  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();

  // Load CoachReviewContext for this Coach session.
  const reviewContext = await loadCoachReviewContext({
    db,
    tenantId: tenantIdStr,
    spaceId,
    coachSessionId: args.context.runId,
  });

  if (!reviewContext) {
    return {
      ok: false,
      code: 'COACH_REVIEW_CONTEXT_MISSING',
      message:
        'No CoachReviewContext is persisted for this Coach session — deliberate inspection requires a typed review context (Plan 163 §6.1).',
    };
  }

  // Load directives to read coachEvidenceExploration knobs.
  let directives: EntityDirectives | undefined;
  try {
    const { spaces, withTenantSchema: wts } = await import('@aflow/database');
    const { eq: eqOp } = await import('drizzle-orm');
    const tenantCtx = createTenantContext(args.context.tenantId);
    const spaceRows = await wts(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eqOp(spaces.id, spaceId))
        .limit(1),
    );
    if (spaceRows[0]?.directives) {
      directives = EntityDirectivesSchema.parse(spaceRows[0].directives);
    } else {
      directives = EntityDirectivesSchema.parse({
        version: 1,
        responsibility: 'fallback',
      } as unknown);
    }
  } catch {
    directives = EntityDirectivesSchema.parse({
      version: 1,
      responsibility: 'fallback',
    } as unknown);
  }

  const exploration = directives.learningPolicy.coachEvidenceExploration;

  if (!exploration.allowedTargetKinds.includes(targetKind)) {
    return {
      ok: false,
      code: 'EVIDENCE_TARGET_KIND_DISALLOWED',
      message: `targetKind='${targetKind}' is not in coachEvidenceExploration.allowedTargetKinds=[${exploration.allowedTargetKinds.join(', ')}].`,
    };
  }

  return { ok: true, directives: exploration };
}

// ============================================================================
// Budget counters (Redis-backed, per-Coach-session)
// ============================================================================

function budgetKey(args: InlineHandlerArgs, kind: 'list' | 'read'): string {
  return `coach:inspect:${args.context.tenantId}:${args.context.runId}:${kind}`;
}

async function incrementAndCheck(
  args: InlineHandlerArgs,
  kind: 'list' | 'read',
  cap: number,
): Promise<{ ok: true; count: number } | { ok: false; count: number }> {
  const key = budgetKey(args, kind);
  // 24h TTL — the Coach session is long-lived enough but counters
  // shouldn't pile up forever for retried sessions.
  const count = await args.redis.incr(key);
  if (count === 1) {
    await args.redis.expire(key, 24 * 60 * 60);
  }
  if (count > cap) return { ok: false, count };
  return { ok: true, count };
}

// ============================================================================
// artifact.inspect.list
// ============================================================================

async function handleInspectList(
  args: InlineHandlerArgs,
  input: ArtifactInspectListInput,
  startTime: number,
): Promise<void> {
  const gate = await runInspectGate(args, input.targetKind);
  if (!gate.ok) {
    await emitStepError(args, gate.code, gate.message, startTime, 'validation');
    return;
  }

  if (input.targetKind === 'task') {
    await emitStepError(
      args,
      'EVIDENCE_TARGET_KIND_DEFERRED',
      `targetKind='task' is not implemented in Phase 4 — use targetKind='run' with path='run/tasks/${input.targetId}/{slice}' instead.`,
      startTime,
      'validation',
    );
    return;
  }

  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();

  const target = await resolveTargetOwnership(
    db,
    tenantIdStr,
    spaceId,
    input.targetKind,
    input.targetId,
  );
  if (target.kind === 'not_found') {
    await emitStepError(
      args,
      'EVIDENCE_TARGET_NOT_FOUND',
      `target ${input.targetKind}='${input.targetId}' is not in space ${spaceId} or does not exist`,
      startTime,
      'validation',
    );
    return;
  }

  const budget = await incrementAndCheck(args, 'list', gate.directives.maxListCallsPerReview);
  if (!budget.ok) {
    await emitStepError(
      args,
      'EVIDENCE_LIST_BUDGET_EXCEEDED',
      `Per-review list-call cap exceeded (${String(gate.directives.maxListCallsPerReview)}). Use the slices already listed.`,
      startTime,
      'validation',
    );
    return;
  }

  const result = await buildIndex(db, tenantIdStr, target);
  await emitStepSuccess(args, result as unknown as Record<string, unknown>, startTime);
}

// ============================================================================
// artifact.inspect.read
// ============================================================================

async function handleInspectRead(
  args: InlineHandlerArgs,
  input: ArtifactInspectReadInput,
  startTime: number,
): Promise<void> {
  const gate = await runInspectGate(args, input.targetKind);
  if (!gate.ok) {
    await emitStepError(args, gate.code, gate.message, startTime, 'validation');
    return;
  }

  if (input.targetKind === 'task') {
    await emitStepError(
      args,
      'EVIDENCE_TARGET_KIND_DEFERRED',
      `targetKind='task' is not implemented in Phase 4 — use targetKind='run' with path='run/tasks/${input.targetId}/{slice}' instead.`,
      startTime,
      'validation',
    );
    return;
  }

  // Path vocabulary check — ad-hoc paths are rejected.
  if (!isStableInspectPath(input.targetKind, input.path)) {
    await emitStepError(
      args,
      'EVIDENCE_PATH_INVALID',
      `Path '${input.path}' is not in the stable vocabulary for targetKind='${input.targetKind}'. Call artifact.inspect.list first; only paths returned there are legal.`,
      startTime,
      'validation',
    );
    return;
  }

  const budget = await incrementAndCheck(args, 'read', gate.directives.maxReadCallsPerReview);
  if (!budget.ok) {
    await emitStepError(
      args,
      'EVIDENCE_READ_BUDGET_EXCEEDED',
      `Per-review read-call cap exceeded (${String(gate.directives.maxReadCallsPerReview)}).`,
      startTime,
      'validation',
    );
    return;
  }

  const spaceId = requireSpaceId(args.context);
  const tenantIdStr = args.context.tenantId as string;
  const db = getDatabase();
  const maxBytes = Math.min(
    input.maxBytes ?? gate.directives.maxBytesPerRead,
    gate.directives.maxBytesPerRead,
  );

  let content: unknown;
  try {
    content = await readSlice(db, tenantIdStr, spaceId, input, args.payloadStore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'EVIDENCE_TARGET_NOT_FOUND', message, startTime, 'validation');
    return;
  }

  if (content === undefined) {
    await emitStepError(
      args,
      'EVIDENCE_SLICE_EMPTY',
      `Slice '${input.path}' resolved to no content for targetKind='${input.targetKind}' targetId='${input.targetId}'.`,
      startTime,
      'validation',
    );
    return;
  }

  // Truncate to byte budget by JSON-serialize → string-truncate. The
  // resulting content may not be valid JSON after truncation; we still
  // return it as a string in that case so the model sees something
  // useful and `truncated=true` signals what happened.
  const json = JSON.stringify(content);
  let outContent: unknown = content;
  let truncated = false;
  let sizeBytes = Buffer.byteLength(json, 'utf8');
  if (sizeBytes > maxBytes) {
    const truncatedString = json.slice(0, maxBytes);
    outContent = truncatedString;
    truncated = true;
    sizeBytes = Buffer.byteLength(truncatedString, 'utf8');
  }

  const out: ArtifactInspectReadOutput = {
    targetKind: input.targetKind,
    targetId: input.targetId,
    path: input.path,
    content: outContent,
    sizeBytes,
    truncated,
  };

  try {
    const ledgerKey = inspectLedgerKey(args);
    const member = `${input.targetKind}|${input.targetId}|${input.path}`;
    await args.redis.sadd(ledgerKey, member);
    await args.redis.expire(ledgerKey, 24 * 60 * 60);
  } catch {
    // best-effort — the read result still returns; validate-outcome
    // degrades gracefully when the ledger is missing.
  }

  await emitStepSuccess(args, out as unknown as Record<string, unknown>, startTime);
}

export function inspectLedgerKey(args: InlineHandlerArgs): string {
  return `coach:inspect:ledger:${args.context.tenantId}:${args.context.runId}`;
}

// (Path vocabulary lives in @aflow/schemas as `isStableInspectPath`.)

// ============================================================================
// Index builder (list)
// ============================================================================

async function buildIndex(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  target: ResolvedRun | ResolvedSession,
): Promise<ArtifactInspectListOutput> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  if (target.kind === 'run') {
    const tasks = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({
          taskId: workflowRunTasks.taskId,
          status: workflowRunTasks.status,
          attempt: workflowRunTasks.attempt,
        })
        .from(workflowRunTasks)
        .where(eq(workflowRunTasks.runId, target.runId)),
    );
    const entries: ArtifactInspectListOutput['entries'] = [
      {
        path: 'run/header',
        kind: 'summary',
        summary: 'Run row summary (status, startedAt, slug).',
      },
      {
        path: 'run/tasks',
        kind: 'list',
        summary: `Index of ${String(tasks.length)} task(s) in this run.`,
      },
      { path: 'run/eval', kind: 'summary', summary: 'Eval result for this run (if assembled).' },
    ];
    for (const t of tasks) {
      entries.push({
        path: `run/tasks/${t.taskId}/meta`,
        kind: 'detail',
        summary: `Task '${t.taskId}' meta (status=${t.status}, attempt=${String(t.attempt)}).`,
      });
      entries.push({
        path: `run/tasks/${t.taskId}/reflection`,
        kind: 'detail',
        summary: `Task '${t.taskId}' RunnerReflection (condition, blockers, missingInputs/Tools).`,
      });
      entries.push({
        path: `run/tasks/${t.taskId}/input`,
        kind: 'payload',
        summary: `Task '${t.taskId}' resolved input payload (PayloadRef).`,
      });
      entries.push({
        path: `run/tasks/${t.taskId}/output`,
        kind: 'payload',
        summary: `Task '${t.taskId}' output payload (PayloadRef).`,
      });
    }
    return {
      targetKind: 'run',
      targetId: target.runId,
      entries: entries.slice(0, 100),
    };
  }

  // session
  const steps = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        stepExecutionId: stepExecutions.stepExecutionId,
        operationId: stepExecutions.operationId,
        status: stepExecutions.status,
      })
      .from(stepExecutions)
      .where(eq(stepExecutions.sessionId, target.sessionId as TenantId)),
  );
  const entries: ArtifactInspectListOutput['entries'] = [
    { path: 'session/meta', kind: 'summary', summary: 'Session row (status, agent, dates).' },
    {
      path: 'session/steps',
      kind: 'list',
      summary: `Index of ${String(steps.length)} step execution(s).`,
    },
  ];
  for (const s of steps.slice(0, 50)) {
    entries.push({
      path: `session/steps/${s.stepExecutionId}`,
      kind: 'detail',
      summary: `Step ${s.stepExecutionId.slice(0, 8)} — ${s.operationId} (${s.status}).`,
    });
  }
  return { targetKind: 'session', targetId: target.sessionId, entries: entries.slice(0, 100) };
}

// ============================================================================
// Slice reader (read)
// ============================================================================

interface ResolvedRun {
  kind: 'run';
  runId: string;
  spaceId: string;
}
interface ResolvedSession {
  kind: 'session';
  sessionId: string;
  spaceId: string;
}
type ResolvedTarget = ResolvedRun | ResolvedSession | { kind: 'not_found' };

async function resolveTargetOwnership(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  spaceId: string,
  targetKind: ArtifactInspectTargetKind,
  targetId: string,
): Promise<ResolvedTarget> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  if (targetKind === 'run') {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ runId: workflowRuns.runId, spaceId: workflowRuns.spaceId })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.runId, targetId), eq(workflowRuns.spaceId, spaceId)))
        .limit(1),
    );
    if (!rows[0]) return { kind: 'not_found' };
    return { kind: 'run', runId: rows[0].runId, spaceId: rows[0].spaceId };
  }
  if (targetKind === 'session') {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ sessionId: sessions.sessionId, spaceId: sessions.spaceId })
        .from(sessions)
        .where(and(eq(sessions.sessionId, targetId as TenantId), eq(sessions.spaceId, spaceId)))
        .limit(1),
    );
    if (!rows[0]) return { kind: 'not_found' };
    return { kind: 'session', sessionId: rows[0].sessionId, spaceId };
  }
  // task targetKind is intentionally not implemented — see P1.3
  // (handler returns a structured error before reaching this resolver).
  return { kind: 'not_found' };
}

async function readSlice(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  spaceId: string,
  input: ArtifactInspectReadInput,
  payloadStore: InlineHandlerArgs['payloadStore'],
): Promise<unknown> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const target = await resolveTargetOwnership(
    db,
    tenantId,
    spaceId,
    input.targetKind,
    input.targetId,
  );
  if (target.kind === 'not_found') {
    throw new Error(
      `target ${input.targetKind}='${input.targetId}' is not in space ${spaceId} or does not exist`,
    );
  }

  // run/* paths — every query is scoped to the verified `target.runId`.
  if (target.kind === 'run') {
    if (input.path === 'run/header') {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(workflowRuns)
          .where(
            and(eq(workflowRuns.runId, target.runId), eq(workflowRuns.spaceId, target.spaceId)),
          )
          .limit(1),
      );
      return rows[0] ?? undefined;
    }
    if (input.path === 'run/tasks') {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({
            taskId: workflowRunTasks.taskId,
            status: workflowRunTasks.status,
            attempt: workflowRunTasks.attempt,
            failureReason: workflowRunTasks.failureReason,
          })
          .from(workflowRunTasks)
          .where(eq(workflowRunTasks.runId, target.runId)),
      );
      return rows;
    }
    if (input.path === 'run/eval') {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ evaluationJson: workflowRuns.evaluationJson })
          .from(workflowRuns)
          .where(
            and(eq(workflowRuns.runId, target.runId), eq(workflowRuns.spaceId, target.spaceId)),
          )
          .limit(1),
      );
      return rows[0]?.evaluationJson ?? undefined;
    }
    const taskMatch = /^run\/tasks\/([A-Za-z0-9._-]+)\/(meta|reflection|input|output)$/.exec(
      input.path,
    );
    if (taskMatch) {
      const taskId = taskMatch[1] ?? '';
      const slice = taskMatch[2] ?? '';
      return readTaskSlice(db, tenantCtx, target.runId, taskId, slice, payloadStore);
    }
    return undefined;
  }

  // session/* paths — every query is scoped to the verified
  // `target.sessionId`. Step reads filter on BOTH stepExecutionId AND
  // sessionId so a leaked id from a different session can't be read.
  if (target.kind === 'session') {
    if (input.path === 'session/meta') {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.sessionId, target.sessionId as TenantId),
              eq(sessions.spaceId, target.spaceId),
            ),
          )
          .limit(1),
      );
      return rows[0] ?? undefined;
    }
    if (input.path === 'session/steps') {
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({
            stepExecutionId: stepExecutions.stepExecutionId,
            operationId: stepExecutions.operationId,
            status: stepExecutions.status,
          })
          .from(stepExecutions)
          .where(eq(stepExecutions.sessionId, target.sessionId as TenantId))
          .limit(50),
      );
      return rows;
    }
    const stepMatch = /^session\/steps\/([A-Za-z0-9._-]+)$/.exec(input.path);
    if (stepMatch) {
      const stepExecutionId = stepMatch[1] ?? '';
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(stepExecutions)
          .where(
            and(
              eq(stepExecutions.stepExecutionId, stepExecutionId as TenantId),
              // Cross-target binding: the step row's sessionId MUST equal
              // the requested target — otherwise a leaked step id from
              // another session would be readable. Filtering at the
              // WHERE level keeps the query plan tight.
              eq(stepExecutions.sessionId, target.sessionId as TenantId),
            ),
          )
          .limit(1),
      );
      return rows[0] ?? undefined;
    }
    return undefined;
  }

  return undefined;
}

async function readTaskSlice(
  db: ReturnType<typeof getDatabase>,
  tenantCtx: ReturnType<typeof createTenantContext>,
  runId: string,
  taskId: string,
  slice: string,
  payloadStore: InlineHandlerArgs['payloadStore'],
): Promise<unknown> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx.select().from(workflowRunTasks).where(eq(workflowRunTasks.runId, runId)).limit(50),
  );
  const row = rows.find((r) => r.taskId === taskId);
  if (!row) return undefined;
  switch (slice) {
    case 'meta': {
      // Strip large payload fields; meta is the table row sans inline JSON.
      const { reflectionJson, metricsJson, ...meta } = row;
      void reflectionJson;
      void metricsJson;
      return meta;
    }
    case 'reflection':
      return row.reflectionJson ?? undefined;
    case 'input':
      return dereferenceTaskPayload(row.inputRef, payloadStore);
    case 'output':
      return dereferenceTaskPayload(row.outputRef, payloadStore);
    default:
      return undefined;
  }
}

async function dereferenceTaskPayload(
  ref: string | null,
  payloadStore: InlineHandlerArgs['payloadStore'],
): Promise<unknown> {
  if (!ref) return undefined;
  try {
    // payloadStore.retrieve accepts a PayloadRef (string) — the same
    // branded type the executor wrote.
    const content = await payloadStore.retrieve(ref as never);
    // Surface the ref alongside the content so the Coach can cite the
    // exact ref in evidence.artifactRefs.
    return { payloadRef: ref, content };
  } catch (err) {
    // Best-effort — if the payload is unreachable (GCS expiry, network
    // hiccup), fall back to the ref string so the Coach at least sees
    // what was supposed to be there.
    return {
      payloadRef: ref,
      content: null,
      retrieveError: err instanceof Error ? err.message : String(err),
    };
  }
}
