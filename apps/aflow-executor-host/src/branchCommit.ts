/**
 * A diff landed as a commit on a branch, in a checkout of the executor's own.
 *
 * The publication half of the host lane: a new branch at the commission's
 * base, or one commit appended to the branch the diff was made on — on its
 * head, or on the merge of its base into it that the commission made.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mergeIntoCheckout,
  reachMergeSource,
  undecidedConflicts,
  type BaseMerge,
} from './baseMerge.js';
import {
  APPLY_OUTPUT_CAP_BYTES,
  applyPatch,
  commitIdentityArgs,
  commitNamedBySha,
  git,
  noIdentityMessage,
  prepareWorktree,
  removeWorktree,
  resolveCommit,
  WorktreeError,
  type ApplyOutcome,
  type PreparedWorktree,
} from './worktree.js';

/** Whether the repository already has this branch, asked before anything is built. */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, [
      'show-ref',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout that has this branch open, if any.
 *
 * Advancing a branch some checkout is on leaves that checkout's files and index
 * at the old commit while its branch names the new one, so its next commit
 * would quietly revert the change. Git refuses to move such a branch for the
 * same reason.
 */
async function checkoutHolding(root: string, branch: string): Promise<string | undefined> {
  const listing = await git(root, ['worktree', 'list', '--porcelain'], APPLY_OUTPUT_CAP_BYTES);
  let path: string | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

export interface PatchCommit {
  readonly branch: string;
  readonly sha: string;
  readonly message: string;
  /** The message after its subject line, absent for a one-line message. */
  readonly body?: string;
  /** The parent of the new commit; its first parent when it is a merge. */
  readonly baseSha: string;
  /** True when the branch existed and the commit was appended to it. */
  readonly appended: boolean;
  /** The commit merged in, as its full sha, when the commit is the merge of it with the patch on top. */
  readonly merged?: string;
  /** `<baseSha>..<sha>`: this commit, and what it merged in where it is a merge. */
  readonly range: string;
  /** `<origin base sha>..<sha>`: every commit a push of this one would add, when a push base was named. */
  readonly pushRange?: string;
  /** Where `origin/<pushBase>` stood: the first sha of `pushRange`, present exactly when it is. */
  readonly pushBaseSha?: string;
  /** `<sha>:refs/heads/<branch>`: what a push of this commit sends. */
  readonly pushRefspec: string;
}

export interface PatchCommitOutcome {
  readonly apply: ApplyOutcome;
  /** Absent when the patch conflicted, which leaves no commit and no branch moved. */
  readonly commit?: PatchCommit;
}

/** The commit a sha names, or a refusal naming the sha. */
async function resolveSha(root: string, sha: string): Promise<string> {
  const commit = await commitNamedBySha(root, sha);
  if (commit === undefined) {
    throw new WorktreeError(
      `\`${sha}\` names no commit in ${root}. \`baseSha\` is the sha the commission reported ` +
        'in its `baseSha`, for a commit the folder has — a commission that started from a ' +
        'remote fetched its base into the folder.',
      'unknown_ref',
    );
  }
  return commit;
}

/**
 * Where a commit lands, decided before any checkout is made. An existing branch
 * takes it on its head, and a stated base must be that head — a patch lands
 * only where it was made, never merged onto something that moved since. A new
 * branch starts at the stated base, which may be behind or ahead of the
 * folder's HEAD (a commission started from a remote), and at the folder's HEAD
 * when none is stated.
 */
async function commitTarget(
  root: string,
  branch: string,
  baseSha: string | undefined,
): Promise<{ at: string | undefined; appended: boolean }> {
  const appended = await branchExists(root, branch);
  const stated = baseSha === undefined ? undefined : await resolveSha(root, baseSha);

  if (appended) {
    if (stated === undefined) {
      throw new WorktreeError(
        `The repository already has a branch \`${branch}\`. A commit is appended to it only ` +
          'with `baseSha`: the commit the patch was made against, as the commission reported it in ' +
          '`baseSha`. A fresh change takes a new branch name.',
        'branch_exists',
      );
    }
    const head = await resolveCommit(root, `refs/heads/${branch}`);
    if (stated !== head) {
      throw new WorktreeError(
        `The patch was made against \`${baseSha ?? stated}\` but \`${branch}\` is at \`${head}\`. ` +
          'A patch is appended only to the commit it was made against, never merged onto a ' +
          `branch that has moved; commission the fix again from \`${branch}\`.`,
        'stale_base',
      );
    }
    const holder = await checkoutHolding(root, branch);
    if (holder !== undefined) {
      throw new WorktreeError(
        `\`${branch}\` is checked out in ${holder}, and advancing it would leave that checkout's ` +
          'files behind its own branch. Switch that checkout off the branch, then publish again.',
        'branch_checked_out',
      );
    }
    return { at: head, appended };
  }

  return { at: stated, appended };
}

/** How a publication's scratch, and the checkout it commits in, is named under the temp root. */
export const PUBLICATION_SCRATCH_PREFIX = 'aflow-commit-';

const APPLY_ERROR_FILE =
  /^error: (?:patch failed: (.+):\d+|(.+?): (?:patch does not apply|does not exist in (?:index|working tree)|already exists in (?:index|working directory)))$/;

/** The files an apply that did not fit names in its errors, for a mode that names none itself. */
function filesNamedIn(apply: ApplyOutcome): ApplyOutcome {
  if (apply.conflicts.length > 0) return apply;
  const named = (apply.detail ?? '')
    .split('; ')
    .map((line) => APPLY_ERROR_FILE.exec(line))
    .map((match) => match?.[1] ?? match?.[2])
    .filter((path): path is string => path !== undefined && path !== '');
  return { ...apply, conflicts: [...new Set(named)] };
}

/**
 * The commit `mergeFrom` names, ready to merge onto the branch's head. Only an
 * append merges: a fresh branch starts at the commission's base, which already
 * holds whatever the commission started from.
 */
async function mergeSource(
  root: string,
  branch: string,
  target: { at: string | undefined; appended: boolean },
  mergeFrom: string | undefined,
): Promise<string | undefined> {
  if (mergeFrom === undefined) return undefined;
  if (!target.appended || target.at === undefined) {
    throw new WorktreeError(
      `\`${branch}\` is a new branch, and \`mergeFrom\` merges only into a branch that exists: ` +
        "a new branch starts at the commission's `baseSha`. Publish without `mergeFrom`, or onto " +
        'the branch the fix was commissioned from.',
      'unknown_ref',
    );
  }
  return await reachMergeSource(root, mergeFrom, target.at);
}

function messageBody(message: string): string | undefined {
  const subjectEnd = message.indexOf('\n');
  if (subjectEnd === -1) return undefined;
  const body = message.slice(subjectEnd + 1).replace(/^\n+/, '');
  return body === '' ? undefined : body;
}

async function commitStaged(checkout: string, messagePath: string, amend: boolean): Promise<void> {
  const identity = await commitIdentityArgs(checkout);
  try {
    await git(
      checkout,
      [...identity, 'commit', ...(amend ? ['--amend'] : []), '-F', messagePath],
      APPLY_OUTPUT_CAP_BYTES,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (
      /Please tell me who you are|no email was given|unable to auto-detect|empty ident/i.test(
        detail,
      )
    ) {
      throw new WorktreeError(noIdentityMessage(), 'no_identity');
    }
    throw new WorktreeError(
      `The commit could not be made: ${detail.split('\n')[0] ?? 'git failed'}`,
      'git_failed',
    );
  }
}

/**
 * Land a diff as a commit on a branch, without touching what the operator has
 * open.
 *
 * A new branch starts at the stated base, or the folder's HEAD without one; an
 * existing one takes the commit on top of its head, provided the patch was made
 * there. With `mergeFrom` an existing branch takes instead one merge commit —
 * the merge of that commit into its head, made as the commission made it, with
 * the patch folded in, or the merge alone for an empty patch — so the diff
 * lands on the tree it was made against. The
 * apply happens in a checkout made for this call alone, so the operator's
 * working tree, index and current branch are never a party to it — they are a
 * second writer this lane does not get to interrupt. What remains afterwards is
 * one ref, created or advanced by one commit, which is the thing a publication
 * can push and the thing an operator can reset if they disagree.
 *
 * The identity is the operator's own, resolved from the repository's config and
 * then from their global one. Inventing an author for a commit that will carry
 * the operator's name is not this lane's to do, so a folder where neither names
 * one is refused rather than signed.
 */
export async function commitPatchOnBranch(
  root: string,
  patch: string,
  mode: 'clean' | 'merge',
  branch: string,
  message: string,
  options: {
    readonly baseSha?: string;
    readonly pushBaseSha?: string;
    readonly mergeFrom?: string;
  } = {},
): Promise<PatchCommitOutcome> {
  const { pushBaseSha } = options;
  const target = await commitTarget(root, branch, options.baseSha);
  const mergeFrom = await mergeSource(root, branch, target, options.mergeFrom);

  const scratch = await mkdtemp(join(tmpdir(), PUBLICATION_SCRATCH_PREFIX));
  let worktree: PreparedWorktree | undefined;
  try {
    worktree = await prepareWorktree(root, scratch, 'commit', {
      dependencies: 'none',
      ...(target.at !== undefined ? { at: target.at } : {}),
    });
    let merge: BaseMerge | undefined;
    if (mergeFrom !== undefined) {
      merge = await mergeIntoCheckout(
        worktree.path,
        mergeFrom,
        await commitIdentityArgs(worktree.path),
      );
    }

    const apply: ApplyOutcome =
      merge !== undefined && patch.trim() === ''
        ? { state: 'applied', conflicts: [] }
        : await applyPatch(worktree.path, patch, mode);
    if (apply.state === 'conflict')
      return { apply: merge === undefined ? apply : filesNamedIn(apply) };

    await git(worktree.path, ['add', '-A', '--', '.'], APPLY_OUTPUT_CAP_BYTES);
    const staged = (await git(worktree.path, ['diff', '--cached', '--name-only', '-z']))
      .split('\0')
      .filter((path) => path !== '');
    // With a merge the merge commit is itself the change, so a patch that adds
    // nothing to it — a clean catch-up, or every offered deletion accepted —
    // still publishes.
    if (staged.length === 0 && merge === undefined) {
      throw new WorktreeError(
        'The patch applied and changed nothing, so there is no commit to make.',
        'git_failed',
      );
    }
    if (merge !== undefined) {
      const undecided = await undecidedConflicts(worktree.path, merge.conflicts);
      if (undecided.length > 0) {
        const named = undecided.map(({ path, kind }) => `\`${path}\` (${kind} conflict)`);
        throw new WorktreeError(
          `Merging \`${merge.from}\` into \`${branch}\` and applying the patch leaves conflict ` +
            `markers in ${named.join(', ')}, so nothing was committed. The fix has to resolve ` +
            'every conflict the merge marks: commission it again from the branch with the same ' +
            '`mergeFrom`, naming these.',
          'unresolved_conflict',
        );
      }
    }

    const messagePath = join(scratch, 'commit-message');
    await writeFile(messagePath, message, 'utf8');
    await commitStaged(worktree.path, messagePath, merge !== undefined);

    const sha = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    // Read back rather than echoed: git's cleanup trims what it was handed, and
    // the approval shows the commit as it will be pushed.
    const recorded = (
      await git(worktree.path, ['show', '-s', '--format=%B', sha], APPLY_OUTPUT_CAP_BYTES)
    ).replace(/\n+$/, '');
    const body = messageBody(recorded);
    try {
      // Compare-and-swap on the old head: a branch that moved between the check
      // above and this line is refused here rather than overwritten.
      await git(
        worktree.path,
        target.appended
          ? ['update-ref', '--end-of-options', `refs/heads/${branch}`, sha, worktree.baseSha]
          : ['branch', '--end-of-options', branch, sha],
      );
    } catch (error) {
      throw new WorktreeError(
        `The commit was made but \`${branch}\` could not be ${
          target.appended ? 'advanced' : 'created'
        }: ${error instanceof Error ? (error.message.split('\n')[0] ?? 'git failed') : 'git failed'}`,
        'git_failed',
      );
    }
    return {
      apply,
      commit: {
        branch,
        sha,
        message: recorded,
        ...(body !== undefined ? { body } : {}),
        baseSha: worktree.baseSha,
        appended: target.appended,
        ...(merge !== undefined ? { merged: merge.from } : {}),
        range: `${worktree.baseSha}..${sha}`,
        ...(pushBaseSha !== undefined
          ? { pushRange: `${pushBaseSha}..${sha}`, pushBaseSha }
          : {}),
        pushRefspec: `${sha}:refs/heads/${branch}`,
      },
    };
  } finally {
    if (worktree !== undefined) await removeWorktree(root, worktree.path);
    await rm(scratch, { recursive: true, force: true });
  }
}
