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
