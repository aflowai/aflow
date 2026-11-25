import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/** The `SessionHotState` field naming the dry run a session works for. */
export const DRY_RUN_OF_FIELD = 'dryRunOf';

/**
 * The dry run `sessionId` works for, or null when it works for none. One field
 * read, so an executor about to send a write can ask without loading the
 * session's whole state.
 */
export async function getSessionDryRunOf(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<string | null> {
  const value = await redis.hget(StreamKeys.sessionStateKey(tenantId, sessionId), DRY_RUN_OF_FIELD);
  return value === null || value === '' ? null : value;
}

/** The `SessionHotState` field naming the dry-run task a session works for. */
export const DRY_RUN_TASK_ID_FIELD = 'dryRunTaskId';

export interface SessionDryRunLink {
  dryRunOf: string;
  dryRunTaskId?: string;
}

/**
 * The dry run and task `sessionId` works for, read as raw fields, or null when
 * it works for no dry run. A hash that no longer parses as `SessionHotState`
 * still answers, so a writer that replaces it can carry both fields through.
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
