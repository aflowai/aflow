import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, sessions, withTenantSchema } from '@aflow/database';
import type { AgentSystemRole, SessionAgentTarget, SessionStatus, TenantId } from '@aflow/schemas';

const CONVERSATION_TARGET_KIND = 'platform-role' satisfies SessionAgentTarget['kind'];
const CONVERSATION_SYSTEM_ROLE: AgentSystemRole = 'cybernetic-helmsman';

/**
 * The statuses that end a conversation's hold on its work. FAILED is not one:
 * a failed conversation can be retried, so its runs stay its own meanwhile
 * rather than turning everyone's and back again on the retry.
 */
export const CONVERSATION_ENDED_STATUSES: readonly SessionStatus[] = ['SUCCEEDED', 'CANCELLED'];

/**
 * The statuses in which a conversation cannot act: ended, or failed. Work that
 * waits on someone to act treats such a conversation as no one, so its pull
 * request is tended and its branch's cases are handed over until a retry.
 */
export const CONVERSATION_NOT_ACTING_STATUSES: readonly SessionStatus[] = [
  ...CONVERSATION_ENDED_STATUSES,
  'FAILED',
];

/** Whether a session in `status` is a Helmsman conversation that no longer owns its work. */
export function endsConversationOwnership(
  target: SessionAgentTarget,
  status: SessionStatus,
): boolean {
  return (
    target.kind === CONVERSATION_TARGET_KIND &&
    target.systemRole === CONVERSATION_SYSTEM_ROLE &&
    CONVERSATION_ENDED_STATUSES.includes(status)
  );
}

/**
 * Whether the run whose `session_id` is `runSessionId`, with the `sessions`
 * row it names joined, is held by a Helmsman conversation that still owns it.
 * A run no session drove is no conversation's. A run whose session has no row
 * yet is held: the projection writes that row after the run starts, and the
 * run-start bump caches the block before it lands, so reading the absent row
 * as everyone's would show another conversation's run in full until the
 * run's next transition.
 */
export function drivenByLiveConversationSql(runSessionId: SQL | AnyPgColumn): SQL<boolean> {
  return drivenByConversationNotInSql(runSessionId, CONVERSATION_ENDED_STATUSES);
}

/**
 * Whether the run is held by a Helmsman conversation that can act now: one
 * that has neither ended nor failed, by the rule {@link isActingConversation}
 * reads. A run whose session has no row yet is held, as in
 * {@link drivenByLiveConversationSql}.
 */
export function drivenByActingConversationSql(runSessionId: SQL | AnyPgColumn): SQL<boolean> {
  return drivenByConversationNotInSql(runSessionId, CONVERSATION_NOT_ACTING_STATUSES);
}

function drivenByConversationNotInSql(
  runSessionId: SQL | AnyPgColumn,
  statuses: readonly SessionStatus[],
): SQL<boolean> {
  return sql<boolean>`case
    when ${runSessionId} is null then false
    when ${sessions.sessionId} is null then true
    else coalesce(
      ${sessions.targetKind} = ${CONVERSATION_TARGET_KIND}
        and ${sessions.targetSystemRole} = ${CONVERSATION_SYSTEM_ROLE}
        and ${sessions.status} not in (${sql.join(
          statuses.map((status) => sql`${status}`),
          sql`, `,
        )}),
      false
    )
  end`;
}

/**
 * Whether `sessionId` is a Helmsman conversation that has not ended: one that
 * still holds its work, by the rule {@link drivenByLiveConversationSql} reads.
 * A session with no row is not held here, since this asks about a session
 * named long after it started.
 */
export async function isLiveConversation(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<boolean> {
  return conversationNotIn(db, tenantId, sessionId, CONVERSATION_ENDED_STATUSES);
}

/**
 * Whether `sessionId` is a Helmsman conversation that can act now: one that
 * has neither ended nor failed. A failed conversation still holds its work
 * for a retry, but nothing acts on that work until the retry comes, so work
 * that waits on someone to act treats it as no one.
 */
export async function isActingConversation(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<boolean> {
  return conversationNotIn(db, tenantId, sessionId, CONVERSATION_NOT_ACTING_STATUSES);
}

async function conversationNotIn(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  statuses: readonly SessionStatus[],
): Promise<boolean> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx
      .select({
        targetKind: sessions.targetKind,
        targetSystemRole: sessions.targetSystemRole,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  );
  const row = rows[0];
  if (row === undefined) return false;
  return (
    row.targetKind === CONVERSATION_TARGET_KIND &&
    row.targetSystemRole === CONVERSATION_SYSTEM_ROLE &&
    !statuses.includes(row.status as SessionStatus)
  );
}

/** Who reads the space's work: a session, and the plan roots its conversation has taken up. */
export interface AttentionReader {
  sessionId: string;
  planRootIds: ReadonlySet<string>;
}

/** A run, or an attention item about one: where it sits in the plan, and who drove it. */
export interface OwnedWork {
  plan?: { rootId: string };
  /** The session that drove the run. */
  sessionId?: string;
  /**
   * `sessionId` names a Helmsman conversation that still owns the run, or a
   * session not yet projected (`drivenByLiveConversationSql`).
   */
  drivenByLiveConversation: boolean;
}

/**
 * Whether a run, or an attention item about one, is the reader's. Placed in
 * the plan, it is when the reader has taken up its root. Placed nowhere, it is
 * when the reader drove it or no conversation owns it: the operator's run, or
 * an ended conversation's, is everyone's.
 */
export function isReadersWork(work: OwnedWork, reader: AttentionReader): boolean {
  if (work.plan !== undefined) return reader.planRootIds.has(work.plan.rootId);
  return !work.drivenByLiveConversation || work.sessionId === reader.sessionId;
}
