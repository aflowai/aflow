import type { Redis } from 'ioredis';
import type { CyberneticHookName } from '@aflow/schemas';

import { emitEntityEvent } from './agentTurnIntegration.js';
import { getCyberneticLogger } from './logger.js';

export interface HookSafeContext {
  redis: Redis;
  tenantId: string;
  spaceId: string;
  workflowSlug?: string;
  runId?: string;
}

export interface HookSafeResult<T> {
  ok: true;
  value: T;
}

export interface HookSafeError {
  ok: false;
  error: Error;
}

export type HookSafeOutcome<T> = HookSafeResult<T> | HookSafeError;

/**
 * Execute a cybernetic hook function safely. On success, returns the result.
 * On failure, emits `entity.hook.failed` and returns the error outcome.
 * Never throws.
 */
export async function cyberneticHookSafe<T>(
  hookName: CyberneticHookName,
  fn: () => Promise<T>,
  ctx: HookSafeContext,
): Promise<HookSafeOutcome<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const logger = getCyberneticLogger();
    logger.warn(`cyberneticHookSafe: hook "${hookName}" failed: ${error.message}`);

    // Best-effort emit — if this also fails, log and move on
    try {
      await emitEntityEvent({
        redis: ctx.redis,
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        eventType: 'entity.hook.failed',
        summary: `Hook "${hookName}" failed: ${error.message.slice(0, 200)}`,
        payload: {
          hookName,
          errorMessage: error.message.slice(0, 2048),
          ...(ctx.workflowSlug ? { workflowSlug: ctx.workflowSlug } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        },
      });
    } catch (emitErr) {
      logger.warn(
        `cyberneticHookSafe: failed to emit entity.hook.failed for "${hookName}": ${
          emitErr instanceof Error ? emitErr.message : String(emitErr)
        }`,
      );
    }

    return { ok: false, error };
  }
}
