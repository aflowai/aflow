import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/** The `SessionHotState` field naming the dry run a session works for. */
export const DRY_RUN_OF_FIELD = 'dryRunOf';

/** The `SessionHotState` field naming the dry-run task a session works for. */
export const DRY_RUN_TASK_ID_FIELD = 'dryRunTaskId';

export interface SessionDryRunLink {
  dryRunOf: string;
  dryRunTaskId?: string;
}

/**
 * The dry run and task `sessionId`'s hash names, read as raw fields, or null
 * when it names none. A hold reads this as a fast path only: a null answer
 * says nothing durable, so `resolveSessionDryRun` then reads the session's
 * link and its run's row in Postgres.
 */
export async function getSessionDryRunLink(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<SessionDryRunLink | null> {
  const [dryRunOf, dryRunTaskId] = await redis.hmget(
    StreamKeys.sessionStateKey(tenantId, sessionId),
    DRY_RUN_OF_FIELD,
    DRY_RUN_TASK_ID_FIELD,
  );
  if (dryRunOf === null || dryRunOf === undefined || dryRunOf === '') return null;
  return {
    dryRunOf,
    ...(typeof dryRunTaskId === 'string' && dryRunTaskId !== '' ? { dryRunTaskId } : {}),
  };
}
