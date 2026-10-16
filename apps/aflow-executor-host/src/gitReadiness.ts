/**
 * The git a publication needs on this machine.
 *
 * A publication's commit reaches the folder by the executor's git fetching it
 * from the clone it was made in with `--no-write-fetch-head`
 * (`commitPatchOnBranch`), so the FETCH_HEAD another fetch is about to read is
 * never overwritten. Git 2.29 is the first release with that flag; below it the
 * fetch fails, so the publication is refused before it makes anything. Nothing
 * else the lane runs needs the flag, so nothing else is refused for it.
 */
import { gitVersionText } from './worktree.js';

const GIT_VERSION_TIMEOUT_MS = 10_000;

export const PUBLICATION_MIN_GIT_VERSION = { major: 2, minor: 29 } as const;

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

export function fetchesWithoutFetchHead(version: GitVersion): boolean {
  const floor = PUBLICATION_MIN_GIT_VERSION;
  return (
    version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor)
  );
}

export function publicationGitMissing(versionText: string | undefined): string[] {
  const needed = `${String(PUBLICATION_MIN_GIT_VERSION.major)}.${String(PUBLICATION_MIN_GIT_VERSION.minor)}`;
  if (versionText === undefined) {
    return [`git ${needed} or later — this machine's git did not report a version`];
  }
  const version = parseGitVersion(versionText);
  if (version === undefined) {
    return [`git ${needed} or later — this machine's git reported \`${versionText.trim()}\``];
  }
  if (fetchesWithoutFetchHead(version)) return [];
  const found = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  return [
    `git ${needed} or later — this machine has ${found}, whose \`git fetch\` has no ` +
      '`--no-write-fetch-head`, so a commit made in a clone could not be brought into the folder',
  ];
}

/** The git the executor runs on its own `PATH`, which is the one that publishes. */
export async function publicationGitReadiness(): Promise<{ ready: boolean; missing: string[] }> {
  const missing = publicationGitMissing(await gitVersionText(GIT_VERSION_TIMEOUT_MS));
  return { ready: missing.length === 0, missing };
}

export function noPublicationGitMessage(missing: readonly string[]): string {
  return (
    "This machine's git cannot bring a commit made in a clone into the folder, so nothing " +
    'can be published here.' +
    (missing.length > 0 ? ` Missing: ${missing.join('; ')}.` : '')
  );
}
