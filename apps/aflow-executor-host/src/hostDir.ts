/**
 * Where this machine's host directory is, for the executor and every command
 * line that edits or asks it. One answer, because two that disagreed meant a
 * command wrote a file the executor never read, and asked for a window no
 * executor was watching for.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOST_POLICY_FILE = 'host-policy.json';

function setting(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The policy file: `PHOENIX_HOST_POLICY_PATH`, else `host-policy.json` in
 * `PHOENIX_HOST_DIR`, else in `~/.aflow`. An empty setting counts as unset.
 * Outside any path a job can write, so a job cannot grant itself a binding by
 * editing the file that lists them.
 */
export function resolveHostPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = setting(env, 'PHOENIX_HOST_POLICY_PATH');
  if (configured !== undefined) return configured;
  return join(setting(env, 'PHOENIX_HOST_DIR') ?? join(home, '.aflow'), HOST_POLICY_FILE);
}

/** The directory holding the policy: pairing's credential, the profiles and the request files live there. */
export function resolveHostDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return dirname(resolveHostPolicyPath(env, home));
}
