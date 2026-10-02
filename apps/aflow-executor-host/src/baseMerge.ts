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

/**
 * The `-c` arguments a commission's merge is committed under: the operator's
 * commit identity, the one the publication's commit carries.
 */
export async function mergeIdentityArgs(root: string): Promise<string[]> {
  return await commitIdentityArgs(
    root,
    (keys) =>
      "A commission with `mergeFrom` commits its merge under the operator's commit identity, " +
      `as the publication's commit is, and neither this repository nor the global git config ` +
      `sets ${keys}. Set ${keys} in the repository, or globally, then commission it again.`,
  );
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
 * The conflicted paths git merges as binary: a side git reads as binary, or a
 * `merge` attribute that is unset or `binary`. git leaves no markers in such a
 * file, only one side's version, so there is nothing in its text to resolve.
 */
async function binaryConflicts(checkout: string, conflicts: readonly string[]): Promise<string[]> {
  const binary = new Set<string>();
  // Between the two sides, since the conflicted working tree's own diff says nothing.
  const numstat = await git(
    checkout,
    [
      '--literal-pathspecs',
      'diff',
      '--numstat',
      '--no-renames',
      '-z',
      'HEAD',
      'MERGE_HEAD',
      '--',
      ...conflicts,
    ],
    APPLY_OUTPUT_CAP_BYTES,
  );
  for (const record of numstat.split('\0')) {
    const match = /^-\t-\t(.+)$/s.exec(record);
    if (match?.[1] !== undefined) binary.add(match[1]);
  }
  const attributes = (
    await git(
      checkout,
      ['--literal-pathspecs', 'check-attr', '-z', 'merge', '--', ...conflicts],
      APPLY_OUTPUT_CAP_BYTES,
    )
  ).split('\0');
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const path = attributes[index];
    const value = attributes[index + 2];
    if (path !== undefined && (value === 'unset' || value === 'binary')) binary.add(path);
  }
  return conflicts.filter((path) => binary.has(path));
}

/**
 * Merge `from` into the checkout at its HEAD, as one merge commit under
 * `identity`, or nothing when the checkout already holds it. A merge that
 * conflicts in text is committed as it stands, markers and all, so the
 * checkout shows what needs resolving; one that conflicts in a binary file is
 * refused, since no turn could resolve it.
 */
export async function mergeIntoCheckout(
  checkout: string,
  from: string,
  identity: readonly string[],
): Promise<BaseMerge | undefined> {
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  if (await isAncestor(checkout, from, head)) return undefined;
  const merging = [...identity, ...MERGE_PINS];
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
    const binary = await binaryConflicts(checkout, conflicts);
    if (binary.length > 0) {
      await git(checkout, ['merge', '--abort']).catch(() => {});
      throw new WorktreeError(
        `Merging \`${from}\` into \`${head}\` conflicts in ` +
          `${binary.map((path) => `\`${path}\``).join(', ')}, which git merges as binary and ` +
          'leaves no conflict markers in, so a coding agent has no text to resolve and no turn ' +
          'ran. That merge has to be made by hand: merge it into the branch, then commission ' +
          'the fix from there.',
        'binary_conflict',
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
 * index, so no filter runs. A binary file is skipped: a merge that conflicts
 * in one is refused before it is committed, by `mergeIntoCheckout`.
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
