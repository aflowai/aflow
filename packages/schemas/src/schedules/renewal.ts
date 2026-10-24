import type { FlowSchedule } from './schedule.js';

/**
 * How many firings before its cap a recurring schedule may be renewed. A pass
 * started by the schedule sees it once per firing, so a window wider than one
 * firing outlasts passes that fail or are skipped: five at every five minutes
 * is twenty-five minutes of them.
 */
export const SCHEDULE_RENEWAL_WINDOW = 5;

type RenewalFacts = Pick<
  FlowSchedule,
  'kind' | 'status' | 'maxFirings' | 'firingCount' | 'expiresAt'
>;

/** Firings left before the cap expires the schedule; null where nothing caps it. */
export function scheduleFiringsLeft(
  schedule: Pick<FlowSchedule, 'maxFirings' | 'firingCount'>,
): number | null {
  if (schedule.maxFirings === null || schedule.maxFirings === undefined) return null;
  return Math.max(schedule.maxFirings - schedule.firingCount, 0);
}

/**
 * Whether a successor may take this schedule over. Only a recurring schedule
 * its owner keeps active renews: a paused, deleted or expired one stays as its
 * owner left it, and a one-shot fires once by definition. Renewal resets the
 * firing cap only — the successor keeps the predecessor's `expiresAt`, so a
 * chain of renewals still ends at its owner's time bound, and one already past
 * it has nothing left to renew.
 */
export function isScheduleRenewalDue(schedule: RenewalFacts, now: Date = new Date()): boolean {
  if (schedule.kind !== 'cron' || schedule.status !== 'active') return false;
  if (
    schedule.expiresAt !== null &&
    schedule.expiresAt !== undefined &&
    new Date(schedule.expiresAt) <= now
  ) {
    return false;
  }
  const left = scheduleFiringsLeft(schedule);
  return left !== null && left <= SCHEDULE_RENEWAL_WINDOW;
}
