/**
 * The coding agent's git cannot move the operator's branches or tags.
 *
 * A worktree shares its refs with the repository it was added to, so a harness
 * running `git branch -D` or `git update-ref` in its checkout rewrites the
 * operator's branches. Comparing the refs before and after a run sees that, but
 * it cannot say who did it: the operator creating a branch in the folder while
 * a commission runs looks exactly the same. So the stop happens inside the
 * agent's own git, where the actor is known — a `reference-transaction` hook
 * the executor owns, reached through git's environment config, which aborts any
 * transaction in the folder's repository naming `refs/heads/*` or
 * `refs/tags/*`. The worktree's detached `HEAD`, remote-tracking refs and the
 * stash are outside both prefixes and stay free.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { commonGitDir, gitVersionText } from './worktree.js';

const GIT_VERSION_TIMEOUT_MS = 10_000;

/**
 * Git 2.28 is the first release that runs a `reference-transaction` hook. Below
 * it the hook is never invoked, so a commission's git could move a branch and
 * nothing would stop it.
 */
export const REF_GUARD_MIN_GIT_VERSION = { major: 2, minor: 28 } as const;

function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The hook for a run in the folder whose repository directory is
 * `guardedCommonDir`.
 *
 * The environment config reaches every git the run starts, including those in
 * repositories the run creates for itself — a test suite that commits in a
 * directory under the temp root is the common case. Those refs are nobody's but
 * the run's, so the hook refuses only in the folder's own repository, which the
 * run's checkout shares. A repository the hook cannot identify is treated as
 * the folder's.
 *
 * The repository's path is whatever the run's git was told, so it reaches `cd`
 * only as `./`-prefixed or absolute: a name like `-P` is then no option and no
 * `cd -`, and `CDPATH` — cleared as well, since a `cd` through it also prints —
 * is never searched. `IFS` is set to the single space git separates each
 * update's fields with, because `read` splits on it and an inherited one could
 * keep a ref name from matching.
 *
 * Read from stdin whole before deciding: git writes every update of the
 * transaction to the hook, and a hook that stops reading part-way can leave it
 * writing into a closed pipe.
 */
export function referenceTransactionHook(guardedCommonDir: string): string {
  return `#!/bin/sh
[ "$1" = prepared ] || { cat >/dev/null; exit 0; }
unset CDPATH
IFS=' '
common=$(git rev-parse --git-common-dir 2>/dev/null) || common=
case $common in
  '' | /*) ;;
  *) common=./$common ;;
esac
[ -n "$common" ] && common=$(cd -P -- "$common" 2>/dev/null && pwd -P) || common=
[ -z "$common" ] || [ "$common" = ${shellQuoted(guardedCommonDir)} ] || { cat >/dev/null; exit 0; }
refused=
while read -r old new ref; do
  case "$ref" in
    refs/heads/*|refs/tags/*) [ -n "$refused" ] || refused=$ref ;;
  esac
done
[ -z "$refused" ] && exit 0
echo "Refused \\\`$refused\\\`: a commission may not move branches or tags. Its work stays in this checkout, and what becomes of it is decided after the run." >&2
exit 1
`;
}

export function refGuardHooksDir(scratchDir: string): string {
  return join(scratchDir, 'git-hooks');
}

/**
 * Writes the hook guarding the folder at `root` into the run's scratch and
 * returns the environment that points the harness's git at it.
 *
 * Environment config sits above every config file git reads — system, global,
 * the repository's and the worktree's — so a `core.hooksPath` in any of them,
 * including a home directory the harness can write, does not displace it.
 */
export async function installRefGuard(
  scratchDir: string,
  root: string,
): Promise<Record<string, string>> {
  const dir = refGuardHooksDir(scratchDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'reference-transaction'),
    referenceTransactionHook(await commonGitDir(root)),
    { mode: 0o755 },
  );
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: dir,
  };
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** `git version 2.39.5 (Apple Git-154)` and `git version 2.52.0.windows.1` alike. */
export function parseGitVersion(text: string): GitVersion | undefined {
  const match = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

export function runsReferenceTransactionHook(version: GitVersion): boolean {
  const floor = REF_GUARD_MIN_GIT_VERSION;
  return (
    version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor)
  );
}

export function refGuardMissing(versionText: string | undefined): string[] {
  const needed = `${String(REF_GUARD_MIN_GIT_VERSION.major)}.${String(REF_GUARD_MIN_GIT_VERSION.minor)}`;
  if (versionText === undefined) {
    return [`git ${needed} or later — this machine's git did not report a version`];
  }
  const version = parseGitVersion(versionText);
  if (version === undefined) {
    return [`git ${needed} or later — this machine's git reported \`${versionText.trim()}\``];
  }
  if (runsReferenceTransactionHook(version)) return [];
  const found = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  return [
    `git ${needed} or later — this machine has ${found}, which runs no reference-transaction ` +
      'hook, so nothing would stop a commission from moving a branch',
  ];
}

/** The git a harness finds on its `PATH`, which is the executor's own. */
export async function refGuardReadiness(): Promise<{ ready: boolean; missing: string[] }> {
  const missing = refGuardMissing(await gitVersionText(GIT_VERSION_TIMEOUT_MS));
  return { ready: missing.length === 0, missing };
}

export function noRefGuardMessage(missing: readonly string[]): string {
  return (
    "This machine's git cannot stop a coding agent from moving the operator's branches and " +
    'tags, so a commission cannot run here.' +
    (missing.length > 0 ? ` Missing: ${missing.join('; ')}.` : '')
  );
}
