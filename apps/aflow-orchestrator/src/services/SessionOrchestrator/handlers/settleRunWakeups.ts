import type { TenantId } from '@aflow/schemas';
import type { HarnessDeps } from '../../cybernetic/harness/types.js';
import { wakeSessionForRunWakeups } from '../../cybernetic/harness/sessionWakeup.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';

/**
 * Wake a session that just came to rest for what its runs reported while the
 * turn was running: that was not in the turn's input, and resting here is the
 * first boundary that can read it. A failure leaves the wakeups unread for the
 * next settle or event-wake timer.
 */
export async function wakeForRunWakeupsAtSettle(
  deps: Omit<HarnessDeps, 'db'> & { db?: HarnessDeps['db'] | undefined },
  result: { tenantId: string; sessionId: string },
): Promise<void> {
  if (!deps.db) return;
  try {
    await wakeSessionForRunWakeups(
      { db: deps.db, redis: deps.redis, payloadStore: deps.payloadStore },
      result.tenantId as TenantId,
      result.sessionId,
      { armWakeOnStoreError: true },
    );
  } catch (err) {
    logOrchestratorError('[applyAgentDecision] could not wake for unread run wakeups', err, {
      tenantId: result.tenantId,
      sessionId: result.sessionId,
    });
  }
}
