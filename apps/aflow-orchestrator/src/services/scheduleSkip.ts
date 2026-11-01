/**
 * A schedule occurrence a gate skips: the resident heartbeat's overlap check,
 * or the shepherd sweep's due check. A skip starts no run and spends none of
 * the firing cap, since only model wakes can renew it. It moves the schedule
 * to its next cron time from now, which prevents a catch-up backlog.
 */
import type postgres from 'postgres';
import { getNextCronFireTime } from '@aflow/schemas';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';

/**
 * Which gate skipped an occurrence. The gate names the metadata key that
 * counts its skips: `overlap` for the resident heartbeat, `sweep` for the
 * shepherd's due check.
 */
export type OccurrenceSkip = { gate: 'overlap'; inFlight: string | null } | { gate: 'sweep' };

/** The columns of a due schedule a skip reads. */
export interface SkippedSchedule {
  id: string;
  tenant_schema: string;
  tenant_id: string;
  name: string;
  cron_expression: string | null;
  timezone: string;
  status: string;
  firing_count: number;
  next_fire_at_text: string | null;
}

function describeSkip(skip: OccurrenceSkip): {
  detailKey: string;
  detail: string | null;
  why: string;
} {
  if (skip.gate === 'sweep') {
    return {
      detailKey: 'reason',
      detail: 'no_unattended_pull_request',
      why: 'no open loop pull request is unattended, so the sweep waits',
    };
  }
  return {
    detailKey: 'inFlightSessionId',
    detail: skip.inFlight,
    why: skip.inFlight === null ? 'the board waits' : `wake ${skip.inFlight} has not ended`,
  };
}

/** Move the schedule past one occurrence without firing it, guarded as the advance is. */
export async function skipScheduleOccurrence(
  sql: Pick<postgres.Sql, 'unsafe'>,
  schedule: SkippedSchedule,
  skip: OccurrenceSkip,
): Promise<void> {
  const nextFireAt =
    schedule.cron_expression !== null
      ? getNextCronFireTime(schedule.cron_expression, schedule.timezone)
      : null;
  const { detailKey, detail, why } = describeSkip(skip);
  await sql.unsafe(
    `UPDATE "${schedule.tenant_schema}".agent_schedules
        SET next_fire_at = $1::timestamptz,
            metadata = jsonb_set(
              coalesce(metadata, '{}'::jsonb),
              '{${skip.gate}}',
              jsonb_build_object(
                'skipped', coalesce((metadata -> '${skip.gate}' ->> 'skipped')::int, 0) + 1,
                'lastSkippedAt', to_jsonb(NOW()),
                '${detailKey}', to_jsonb($2::text)
              )
            ),
            updated_at = NOW()
      WHERE id = $3::uuid
        AND firing_count = $4::int
        AND status = $5
        AND next_fire_at IS NOT DISTINCT FROM $6::timestamptz`,
    [
      nextFireAt,
      detail,
      schedule.id,
      schedule.firing_count,
      schedule.status,
      schedule.next_fire_at_text,
    ],
  );
  getOrchestratorLogger().info(
    `[ScheduleEvaluator] Skipped an occurrence of "${schedule.name}": ${why}`,
    { scheduleId: schedule.id, tenantId: schedule.tenant_id },
  );
}
