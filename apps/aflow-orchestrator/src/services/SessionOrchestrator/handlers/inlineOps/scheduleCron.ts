import { Cron } from 'croner';

/**
 * Estimate the minimum interval between cron firings in seconds.
 * Returns null if unable to compute (fallback: allow).
 */
export function getCronMinIntervalSeconds(expression: string, timezone: string): number | null {
  try {
    const job = new Cron(expression, { timezone });
    const first = job.nextRun();
    if (!first) {
      job.stop();
      return null;
    }
    const second = job.nextRun(new Date(first.getTime() + 1000));
    job.stop();
    if (!second) return null;
    return (second.getTime() - first.getTime()) / 1000;
  } catch {
    return null;
  }
}
