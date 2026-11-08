import type { HostPatchConflictRemedy } from '@aflow/schemas';

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
 * What each remedy the executor computes on a conflict lets the caller do
 * (`HostPatchConflictRemedySchema`). The executor decides the kind from its
 * own refusal rules, so this text predicts no outcome of its own. Keyed by
 * kind, so a test can hold each entry to the rule it rests on.
 */
export const CONFLICT_REMEDIES: Record<HostPatchConflictRemedy['kind'], string> = {
  publish_as_it_stands:
    'The branch existed, and its head `at` already holds this change. Never send the patch again. ' +
    publishAsItStands("`at`, the branch's head the reason names"),
  nothing_to_commit:
    'This run was making a new branch, and `at` already holds this change. A commit at `at` would change nothing. ' +
    'No branch exists, so a publication of it as it stands is refused. Report that `at` already holds the change.',
  fit_branch_head:
    'The branch existed, and its head `at` does not hold this change. ' +
    'A new run on this branch naming a `baseSha` other than `at` is refused as `stale_base` before any apply. ' +
    "Where the commission reported `baseSha` `at` and a `merge.from` other than this run's `mergeFrom`, publish the same `patchRef` again with that `mergeFrom`. " +
    'Otherwise commission the change again from this branch, so its patch is made against `at`.',
  fit_another_base:
    'This run was making a new branch, and `at` does not hold this change. ' +
    'A new branch starts at any `baseSha` named, so a new run is not refused for its base. ' +
    'Where the commission reported a `baseSha` other than `at`, publish the same `patchRef` again with it. ' +
    'Otherwise commission the change again.',
};

export const COMMIT_CONFLICT =
  'The patch did not apply, so nothing was committed and no branch was created or moved. Nothing left the machine. ' +
  'The reason quotes what git could not place, and names the remedy the executor computed and `at`, the commit the patch was applied at. ' +
  'Act on that remedy alone. ' +
  Object.entries(CONFLICT_REMEDIES)
    .map(([kind, text]) => `\`${kind}\`: ${text}`)
    .join(' ');

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
      remedy: out('commit', 'remedy.kind'),
      at: out('commit', 'remedy.at'),
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
          ' The remedy is `',
          bind('remedy'),
          '`, at `',
          bind('at'),
          '`.',
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
