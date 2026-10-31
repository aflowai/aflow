import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ScheduleDispatchItem } from '@aflow/database';
import { resolvePayloadStore } from '@aflow/payload-store';
import { backgroundTaskControlPlane, PlanNodeNextInputSchema } from '@aflow/schemas';
import {
  createPlanNodeStore,
  createPlanStreamReads,
  nextOnPlanBoard,
  residentPendingKey,
} from '@aflow/cybernetic-runtime';

export async function residentOccurrenceDue(
  db: PostgresJsDatabase,
  redis: Redis,
  item: ScheduleDispatchItem,
  runId: string,
): Promise<boolean> {
  const runtime = backgroundTaskControlPlane().resolve('orchestrator.resident_due_check');
  if (runtime.mode !== 'enabled') return false;
  if (item.idempotencyKey.startsWith(`schedule:${item.scheduleId}:wake:`)) return true;
  if ((await redis.get(residentPendingKey(item.tenantId, item.spaceId))) !== null) return true;
  const payload = resolvePayloadStore({ redis });
  if (!payload) throw new Error('Resident due check requires a payload store');
  const result = await nextOnPlanBoard(
    {
      store: createPlanNodeStore(db, item.tenantId),
      reads: createPlanStreamReads({ db, payloadStore: payload.store }, item.tenantId),
      redis,
      tenantId: item.tenantId,
      spaceId: item.spaceId,
      holder: runId,
      preview: true,
    },
    PlanNodeNextInputSchema.parse({}),
  );
  if (!result.ok) throw new Error(result.message);
  return result.output.decisions.length > 0 || result.output.propose !== undefined;
}
