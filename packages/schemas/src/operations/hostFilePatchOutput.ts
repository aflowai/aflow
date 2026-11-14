import { z } from 'zod';

import { HostCommitRangeSchema, HostCommitShaSchema, HostPushChangesSchema } from './host.js';
import { HOST_FULL_SHA_PATTERN } from './hostPushMerge.js';

/**
 * What a run can do about a commit conflict, computed by the executor from its
 * own refusal rules. An existing branch takes a patch only at its head, so a
 * new run naming another `baseSha` is refused as `stale_base`. A new branch
 * starts at any `baseSha`. Only an existing branch is published as it stands.
 */
export const HostPatchConflictRemedySchema = z
  .object({
    kind: z
      .enum(['publish_as_it_stands', 'nothing_to_commit', 'fit_branch_head', 'fit_another_base'])
      .describe(
        '`publish_as_it_stands`: the branch existed and its head `at` already holds the change. ' +
          'Publish the branch as it stands with `baseSha` `at`. ' +
          '`nothing_to_commit`: the branch did not exist and `at` already holds the change. ' +
          'A commit there would change nothing, and no branch exists to publish as it stands. ' +
          '`fit_branch_head`: the branch existed and its head `at` does not hold the change. ' +
          'A run on this branch is taken only with `baseSha` `at`, so the change has to fit `at`, merged with any `mergeFrom`. ' +
          '`fit_another_base`: the branch did not exist and `at` does not hold the change. ' +
          'A new branch starts at any `baseSha` named, so the change has to fit the commit named.',
      ),
    at: z
      .string()
      .regex(HOST_FULL_SHA_PATTERN)
      .describe(
        "The commit the patch was applied at, as its full sha: the branch's head where it " +
          "existed, else the `baseSha` given, else the folder's HEAD. Any `mergeFrom` was merged " +
          'onto it after.',
      ),
    branchExisted: z
      .boolean()
      .describe('True where the branch existed before this call, so `at` is its head.'),
  })
  .describe('Present exactly when `commit` was asked for and the patch conflicted.');

export type HostPatchConflictRemedy = z.infer<typeof HostPatchConflictRemedySchema>;

export const HostFilePatchOutputSchema = z.object({
  state: z
    .enum(['applied', 'conflict', 'empty'])
    .describe(
      '`conflict` in `clean` mode means the folder was not touched at all. In `merge` ' +
        'mode it means the tree WAS written and the files named in `conflicts` carry ' +
        'markers — check `filesChanged` rather than assuming nothing happened. With ' +
        '`commit` a conflict leaves no commit and no branch, and the folder untouched in ' +
        'either mode. A branch published as it stands is `applied` with nothing written.',
    ),
  filesChanged: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Zero only when nothing was written — the folder byte-identical to before, or, with ' +
        '`commit`, no commit made or a commit that is a merge alone. With `commit` it counts ' +
        'the files the diff carries; the working tree is untouched either way.',
    ),
  files: z.array(z.string()).describe('Paths the diff touched, relative to the binding root.'),
  conflicts: z
    .array(z.string())
    .describe('Files that could not be settled. Empty when `state` is `applied`.'),
  detail: z.string().optional().describe('What git could not place, when there was a conflict.'),
  remedy: HostPatchConflictRemedySchema.optional(),
  commit: z
    .object({
      branch: z.string().describe('The branch that now exists in the repository.'),
      sha: HostCommitShaSchema.describe('The commit the branch points at, as its full sha.'),
      message: z.string().describe('The message the commit carries, as git recorded it.'),
      body: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The message after its first line, the blank lines that set it off removed: what ' +
            'the commit says about the change beyond its subject. Absent for a one-line message.',
        ),
      baseSha: z
        .string()
        .describe(
          "The parent of the new commit: HEAD as it was found for a new branch, the branch's " +
            'previous head for an append, and its first parent where it is a merge.',
        ),
      appended: z
        .boolean()
        .describe('True when the branch existed and the commit was appended to it.'),
      asItStands: z
        .literal(true)
        .optional()
        .describe('Nothing was made: `sha` is the head the branch had, `baseSha` its parent.'),
      merged: z
        .string()
        .optional()
        .describe(
          'The commit `commit.mergeFrom` merged in, as its full sha, when the commit is that ' +
            'merge with the patch folded in: its parents are `baseSha` and this. Absent otherwise.',
        ),
      range: HostCommitRangeSchema.describe(
        'The commit as a revision range, `<baseSha>..<sha>` — two shas and no branch name, so ' +
          'it still names this commit after the branch moves. Where the commit is a merge it ' +
          'also holds the commits `merged` brought in.',
      ),
      pushRange: HostCommitRangeSchema.optional().describe(
        'Everything a push of this commit would add, `<origin base sha>..<sha>`: the commits ' +
          'reachable from it that `origin/<pushBase>`, freshly fetched, does not hold — this ' +
          'commit and every unpushed one under it. Present only when `commit.pushBase` was ' +
          'given. What a publication scans and reviews before the push.',
      ),
      pushBaseSha: HostCommitShaSchema.optional().describe(
        'Where `origin/<pushBase>` stood when it was fetched, as a full sha — the first sha ' +
          "of `pushRange`, and present exactly when it is. What a publication's checks are " +
          'measured against.',
      ),
      baseMoved: z
        .boolean()
        .optional()
        .describe(
          'True where `origin/<pushBase>` holds commits this one does not: the base moved on ' +
            'since the branch was cut from it or last merged it, so a further round on the ' +
            'branch merges it in first. Present exactly when `pushBaseSha` is.',
        ),
      pushChanges: HostPushChangesSchema.optional(),
      pushRefspec: z
        .string()
        .min(1)
        .describe(
          'The refspec that pushes this commit to its branch, `<sha>:refs/heads/<branch>`, ' +
            'carrying with it every commit under it that `origin` does not have — `pushRange` ' +
            'names them. A branch that moved after the commit sends nothing it gained since.',
        ),
    })
    .optional()
    .describe(
      'Present only when `commit` was asked for and the diff applied, or the branch was ' +
        'published as it stands. A conflict leaves no commit and no branch created or moved.',
    ),
});
