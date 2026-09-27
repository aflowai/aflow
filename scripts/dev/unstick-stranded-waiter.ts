#!/usr/bin/env tsx
/**
 * One-off recovery for a Helmsman session left parked on a workflow run whose
 * wake was dropped: the waiter row is stamped notified but the synthetic step
 * result never landed, because the session's hot state had aged out.
 *
 * Warms the session back up from its durable snapshot and returns the waiter to
 * pending, so the run's next transition wakes the caller for real. Resolve the
 * paused task afterwards — that transition is what delivers the wake.
 *
 *   yarn tsx scripts/dev/unstick-stranded-waiter.ts <tenantId> <runId> [--apply]
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { createTenantContext, withTenantSchema, workflowRunWaiters } from '@aflow/database';
import { getStepState } from '@aflow/redis';
import { rehydrateParkedStep } from '@aflow/cybernetic-runtime';
import type { TenantId } from '@aflow/schemas';

const [tenantId, runId] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!tenantId || !runId) {
  console.error('usage: unstick-stranded-waiter.ts <tenantId> <runId> [--apply]');
  process.exit(1);
}

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sqlClient = postgres(DATABASE_URL);
const db = drizzle(sqlClient);
const redis = new Redis(REDIS_URL);
const ctx = createTenantContext(tenantId as TenantId);

async function main(): Promise<void> {
  const waiters = await withTenantSchema(db, ctx, async (tx) =>
    tx.select().from(workflowRunWaiters).where(eq(workflowRunWaiters.runId, runId)),
  );
  if (waiters.length === 0) {
    console.log(`No waiters for run ${runId}.`);
    return;
  }

  for (const waiter of waiters) {
    const live = await getStepState(redis, tenantId, waiter.waiterStepExecutionId);
    console.log(
      `waiter=${waiter.id} session=${waiter.waiterSessionId} step=${waiter.waiterStepExecutionId}\n` +
        `  notifiedAt=${waiter.notifiedAt?.toISOString() ?? 'null'} outcome=${waiter.notifiedOutcome ?? 'null'} liveStepState=${live ? live.status : 'MISSING'}`,
    );

    // A delivered wake takes the step out of PAUSED — it is set STARTED and
    // then completed by the synthetic result. So a step that is present and
    // still PAUSED under a stamped waiter is the stranded case with the
    // session already warmed by some other read; presence alone would skip it.
    const wakeLanded = live != null && live.status !== 'PAUSED';
    if (wakeLanded || waiter.notifiedAt === null) {
      console.log('  → nothing to repair');
      continue;
    }
    if (!apply) {
      console.log('  → would rehydrate + return to pending (re-run with --apply)');
      continue;
    }

    // A step already present needs nothing restored — warming it again would
    // rewrite a session that other activity may have moved on, for no gain.
    if (live == null) {
      const restored = await rehydrateParkedStep(
        redis,
        db,
        tenantId,
        waiter.waiterSessionId,
        waiter.waiterStepExecutionId,
      );
      if (!restored) {
        console.log('  → no resting snapshot carries this step; cannot be woken');
        continue;
      }
    }
    await withTenantSchema(db, ctx, async (tx) => {
      await tx
        .update(workflowRunWaiters)
        .set({ notifiedAt: null, notifiedOutcome: null })
        .where(eq(workflowRunWaiters.id, waiter.id));
    });
    console.log('  → rehydrated and returned to pending; resolve the paused task to wake it');
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.disconnect();
    await sqlClient.end();
  });
