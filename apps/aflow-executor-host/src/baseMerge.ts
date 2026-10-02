/**
 * A base merged into a checkout, the same way every time it is made.
 *
 * A fix appended to a branch its base has moved past is commissioned with that
 * base merged into its checkout, so the coding agent resolves what conflicts
 * and its diff is taken against the merge. The publication then makes the same
 * merge on the branch's head and lands the diff on it. Two merges of the same
 * parents have to give the same tree, or the diff made against one would not
 * fit the other: the operator's global config is withheld from both, as from
 * every git this lane runs, and what the repository's own config could still
 * change between the two is pinned.
 */
import { fetchedBranch } from './pushBase.js';
import {
  APPLY_OUTPUT_CAP_BYTES,
  commitIdentityArgs,
  commitNamedBySha,
  fetchFromRemote,
  git,
  isAncestor,
  isPlainRefName,
  remoteNames,
  WorktreeError,
} from './worktree.js';

/** What a checkout's merge brought in. */
export interface BaseMerge {
  /** The commit merged in, as its full sha. */
  readonly from: string;
  /** The merge commit, which the work in the checkout is measured from. */
  readonly commit: string;
  /** Files the merge left conflict markers in, committed as they stood. Empty when clean. */
  readonly conflicts: readonly string[];
}

/**
 * The marker style decides the bytes a conflicted file holds, and `rerere`
 * would replay a resolution recorded between the two merges into the second.
 */
const MERGE_PINS = ['-c', 'merge.conflictStyle=merge', '-c', 'rerere.enabled=false'];

/** The publication's remote, the one a commission's merged sha is fetched from. */
const MERGE_REMOTE = 'origin';

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'git failed';
}

/**
 * Fetch `<remote>/<ref>` and return the commit the fetch brought, read from its
 * own FETCH_HEAD: a remote-tracking ref under a narrowed fetch refspec stays
 * where it was. Only a remote the folder has is fetched from.
 */
export async function fetchMergeSource(root: string, mergeFrom: string): Promise<string> {
  const remotes = await remoteNames(root);
  // Longest first: remote names may themselves contain a slash.
  const remote = remotes
    .filter((name) => mergeFrom.startsWith(`${name}/`) && mergeFrom.length > name.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  if (remote === undefined) {
    const known = remotes.length === 0 ? 'none' : remotes.map((name) => `\`${name}\``).join(', ');
    throw new WorktreeError(
      `\`mergeFrom\` is \`${mergeFrom}\`, which names no remote of this folder (its remotes: ` +
        `${known}). Name the branch to merge as \`<remote>/<branch>\`, such as \`origin/main\`.`,
      'unknown_ref',
    );
  }
  const ref = mergeFrom.slice(remote.length + 1);
  if (!(await isPlainRefName(root, ref))) {
    throw new WorktreeError(
      `\`mergeFrom\` is \`${mergeFrom}\`, and \`${ref}\` is not a branch name \`${remote}\` ` +
        'could hold.',
      'unknown_ref',
    );
  }
  await fetchFromRemote(root, remote, ref, 'leave `mergeFrom` out, and nothing is merged');
  return await fetchedBranch(root, remote, ref);
}

/**
 * The commit a publication merges, as the commission reported it in
 * `merge.from`: fetched from `origin` where the folder lacks it, and refused
 * where the branch already holds it, since merging it would make no commit to
 * fold the patch into.
 */
export async function reachMergeSource(root: string, sha: string, head: string): Promise<string> {
  let commit = await commitNamedBySha(root, sha);
  const whole = /^[0-9a-f]{40}$/i.test(sha);
  if (commit === undefined && whole) {
    await fetchFromRemote(
      root,
      MERGE_REMOTE,
      sha,
      'commission the fix again, so that it reports a commit the folder has',
    );
    commit = await commitNamedBySha(root, sha);
  }
  if (commit === undefined) {
    throw new WorktreeError(
      `\`mergeFrom\` is \`${sha}\`, which names no commit in ${root}` +
        (whole ? ` or on \`${MERGE_REMOTE}\`` : '') +
        '. Pass the whole sha the commission reported in `merge.from`.',
      'unknown_ref',
    );
  }
  if (await isAncestor(root, commit, head)) {
    throw new WorktreeError(
      `\`mergeFrom\` is \`${commit}\`, which the branch already holds at \`${head}\`, so there ` +
        'is nothing to merge. Publish the patch without `mergeFrom`.',
      'stale_base',
    );
  }
  return commit;
}

async function unmergedPaths(checkout: string): Promise<string[]> {
  const listing = await git(
    checkout,
    ['diff', '--name-only', '--diff-filter=U', '-z'],
    APPLY_OUTPUT_CAP_BYTES,
  );
  return [...new Set(listing.split('\0').filter((path) => path !== ''))];
}

/**
 * Merge `from` into the checkout at its HEAD, as one merge commit, or nothing
 * when the checkout already holds it. A merge that conflicts is committed as
 * it stands, markers and all, so the checkout shows what needs resolving.
 */
export async function mergeIntoCheckout(
  checkout: string,
  from: string,
): Promise<BaseMerge | undefined> {
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  if (await isAncestor(checkout, from, head)) return undefined;
  const merging = [...(await commitIdentityArgs(checkout)), ...MERGE_PINS];
  let conflicts: string[] = [];
  try {
    await git(
      checkout,
      [...merging, 'merge', '--no-ff', '--no-edit', '--end-of-options', from],
      APPLY_OUTPUT_CAP_BYTES,
    );
  } catch (error) {
    conflicts = await unmergedPaths(checkout);
    if (conflicts.length === 0) {
      await git(checkout, ['merge', '--abort']).catch(() => {});
      throw new WorktreeError(
        `\`${from}\` could not be merged into \`${head}\`: ${firstLine(error)}`,
        'git_failed',
      );
    }
    // The conflicted paths alone: the checkout a coding agent runs in carries
    // the folder's installed dependencies, untracked, which `add -A .` would stage.
    await git(
      checkout,
      ['--literal-pathspecs', 'add', '-A', '--', ...conflicts],
      APPLY_OUTPUT_CAP_BYTES,
    );
    await git(checkout, [...merging, 'commit', '--no-edit'], APPLY_OUTPUT_CAP_BYTES);
  }
  const commit = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  return { from, commit, conflicts };
}

/**
 * The files among `paths` whose staged text still holds all three lines of a
 * conflict — an opening marker, the divider and a closing one. Read from the
 * index, so no filter runs, and a binary file is skipped.
 */
export async function filesWithConflictMarkers(
  checkout: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  try {
    const listing = await git(
      checkout,
      [
        '--literal-pathspecs',
        'grep',
        '--cached',
        '-I',
        '-l',
        '-z',
        '-E',
        '--all-match',
        '-e',
        '^<{7}([^<]|$)',
        '-e',
        '^={7}([^=]|$)',
        '-e',
        '^>{7}([^>]|$)',
        '--',
        ...paths,
      ],
      APPLY_OUTPUT_CAP_BYTES,
    );
    return listing.split('\0').filter((path) => path !== '');
  } catch (error) {
    // 1 is grep's "nothing matched".
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return [];
    }
    throw error;
  }
}
