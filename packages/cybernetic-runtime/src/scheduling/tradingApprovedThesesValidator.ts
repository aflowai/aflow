import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  type Database,
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

/** Bounds each provenance lookup. A writer tied to more runs than this is refused either way. */
const PROVENANCE_ROW_CAP = 50;

type WriterRuns = Pick<Extract<ApprovedSetWriter, { kind: 'session' }>, 'drivenRuns' | 'runs'>;

/** One verdict per writer: every row kept, one per run, in runId order. */
function distinctRuns<T extends { runId: string }>(rows: readonly T[]): T[] {
  const byRun = new Map(rows.map((row) => [row.runId, row]));
  return [...byRun.values()].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

export async function readApprovedSet(
  ctx: RuntimeValidatorContext,
  path: string,
): Promise<ApprovedSetRead> {
  let found:
    | {
        content: string;
        sessionId: string | null;
        stepExecutionId: string | null;
        actor: string | null;
      }
    | undefined;
  let writerRuns: WriterRuns = { drivenRuns: [], runs: [] };
  try {
    const db = ctx.db as Database;
    const tenant = createTenantContext(ctx.tenantId as TenantId);
    const read = await withTenantSchema(db, tenant, async (tx) => {
      const docs = await tx
        .select({
          version: memoryDocVersions.version,
          content: memoryDocVersions.inlineContent,
          sessionId: memoryDocVersions.createdBySessionId,
          stepExecutionId: memoryDocVersions.createdByStepExecutionId,
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
      const none: WriterRuns = { drivenRuns: [], runs: [] };
      if (!doc) return { doc, writerRuns: none };
      // A run's own writer is the worker its dispatch minted for one task:
      // an agent task's runner session, or an operation task's step
      // execution. Nothing else executes as that id.
      const ids = [doc.sessionId, doc.stepExecutionId].filter((id): id is string => id !== null);
      if (ids.length === 0) return { doc, writerRuns: none };
      const executed = await tx
        .select({
          runId: workflowRuns.runId,
          workflowSlug: workflowRuns.workflowSlug,
          status: workflowRuns.status,
          spaceId: workflowRuns.spaceId,
        })
        .from(workflowRunTasks)
        .innerJoin(workflowRuns, eq(workflowRuns.runId, workflowRunTasks.runId))
        .where(inArray(workflowRunTasks.workerSessionId, ids))
        .orderBy(asc(workflowRuns.runId))
        .limit(PROVENANCE_ROW_CAP);
      // The conversation that started or steers a run drives it. It is
      // looked up only to be refused: driving a run never makes it a writer.
      const driven = doc.sessionId
        ? await tx
            .select({ runId: workflowRuns.runId })
            .from(workflowRuns)
            .where(eq(workflowRuns.sessionId, doc.sessionId))
            .orderBy(asc(workflowRuns.runId))
            .limit(PROVENANCE_ROW_CAP)
        : [];
      return {
        doc,
        writerRuns: {
          drivenRuns: distinctRuns(driven).map((r) => r.runId),
          runs: distinctRuns(executed),
        },
      };
    });
    if (!read.doc) return { status: 'missing' };
    if (read.doc.version === null) {
      return { status: 'unreadable', reason: 'its current version is not recorded' };
    }
    if (read.doc.content === null) {
      return { status: 'unreadable', reason: 'the document is not stored inline' };
    }
    found = {
      content: read.doc.content,
      sessionId: read.doc.sessionId,
      stepExecutionId: read.doc.stepExecutionId,
      actor: read.doc.actor,
    };
    writerRuns = read.writerRuns;
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
  if (found.sessionId !== null || found.stepExecutionId !== null) {
    return {
      status: 'found',
      content,
      writer: {
        kind: 'session',
        sessionId: found.sessionId,
        stepExecutionId: found.stepExecutionId,
        ...writerRuns,
      },
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
