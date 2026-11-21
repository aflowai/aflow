import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  createTenantContext,
  memoryDocs,
  memoryDocVersions,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
  type TenantId,
} from '@aflow/schemas';
import {
  approvedThesesIssues,
  type ApprovedSetRead,
  type ApprovedSetWriter,
} from '@aflow/platform-artifacts';

/**
 * The Daily Trading Cycle's `decide` output opens a thesis only as an
 * instance of an approved entry of the set for its (tradingDay, slot). The
 * set is a document in the space's memory, so this rule reads it at
 * submission, with the writer the memory store recorded for its current
 * version. That provenance is what keeps a cycle task from approving its own
 * theses. A read that fails refuses every output.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_APPROVED_THESES_VALIDATOR_REF = 'trading.approved-theses' as const;

/** The executor's actor on every write made from a run. It never writes without a session. */
const RUN_WRITE_ACTOR = 'executor';

export async function readApprovedSet(
  ctx: RuntimeValidatorContext,
  path: string,
): Promise<ApprovedSetRead> {
  let found: { content: string; sessionId: string | null; actor: string | null } | undefined;
  let run: Extract<ApprovedSetWriter, { kind: 'session' }>['run'] = null;
  try {
    const db = ctx.db as PostgresJsDatabase;
    const tenant = createTenantContext(ctx.tenantId as TenantId);
    const read = await withTenantSchema(db, tenant, async (tx) => {
      const docs = await tx
        .select({
          version: memoryDocVersions.version,
          content: memoryDocVersions.inlineContent,
          sessionId: memoryDocVersions.createdBySessionId,
          actor: memoryDocVersions.createdByActor,
        })
        .from(memoryDocs)
        .leftJoin(
          memoryDocVersions,
          and(
            eq(memoryDocVersions.docId, memoryDocs.id),
            eq(memoryDocVersions.version, memoryDocs.currentVersion),
          ),
        )
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            eq(memoryDocs.path, path),
            isNull(memoryDocs.deletedAt),
          ),
        )
        .limit(1);
      const doc = docs[0];
      if (!doc?.sessionId) return { doc, runs: [] };
      const runs = await tx
        .select({
          runId: workflowRuns.runId,
          workflowSlug: workflowRuns.workflowSlug,
          status: workflowRuns.status,
          spaceId: workflowRuns.spaceId,
        })
        .from(workflowRuns)
        .leftJoin(workflowRunTasks, eq(workflowRunTasks.runId, workflowRuns.runId))
        .where(
          or(
            eq(workflowRuns.sessionId, doc.sessionId),
            eq(workflowRunTasks.workerSessionId, doc.sessionId),
            eq(workflowRunTasks.sessionId, doc.sessionId),
          ),
        )
        .limit(1);
      return { doc, runs };
    });
    if (!read.doc) return { status: 'missing' };
    if (read.doc.version === null) {
      return { status: 'unreadable', reason: 'its current version is not recorded' };
    }
    if (read.doc.content === null) {
      return { status: 'unreadable', reason: 'the document is not stored inline' };
    }
    found = { content: read.doc.content, sessionId: read.doc.sessionId, actor: read.doc.actor };
    run = read.runs[0] ?? null;
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }

  let content: unknown;
  try {
    content = JSON.parse(found.content) as unknown;
  } catch (err) {
    return {
      status: 'unreadable',
      reason: `its content is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (found.sessionId) {
    return {
      status: 'found',
      content,
      writer: { kind: 'session', sessionId: found.sessionId, run },
    };
  }
  if (found.actor === null || found.actor === RUN_WRITE_ACTOR) {
    return { status: 'unreadable', reason: 'its current version records no writer' };
  }
  return { status: 'found', content, writer: { kind: 'operator', actor: found.actor } };
}

async function tradingApprovedThesesValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const issues = await approvedThesesIssues(data, {
    spaceId: ctx.spaceId,
    read: (path) => readApprovedSet(ctx, path),
  });
  return issues.map((issue) => ({ code: 'custom' as const, ...issue }));
}

registerRuntimeValidator(TRADING_APPROVED_THESES_VALIDATOR_REF, tradingApprovedThesesValidator);
