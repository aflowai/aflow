/**
 * Where a push's base is on `origin`, read from a fetch made for the purpose.
 *
 * A publication pushes a commit by its sha, and the push carries every ancestor
 * `origin` lacks; what that is depends on where `origin`'s base branch is,
 * which is measured when the commit is made and measured again in the push's
 * own step, just before git is spawned.
 */
import { readFile } from 'node:fs/promises';

import {
  fetchFromRemote,
  gitPath,
  isPlainRefName,
  remoteFetchUrl,
  remoteNames,
  remotePushUrls,
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
        'in the folder replaced it before it was read. Run this again.',
      'fetch_failed',
    );
  }
  return await resolveCommit(root, sha);
}

/**
 * Refuse a push to anywhere but where its base was measured. The base is
 * fetched from `origin`'s fetch URL, and the push goes to its push URLs —
 * a `pushurl`, a `pushInsteadOf` rewrite or a second `url` sends it to a
 * repository whose base nobody read.
 */
async function confirmPushUrl(root: string): Promise<void> {
  const urls = await Promise.all([
    remoteFetchUrl(root, PUSH_REMOTE),
    remotePushUrls(root, PUSH_REMOTE),
  ]).catch(() => undefined);
  if (urls === undefined) {
    throw new WorktreeError(
      `\`${PUSH_REMOTE}\` is not a remote this folder can read, so where a push to it goes ` +
        'cannot be checked. Nothing was pushed.',
      'unknown_ref',
    );
  }
  const [fetchUrl, pushUrls] = urls;
  if (pushUrls.length === 1 && pushUrls[0] === fetchUrl) return;
  const listed = pushUrls.map((url) => `\`${withoutCredentials(url)}\``).join(', ');
  throw new WorktreeError(
    `A push to \`${PUSH_REMOTE}\` goes to ${listed}, and its base was fetched from ` +
      `\`${withoutCredentials(fetchUrl)}\`, so what the push would add was measured against a ` +
      'repository it does not go to. Nothing was pushed. Make the folder push where it ' +
      `fetches — remove \`remote.${PUSH_REMOTE}.pushurl\`, a \`pushInsteadOf\` rewrite or a ` +
      `second \`remote.${PUSH_REMOTE}.url\` — and publish again.`,
    'push_target_differs',
  );
}

/**
 * Where a publication's push starts, read just before it is spawned: refused
 * unless it goes to `origin` and `origin` pushes where it fetches, and then
 * where `origin/<pushBase>` is now. Everything the push would add lies between
 * that commit and the one it sends, and that is the range its receipt has to
 * be for.
 */
export async function measurePushBase(
  root: string,
  remote: string,
  pushBase: string,
): Promise<string> {
  if (remote !== PUSH_REMOTE) {
    throw new WorktreeError(
      `This push names \`${remote}\`, and what it would add is measured against ` +
        `\`${PUSH_REMOTE}/${pushBase}\`. Nothing was pushed. Push to \`${PUSH_REMOTE}\`.`,
      'push_target_differs',
    );
  }
  await confirmPushUrl(root);
  return await resolvePushBase(root, pushBase);
}
