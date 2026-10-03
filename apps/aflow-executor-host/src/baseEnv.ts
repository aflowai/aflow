/**
 * What a confined workload inherits from the executor.
 *
 * Passing the executor's own environment through was handing every command and
 * every harness the credentials that environment holds — pairing writes
 * `REDIS_URL` with its password into the file the executor is started from, and
 * `PHOENIX_INSTANCE_SECRET` sits beside it. A confined command could read both
 * with `env`, and a harness, which has egress, could send them somewhere.
 *
 * So the inheritance is named rather than wholesale. The list is fail-closed:
 * a variable nobody thought about is absent, not present, and a secret added to
 * the executor's environment later does not silently join it. What it does
 * carry is the shape of a working shell and the roots of the toolchains this
 * lane exists to reach — a command that cannot find the operator's node or
 * their virtualenv is not worth confining.
 *
 * The temporary directory is set rather than inherited, under every name a
 * toolchain reads it by. It is the run's own, inside its scratch, which is
 * writable inside the policy, so a tool that needs one finds one it is allowed
 * to use. The system's own is writable under no posture: on Linux every run's
 * scratch lives there, so a run able to write it could write another's
 * checkout, or the policy and status files the sandbox reads for it.
 *
 * `HOME` is set for exactly the same reason, and passing it through was the
 * mistake that reasoning was meant to prevent. Home is denied as a region, so
 * telling a command its home is the operator's real one names a place it will
 * be refused — and almost every tool reads something under it before doing any
 * work. `git log` never reached the repository: it opened `~/.gitconfig`, got
 * EPERM, and exited 128. The same waits for ssh, npm, pip and anything else
 * with a dotfile. A home inside the scratch is one they may actually read and
 * write, holding no configuration and no credentials, which is what confinement
 * was supposed to mean.
 */

/** The shape of a shell: enough for a command to run and report itself. */
const SHELL_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
] as const;

/**
 * Where the operator's toolchains live. These are roots and version-manager
 * pointers, not secrets; withholding them breaks the interpreter the lane was
 * connected for, which is the failure that makes people stop confining things.
 */
const TOOLCHAIN_NAMES = [
  'ASDF_DIR',
  'CARGO_HOME',
  'CONDA_PREFIX',
  'GEM_HOME',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
  'NVM_DIR',
  'PNPM_HOME',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'RUSTUP_HOME',
  'SDKMAN_DIR',
  'VIRTUAL_ENV',
  'VOLTA_HOME',
] as const;

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const INHERITED_ENV_NAMES: readonly string[] = [...SHELL_NAMES, ...TOOLCHAIN_NAMES];

/**
 * The home a confined workload is given. Under the scratch, so it is removed
 * with the run rather than accumulating, and writable because the scratch is.
 * Created by {@link createWorkloadDirs} — a tool handed a `HOME` that does not
 * exist fails in its own way, which is no better than the EPERM this replaces.
 */
function workloadHome(scratchDir: string): string {
  return join(scratchDir, 'home');
}

/** The temporary directory a confined workload is given, beside its home. */
export function workloadTemp(scratchDir: string): string {
  return join(scratchDir, 'tmp');
}

/**
 * Every name a toolchain reads its temporary directory by. `TMPDIR` alone is
 * POSIX; Windows-born tools read `TMP` and `TEMP`, and Claude Code puts the
 * file its shell records the working directory in where
 * `CLAUDE_CODE_TMPDIR` says, and in `/tmp` otherwise, whatever `TMPDIR` says.
 */
export const WORKLOAD_TEMP_ENV_NAMES = ['TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CODE_TMPDIR'] as const;

/** The home and the temporary directory {@link buildBaseEnv} names, made before the spawn. */
export async function createWorkloadDirs(scratchDir: string): Promise<void> {
  for (const dir of [workloadHome(scratchDir), workloadTemp(scratchDir)]) {
    await mkdir(dir, { recursive: true });
  }
}

export function buildBaseEnv(
  scratchDir: string,
  extraNames: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...INHERITED_ENV_NAMES, ...extraNames]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of WORKLOAD_TEMP_ENV_NAMES) env[name] = workloadTemp(scratchDir);
  env['HOME'] = workloadHome(scratchDir);
  return env;
}
