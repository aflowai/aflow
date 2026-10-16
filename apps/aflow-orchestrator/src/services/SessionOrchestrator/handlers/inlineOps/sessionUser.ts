import { getDatabase } from '@aflow/database';
import { getSessionStateSafe } from '@aflow/redis';
import { readDurableSessionCreatedBy } from '../../../cybernetic/harness/helpers.js';
import type { InlineHandlerArgs } from './types.js';

/** Who started the session. Hot state can be gone after a terminal flush, so the durable session row answers then. */
export async function sessionUser(args: InlineHandlerArgs): Promise<string | undefined> {
  const { tenantId, runId } = args.context;
  const state = await getSessionStateSafe(args.redis, tenantId, runId);
  return (
    (state.ok ? state.state.createdBy : undefined) ??
    (await readDurableSessionCreatedBy(getDatabase(), tenantId, runId))
  );
}
