import { getOrchestratorLogger } from './orchestratorLogger.js';

/**
 * Coerce a hot-state timestamp to a Date, substituting a fallback for one that
 * is missing or unparseable.
 *
 * Postgres rejects an Invalid Date, which fails the whole projection — so a
 * single corrupt timestamp on one session would otherwise cost that session its
 * durable record entirely, after the retry budget quietly gave up on it. A
 * slightly wrong timestamp and a warning is the better trade.
 */
export function toDateSafe(value: unknown, fallback: Date, label: string): Date {
  if (value === null || value === undefined) return fallback;
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) {
    getOrchestratorLogger().warn(
      `Invalid ${label}=${JSON.stringify(value)} — substituting fallback`,
    );
    return fallback;
  }
  return d;
}
