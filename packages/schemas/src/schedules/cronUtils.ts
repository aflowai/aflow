import { Cron } from 'croner';

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    // Validate by constructing — croner throws on invalid expressions
    const job = new Cron(expression, { timezone: 'UTC' });
    job.stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}

/**
 * Compute the next fire time for a cron expression.
 * Returns ISO 8601 string or null if no future occurrence.
 *
 * @param expression - Standard 5-field cron expression
 * @param timezone - IANA timezone (default: UTC)
 * @param from - Compute next occurrence after this date (default: now)
 */
export function getNextCronFireTime(
  expression: string,
  timezone = 'UTC',
  from?: Date,
): string | null {
  try {
    const job = new Cron(expression, { timezone });
    const next = job.nextRun(from ?? new Date());
    job.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Validate an IANA timezone identifier.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
