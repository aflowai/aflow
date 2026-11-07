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
 * Two causes give `conflict` in `clean` mode, and only the second takes a
 * new commit. A patch already committed on the branch reads to git as files
 * that already exist or hunks that do not apply.
 */
export const COMMIT_CONFLICT =
  "The patch did not apply, so nothing was committed and no branch was created or moved. Nothing left the machine. The reason above quotes what git could not place. Where it says a file already exists in the working directory, or that the patch does not apply, ask first whether the branch's head already carries this change. It does where an earlier publication of this branch committed the same patch. Then never send the patch again, because the branch already holds it. " +
  AS_IT_STANDS_AT_HEAD +
  ' Otherwise the base moved under the patch, and the remedy is the merge round. Commission the fix from this branch with `mergeFrom: origin/<base>`. Then publish its `patchRef` onto this branch with its `baseSha`, and the sha it reports in `merge.from` as `mergeFrom`.';

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
