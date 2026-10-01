/**
 * Where a push's base is on `origin`, read from a fetch made for the purpose.
 *
 * A publication pushes a commit by its sha, and the push carries every ancestor
 * `origin` lacks; what that is depends on where `origin`'s base branch is,
 * which is measured when the commit is made and checked again just before the
 * push.
 */
import { readFile } from 'node:fs/promises';

import {
  fetchFromRemote,
  gitPath,
  isPlainRefName,
  remoteFetchUrl,
  remoteNames,
  resolveCommit,
  WorktreeError,
} from './worktree.js';

/** The remote a publication pushes to, and so the one its push base is read from. */
const PUSH_REMOTE = 'origin';

/** git's own test: a path, not `host:path`, when no colon comes before the first slash. */
function isLocalPath(url: string): boolean {
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon === -1 || (slash !== -1 && slash < colon);
}

/** A URL with the credentials before its host taken out, as git does before it records one. */
function withoutCredentials(url: string): string {
  const at = url.indexOf('@');
  if (at === -1 || isLocalPath(url)) return url;
  const host = url.slice(at + 1);
  const scheme = url.indexOf('://');
  if (scheme === -1) return host.includes(':') ? host : url;
  if (!/^[A-Za-z0-9+.-]*$/.test(url.slice(0, scheme))) return url;
  const pathStart = url.indexOf('/', scheme + 3);
  if (pathStart !== -1 && pathStart < at + 1) return url;
  return `${url.slice(0, scheme + 3)}${host}`;
}

/**
 * How FETCH_HEAD names the remote a branch was fetched from: the URL without
 * its credentials, then without trailing slashes, then without one `.git`.
 */
export function fetchHeadSource(url: string): string {
  const trimmed = withoutCredentials(url).replace(/\/+$/, '');
  return trimmed.length > 5 && trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
}

/**
 * Where `origin/<pushBase>` is now, read from the fetch's own `FETCH_HEAD`.
 * The remote-tracking ref moves only where the remote's fetch refspec maps
 * the branch to it, so under a narrowed refspec it stays where it was and
 * would leave out of the push range commits the remote has since lost.
 */
export async function resolvePushBase(root: string, pushBase: string): Promise<string> {
  const named = `${PUSH_REMOTE}/${pushBase}`;
  if (!(await remoteNames(root)).includes(PUSH_REMOTE) || !(await isPlainRefName(root, pushBase))) {
    throw new WorktreeError(
      `\`${named}\` is not a branch this folder can read, so what a push would ` +
        `add cannot be measured. A publication pushes to \`${PUSH_REMOTE}\` and measures against ` +
        `its \`${pushBase}\`; the folder needs that remote, and \`${pushBase}\` on it.`,
      'unknown_ref',
    );
  }
  await fetchFromRemote(root, PUSH_REMOTE, pushBase);
  return await fetchedBranch(root, PUSH_REMOTE, pushBase);
}

/**
 * The commit FETCH_HEAD records for `branch` fetched from `remote`, refused
 * unless its first line names both. Another fetch in the same folder rewrites
 * FETCH_HEAD, and a branch of the same name fetched from another remote is not
 * where this remote's is.
 */
export async function fetchedBranch(root: string, remote: string, branch: string): Promise<string> {
  const source = fetchHeadSource(await remoteFetchUrl(root, remote));
  const first = (await readFile(await gitPath(root, 'FETCH_HEAD'), 'utf8')).split('\n')[0] ?? '';
  const [sha, , description] = first.split('\t');
  const name = branch.replace(/^refs\/heads\//, '');
  if (sha === undefined || description !== `branch '${name}' of ${source}`) {
    throw new WorktreeError(
      `\`${remote}/${branch}\` was fetched, but FETCH_HEAD no longer names it — another fetch ` +
        'in the folder replaced it before it was read. Publish again.',
      'fetch_failed',
    );
  }
  return await resolveCommit(root, sha);
}

/**
 * Refuse a push whose base moved on `origin` since the push range was
 * measured. The scan and the review left out every commit `origin/<pushBase>`
 * held then; a base rewound since — the usual way a leaked secret is taken
 * back — would have the push send those commits again, unread.
 */
export async function confirmPushBase(
  root: string,
  pushBase: string,
  measuredSha: string,
): Promise<string> {
  const measured = await resolveCommit(root, measuredSha).catch(() => undefined);
  if (!measured?.startsWith(measuredSha.toLowerCase())) {
    throw new WorktreeError(
      `\`${measuredSha}\` names no commit in ${root}. The range is the \`pushRange\` the ` +
        'commit reported, whose base is where `origin` was when it was measured.',
      'unknown_ref',
    );
  }
  const now = await resolvePushBase(root, pushBase);
  if (now !== measured) {
    throw new WorktreeError(
      `\`${PUSH_REMOTE}/${pushBase}\` was at \`${measured}\` when what the push would add was ` +
        `measured, scanned and reviewed, and is at \`${now}\` now, so the push would no longer ` +
        'carry what was cleared. Nothing was pushed. The publication has to run again, to ' +
        'measure, scan and review what a push would add against where the base is now.',
      'stale_base',
    );
  }
  return now;
}
