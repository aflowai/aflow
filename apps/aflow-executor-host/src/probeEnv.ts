import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

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

/** True when the executable can be started: an absolute path, or a name found on PATH. */
export async function executableResolves(executable: string): Promise<boolean> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (probeEnv()['PATH'] ?? '')
        .split(delimiter)
        .filter((dir) => dir !== '')
        .map((dir) => join(dir, executable));
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  return false;
}
