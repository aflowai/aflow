import { createTenantContext, getDatabase, withTenantSchema } from '@aflow/database';
import { getRunAccessGrant, getSessionState } from '@aflow/redis';
import { PLAN_RESIDENT_SCHEDULE_VARIABLE, PlanNodeNextInputSchema } from '@aflow/schemas';
import {
  createPlanStreamReads,
  nextInPlanStream,
  nextOnPlanBoard,
  type PlanStreamContext,
} from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess } from '../helpers.js';
import { renewSchedule, tenantScheduleRenewalStore } from '../scheduleRenewal.js';
import { scheduleConfigProblem } from '../scheduleTargetConfig.js';
import { emitPlanError, parsePlanInput, planReadContext } from './shared.js';

/** The resident schedule that started this wake, as its config handed it over. */
async function wakeScheduleId(args: InlineHandlerArgs): Promise<string | undefined> {
  const state = await getSessionState(args.redis, args.context.tenantId, args.context.runId);
  const entry = state?.runtimeState?.variables[PLAN_RESIDENT_SCHEDULE_VARIABLE] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const value = entry?.ref?.kind === 'inline' ? entry.ref.value : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A wake renews the schedule that started it once it is within the renewal
 * window of its firing cap (Plan 331 D1), as the shepherd's pass does: the
 * same successor however many wakes find it due, and none for a schedule its
 * owner paused. Best effort — a wake that cannot renew still decides, and the
 * next wake inside the window tries again.
 */
async function renewWakeSchedule(args: InlineHandlerArgs, spaceId: string): Promise<void> {
  try {
    const scheduleId = await wakeScheduleId(args);
    if (scheduleId === undefined) return;
    const grant = await getRunAccessGrant(args.redis, args.context.tenantId, args.context.runId);
    if (!grant) return;
    const db = getDatabase();
    await withTenantSchema(db, createTenantContext(args.context.tenantId), (tx) =>
      renewSchedule(tenantScheduleRenewalStore(tx), {
        spaceId,
        predecessorId: scheduleId,
        grant,
        configProblem: (schedule) => scheduleConfigProblem(db, args.context.tenantId, schedule),
      }),
    );
  } catch (err) {
    getOrchestratorLogger().warn(
      `plan.node.next: renewing the resident schedule failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      { tenantId: args.context.tenantId, sessionId: args.context.runId },
    );
  }
}

export async function handlePlanNodeNext(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<void> {
  const input = await parsePlanInput(args, PlanNodeNextInputSchema, startTime);
  if (!input) return;
  const reads = createPlanStreamReads(
    { db: getDatabase(), payloadStore: args.payloadStore },
    args.context.tenantId as string,
  );
  const ctx: PlanStreamContext = {
    ...planReadContext(args),
    reads,
    redis: args.redis,
    tenantId: args.context.tenantId as string,
    holder: args.context.runId as string,
  };
  const result =
    input.rootNodeId !== undefined
      ? await nextInPlanStream(ctx, input.rootNodeId, input)
      : await nextOnPlanBoard(ctx, input);
  if (!result.ok) {
    await emitPlanError(args, result, startTime);
    return;
  }
  if (input.rootNodeId === undefined) await renewWakeSchedule(args, ctx.spaceId);
  await emitStepSuccess(args, result.output as unknown as Record<string, unknown>, startTime);
}
