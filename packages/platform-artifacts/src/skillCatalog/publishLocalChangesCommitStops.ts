import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import { publishAsItStands } from './publishLocalChangesProse.js';

/**
 * The commit task's two endings that make no commit. Every task after it is
 * gated on `applied`, so without a stop of its own either ending skips the
 * rest and the run completes with no pull request and no account of why.
 */

/** A run that made no commit reports no `commit.sha`, so the head is named by the input. */
const AS_IT_STANDS_AT_HEAD = publishAsItStands(
  "the branch's head, which is this run's own `baseSha` where it appended to the branch",
);

/**
 * `clean` mode applies a patch only at the commit the run names: an existing
 * branch whose head is not `baseSha` is refused as a stale base before any
 * apply, and a new branch starts at `baseSha` or the folder's HEAD. So a
 * conflict never means the base moved under the patch. Either the branch's
 * head already holds the patch, or the run named a commit the patch was not
 * made against.
 */
export const COMMIT_CONFLICT =
  "The patch did not apply, so nothing was committed and no branch was created or moved. Nothing left the machine. The reason above quotes what git could not place. Where it says a file already exists in the working directory, or that the patch does not apply, ask first whether the branch's head already carries this change. It does where an earlier publication of this branch committed the same patch. Then never send the patch again, because the branch already holds it. " +
  AS_IT_STANDS_AT_HEAD +
  " Otherwise git's detail names the files and hunks that do not fit the commit this run applied the patch at. " +
  'The base did not move under the patch, because an existing branch whose head is not `baseSha` is refused before any apply. ' +
  'Either this run named the wrong commit, or the patch was not made against it. ' +
  'Where this run appended to an existing branch, the patch was applied at its head, which is the `baseSha` given, merged with any `mergeFrom` given. ' +
  'Compare those with the `baseSha` and `merge.from` the commission reported. ' +
  "Where they differ, publish the same `patchRef` again with the commission's values. " +
  'Where they match, the patch does not fit the commit it was made against, so commission the change again from this branch. ' +
  'Where this run was making a new branch, the branch is new and was not created, so there is no branch to merge forward. ' +
  "The patch was applied at the `baseSha` given, or at the folder's HEAD where none was given. Re-decide from the detail. " +
  "Where no `baseSha` was given, or it is not the one the commission reported, publish the same `patchRef` again with the commission's `baseSha`. " +
  "Where the folder's HEAD already carries the change, this patch needs no new branch. Otherwise commission the change again.";

export const COMMIT_EMPTY =
  "The change touched no file, so nothing was committed and no branch was created or moved. Nothing left the machine. Either the commission that reported this `patchRef` changed nothing, or the `patch` handed over is empty. Read the commission's result for why. Where the change was never made, commission it again. Where an earlier publication of this branch already committed it, never send the patch again. " +
  AS_IT_STANDS_AT_HEAD;

const COMMIT_STATE = (state: 'conflict' | 'empty') => ({
  expression: `tasks.commit.output.state == '${state}'`,
  onMissingRef: SKIP,
});

export const COMMIT_STOP_TASKS = [
  {
    taskId: 'commit-conflict',
    name: 'Stop on a patch that does not apply',
    goal: "Fail the publication where the patch does not apply on its branch, with git's account of what it could not place as the reason, so whoever started it is woken rather than handed a run that completed with no pull request.",
    failureInstruction: COMMIT_CONFLICT,
    type: 'operation' as const,
    operation: 'workflow.run.fail',
    dependsOn: ['commit'],
    when: COMMIT_STATE('conflict'),
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      branch: runInput('branch'),
      detail: out('commit', 'detail'),
    },
    context: ctx('workflow.run.fail'),
    inputTemplate: {
      reason: {
        $concat: [
          'The patch did not apply on `',
          bind('branch'),
          '`, and nothing was committed. ',
          {
            $firstOf: [
              { $concat: ['git said: ', bind('detail')] },
              'git named nothing it could not place.',
            ],
          },
        ],
      },
    },
  },

  {
    taskId: 'commit-empty',
    name: 'Stop on a change that touches no file',
    goal: 'Fail the publication where the change given touches no file, so nothing is committed, and say so, rather than complete with no pull request.',
    failureInstruction: COMMIT_EMPTY,
    type: 'operation' as const,
    operation: 'workflow.run.fail',
    dependsOn: ['commit'],
    when: COMMIT_STATE('empty'),
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { branch: runInput('branch') },
    context: ctx('workflow.run.fail'),
    inputTemplate: {
      reason: {
        $concat: [
          'The change touched no file, so nothing was committed on `',
          bind('branch'),
          '`.',
        ],
      },
    },
  },
];
