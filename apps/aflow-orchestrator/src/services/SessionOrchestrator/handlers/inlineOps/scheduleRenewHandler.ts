import { randomUUID } from 'node:crypto';

import { createTenantContext, getDatabase, withTenantSchema } from '@aflow/database';
import { SCHEDULE_RENEWAL_WINDOW, scheduleFiringsLeft } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { requireScheduleAuthority } from './scheduleAuthority.js';
import { renewSchedule, tenantScheduleRenewalStore } from './scheduleRenewal.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

export async function handleRenew(
  args: InlineHandlerArgs,
  spaceId: string,
  predecessorId: string,
  startTime: number,
): Promise<void> {
  const authority = await requireScheduleAuthority(args, spaceId, startTime);
  if (!authority) return;

  const outcome = await withTenantSchema(
    getDatabase(),
    createTenantContext(args.context.tenantId),
    (tx) =>
      renewSchedule(tenantScheduleRenewalStore(tx), {
        spaceId,
        predecessorId,
        grant: authority.grant,
        sessionId: authority.sessionId,
      }),
  );

  switch (outcome.kind) {
    case 'not_found':
      await emitStepError(
        args,
        'SCHEDULE_NOT_FOUND',
        `Schedule ${predecessorId} not found in this space: nothing was renewed.`,
        startTime,
        'not_found',
      );
      return;
    case 'not_owner':
      await emitStepError(
        args,
        'SCHEDULE_RENEWAL_NOT_OWNER',
        `Schedule ${predecessorId} runs as another user, and only its creator renews it: a successor would run as this run's user instead. Nothing was renewed.`,
        startTime,
        'permission',
      );
      return;
    case 'not_due': {
      const { predecessor } = outcome;
      const left = scheduleFiringsLeft(predecessor);
      await emitStepError(
        args,
        'SCHEDULE_RENEWAL_NOT_DUE',
        `Schedule ${predecessorId} is not due for renewal: it is a ${predecessor.kind} schedule, ${predecessor.status}, with ${left === null ? 'no firing cap' : `${String(left)} firings left`}${predecessor.expiresAt ? `, expiring ${predecessor.expiresAt.toISOString()}` : ''}. Only an active recurring schedule within ${String(SCHEDULE_RENEWAL_WINDOW)} firings of its maxFirings, and short of its expiresAt, is renewed — agent.schedule.get reports renewalDue.`,
        startTime,
        'validation',
      );
      return;
    }
    case 'renewed':
      break;
  }

  const { successor } = outcome;
  if (outcome.created) await announceScheduleArmed(args, spaceId, successor);
  await emitStepSuccess(
    args,
    {
      scheduleId: successor.id,
      name: successor.name,
      kind: successor.kind,
      status: successor.status,
      maxFirings: successor.maxFirings,
      nextFireAt: successor.nextFireAt ? successor.nextFireAt.toISOString() : null,
      expiresAt: successor.expiresAt ? successor.expiresAt.toISOString() : null,
      createdAt: successor.createdAt.toISOString(),
    },
    startTime,
  );
}

/**
 * The Action Center reads schedules from the database, so a connected client
 * learns about a new one only when something wakes its topic. Nothing else on
 * this path does, and an operator who is already looking at the space is
 * exactly the person the notice is for — without this it arrives on the next
 * reconnect, which reads as the platform having kept it quiet.
 */
export async function announceScheduleArmed(
  args: InlineHandlerArgs,
  spaceId: string,
  row: { id: string; name: string; kind: string },
): Promise<void> {
  const { context } = args;
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.schedule.armed',
        spaceId,
        tenantId: context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: { scheduleId: row.id, kind: row.kind },
        summary: `Scheduled "${row.name}"`,
      },
    });
  } catch (err) {
    // A schedule that exists and was not announced is recoverable on the next
    // wake; failing the step that created it is not.
    getOrchestratorLogger().warn('[scheduleCrud] armed-event publish failed', {
      err,
      scheduleId: row.id,
    });
  }
}
