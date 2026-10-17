/**
 * Enough to find and run one of the operator's programs, and nothing this
 * executor holds: its environment carries the Redis credential pairing wrote,
 * and a program found on `PATH` has no use for it.
 */
export function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
