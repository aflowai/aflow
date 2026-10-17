import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether the lockfile changed after the last `yarn install` finished, which
 * writes its state file last. No state file means nothing was ever installed.
 */
export function installIsStale(repo) {
  const mtime = (file) => {
    try {
      return statSync(join(repo, file)).mtimeMs;
    } catch {
      return undefined;
    }
  };
  const installed = mtime('node_modules/.yarn-state.yml');
  const lock = mtime('yarn.lock');
  return installed === undefined || (lock !== undefined && lock > installed);
}
