import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sessions } from '@aflow/database';
import type { AgentSystemRole, SessionAgentTarget, SessionStatus } from '@aflow/schemas';

const CONVERSATION_TARGET_KIND = 'platform-role' satisfies SessionAgentTarget['kind'];
const CONVERSATION_SYSTEM_ROLE: AgentSystemRole = 'cybernetic-helmsman';

/**
 * The statuses that end a conversation's hold on its work. FAILED is not one:
 * a failed conversation can be retried, so its runs stay its own meanwhile
 * rather than turning everyone's and back again on the retry.
 */
export const CONVERSATION_ENDED_STATUSES: readonly SessionStatus[] = ['SUCCEEDED', 'CANCELLED'];

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
  return sql<boolean>`case
    when ${runSessionId} is null then false
    when ${sessions.sessionId} is null then true
    else coalesce(
      ${sessions.targetKind} = ${CONVERSATION_TARGET_KIND}
        and ${sessions.targetSystemRole} = ${CONVERSATION_SYSTEM_ROLE}
        and ${sessions.status} not in (${sql.join(
          CONVERSATION_ENDED_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )}),
      false
    )
  end`;
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
