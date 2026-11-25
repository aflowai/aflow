/**
 * Whether a session works for a dry run, resolved for a hold decision at the
 * moment of dispatch. The session hash is a fast path only: a hash naming a
 * dry run holds at once. Every other answer comes from Postgres. The session's
 * durable link names its run, and the run's row says whether it is a dry run.
 *
 * Every dry-run session is linked before its hot state exists, so a session
 * with no link is live, whatever its hash says. A null, corrupt, quarantined
 * or deleted hash therefore falls back to the link and the run row. A link or
 * row that cannot be read answers `unknown`, and the caller must not dispatch.
 */
import type { Redis } from 'ioredis';
import { readDryRunSession, readWorkflowRunDryRun, type Database } from '@aflow/database';
import { getSessionDryRunLink } from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';

/** What a session's dispatch knows of the dry run it works for. */
export type SessionDryRun =
  | { kind: 'live' }
  | { kind: 'dry_run'; runId: string; taskId?: string }
  | { kind: 'unknown'; reason: string };

/** The dry-run fields of a session hash a caller has already read. */
export interface SessionDryRunHashFields {
  dryRunOf?: string | undefined;
  dryRunTaskId?: string | undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The dry run `sessionId` works for. Pass the fields of a state the caller
 * has parsed as `hash`, or null when that read found no state. Omit it, and
 * the two raw fields are read from the hash.
 */
export async function resolveSessionDryRun(
  deps: { db: Database; redis: Redis },
  tenantId: string,
  sessionId: string,
  hash?: SessionDryRunHashFields | null,
): Promise<SessionDryRun> {
  let fast: SessionDryRunHashFields | null | undefined = hash;
  if (fast === undefined) {
    try {
      fast = await getSessionDryRunLink(deps.redis, tenantId, sessionId);
    } catch {
      fast = null;
    }
  }
  if (fast?.dryRunOf !== undefined) {
    return {
      kind: 'dry_run',
      runId: fast.dryRunOf,
      ...(fast.dryRunTaskId !== undefined ? { taskId: fast.dryRunTaskId } : {}),
    };
  }

  let link: Awaited<ReturnType<typeof readDryRunSession>>;
  try {
    link = await readDryRunSession(deps.db, tenantId as TenantId, sessionId);
  } catch (err) {
    return {
      kind: 'unknown',
      reason: `the dry-run link of session ${sessionId} could not be read: ${messageOf(err)}`,
    };
  }
  if (link === null) return { kind: 'live' };

  let dryRun: boolean;
  try {
    dryRun = await readWorkflowRunDryRun(deps.db, tenantId as TenantId, link.runId);
  } catch (err) {
    return {
      kind: 'unknown',
      reason: `the row of run ${link.runId} could not be read: ${messageOf(err)}`,
    };
  }
  if (!dryRun) return { kind: 'live' };
  return {
    kind: 'dry_run',
    runId: link.runId,
    ...(link.taskId !== undefined ? { taskId: link.taskId } : {}),
  };
}
