import { createTenantContext, getDatabase, withTenantSchema } from '@aflow/database';
import { SCHEDULE_RENEWAL_WINDOW, scheduleFiringsLeft } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { requireScheduleAuthority } from './scheduleAuthority.js';
import { renewSchedule, tenantScheduleRenewalStore } from './scheduleRenewal.js';
import { scheduleConfigProblem } from './scheduleTargetConfig.js';

export async function handleRenew(
  args: InlineHandlerArgs,
  spaceId: string,
  predecessorId: string,
  startTime: number,
): Promise<void> {
  const authority = await requireScheduleAuthority(args, spaceId, startTime);
  if (!authority) return;

  const db = getDatabase();
  const outcome = await withTenantSchema(db, createTenantContext(args.context.tenantId), (tx) =>
    renewSchedule(tenantScheduleRenewalStore(tx), {
      spaceId,
      predecessorId,
      grant: authority.grant,
      configProblem: (schedule) => scheduleConfigProblem(db, args.context.tenantId, schedule),
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
    case 'config_refused':
      await emitStepError(
        args,
        'SCHEDULE_CONFIG_NOT_DECLARED',
        `Schedule ${predecessorId} was not renewed: ${outcome.message}`,
        startTime,
        'validation',
      );
      return;
    case 'renewed':
      break;
  }

  const { successor } = outcome;
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
