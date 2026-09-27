/**
 * Bring a resting session's hot state back from its durable snapshot.
 *
 * A session that parks — on user input, on a workflow run, on a sub-agent —
 * takes no further writes, so its Redis hash and step hashes age out at the
 * hot-state TTL while the wait is still legitimate. The snapshot the
 * projection worker flushes at rest is what makes that survivable: it carries
 * the run hot state and every step hot state, so the session is cold rather
 * than gone. Every path that needs to touch a possibly-cold session — resume,
 * a room post, waking a parked waiter — restores it through here.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { SessionId, TenantId } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import {
  SessionHotStateSchema,
  StepHotStateSchema,
  getSessionStateSafe,
  setSessionState,
  setStepStateIfAbsent,
} from '@aflow/redis';
import { createTenantContext, createSessionRepository } from '@aflow/database';

export async function rehydratePausedRun(
  redis: Redis,
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<SessionHotState | null> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const runRepo = createSessionRepository(db, tenantContext);
  const row = await runRepo.getById(runId as SessionId);

  if (row?.status !== 'PAUSED' && row?.status !== 'WAITING_ON_CHILD') return null;

  const snapshot = row.hotStateSnapshot as {
    runHotState?: unknown;
    stepHotStates?: Record<string, unknown>;
  } | null;

  if (!snapshot?.runHotState) return null;

  const runParsed = SessionHotStateSchema.safeParse(snapshot.runHotState);
  if (!runParsed.success) return null;

  await setSessionState(redis, runParsed.data);

  if (snapshot.stepHotStates) {
    for (const stepData of Object.values(snapshot.stepHotStates)) {
      const stepParsed = StepHotStateSchema.safeParse(stepData);
      if (stepParsed.success) {
        // Create-if-absent for the same reason the single-step path uses it:
        // a step present here outlived the session hash and is therefore newer
        // than this resting snapshot, and a concurrent wake that completed one
        // must not be rolled back to the parked copy it started from.
        await setStepStateIfAbsent(redis, stepParsed.data);
      }
    }
  }

  return runParsed.data;
}

/**
 * Restore the one parked step a waiter is waiting on, without disturbing a
 * session that is still warm.
 *
 * A session hash and its step hashes expire independently: a room post
 * refreshes the session and bumps `lastMessageSeq` on it, and touches no step.
 * So a caller parked past the TTL can have a live session and a cold step, and
 * rewriting the session from its resting snapshot there would roll
 * `lastMessageSeq` back and hand two room messages the same position — the
 * exact loss the counter lives on hot state to avoid. Only when the session is
 * gone too is the whole snapshot the newest thing there is.
 *
 * @returns whether the step is present after this call.
 */
export async function rehydrateParkedStep(
  redis: Redis,
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
): Promise<boolean> {
  const sessionState = await getSessionStateSafe(redis, tenantId, runId);
  if (!sessionState.ok) {
    return (await rehydratePausedRun(redis, db, tenantId, runId)) !== null;
  }

  const snapshot = await loadRestingSnapshot(db, tenantId, runId);
  const stepData = snapshot?.stepHotStates?.[stepExecutionId];
  if (!stepData) return false;
  const stepParsed = StepHotStateSchema.safeParse(stepData);
  if (!stepParsed.success) return false;

  // Create-if-absent, not write: a step that came back under us between the
  // miss and here is newer than anything the snapshot holds, and a plain write
  // would roll a wake that already landed back to the parked snapshot it came
  // from. Either outcome leaves the step present, which is all the caller asked.
  await setStepStateIfAbsent(redis, stepParsed.data);
  return true;
}

interface RestingSnapshot {
  runHotState?: unknown;
  stepHotStates?: Record<string, unknown>;
}

async function loadRestingSnapshot(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<RestingSnapshot | null> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const runRepo = createSessionRepository(db, tenantContext);
  const row = await runRepo.getById(runId as SessionId);
  if (row?.status !== 'PAUSED' && row?.status !== 'WAITING_ON_CHILD') return null;
  return (row.hotStateSnapshot as RestingSnapshot | null) ?? null;
}
