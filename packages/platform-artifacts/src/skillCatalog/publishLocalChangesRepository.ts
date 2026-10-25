import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * Which repository a publication pushes to and opens its pull request in, and
 * the branch that pull request targets: the folder's own `origin` and the
 * branch its HEAD names, read from the machine holding the folder, unless the
 * caller named them as `owner`, `repo` or `base` — each one passed overrides
 * the folder's for that one alone. Read once, before anything is committed,
 * so every task after it measures, pushes and opens against the same three,
 * and a publication nothing can name them for stops there with nothing done.
 */

const RESOLVE_TASK = 'resolve-repository';

export const REPOSITORY_KNOWN_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { allOf: ['state.owner != null', 'state.repo != null', 'state.base != null'] },
    decision: 'known',
    reason:
      "The repository and the base branch are named: each by the caller where they passed it, otherwise by the folder's `origin` and the branch its HEAD names.",
  },
];

export const REPOSITORY_UNKNOWN = {
  decision: 'unknown',
  reason:
    "Neither the caller nor the folder names the repository and the branch its pull request targets: the folder's `origin` is not on GitHub, or it could not say which branch its HEAD names.",
};

/** The stop where nothing names the repository, which says what to pass. */
export const REPOSITORY_UNKNOWN_FAILURE =
  "The publication could not tell which GitHub repository to open its pull request in, or which branch to target: the connected folder's `origin` is not a GitHub repository, or neither the folder's `refs/remotes/origin/HEAD` nor `origin` itself could say which branch its HEAD names. Nothing was committed. Start the publication again naming what the folder cannot: `owner` and `repo` for the repository, `base` for the branch.";

/** The repository and base as every task after the read binds them. */
export const OWNER = out(RESOLVE_TASK, 'repository.owner');
export const REPO = out(RESOLVE_TASK, 'repository.repo');
export const BASE = out(RESOLVE_TASK, 'repository.base');
export const REPOSITORY = { owner: OWNER, repo: REPO };

/** What the commit waits on: the repository read, and the stop where it named none. */
export const REPOSITORY_TASK_IDS = [RESOLVE_TASK, 'repository-unknown'];

/**
 * The read of the folder, the repository it settles on with the caller's
 * overrides first, and the stop where it settles on none. `after` is the
 * entry task: the run has exactly one, which carries its input surface.
 */
export function repositoryTasks(after: string) {
  return [
    {
      taskId: 'read-folder',
      name: "Read the folder's repository",
      goal: "Read, from the machine holding the connected folder, the GitHub repository its `origin` fetches from and the branch `origin`'s HEAD names — the repository the publication pushes to and the branch its pull request targets, where the caller named neither.",
      type: 'operation' as const,
      operation: 'host.binding.inspect',
      dependsOn: [after],
      retryability: 'safe' as const,
      inputBindings: { bindingId: runInput('bindingId') },
      context: ctx('host.binding.inspect'),
      inputTemplate: { bindingId: bind('bindingId'), defaultBranch: true },
    },

    {
      taskId: RESOLVE_TASK,
      name: 'Settle the repository and the base branch',
      goal: "Settle the repository and the base branch the publication uses — the caller's `owner`, `repo` and `base` where passed, otherwise the folder's `origin` and its default branch — and decide whether all three are named.",
      type: 'operation' as const,
      operation: 'workflow.run.decide',
      dependsOn: ['read-folder'],
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        ownerGiven: runInput('owner'),
        repoGiven: runInput('repo'),
        baseGiven: runInput('base'),
        folderOwner: out('read-folder', 'origin.owner'),
        folderRepo: out('read-folder', 'origin.repo'),
        folderBase: out('read-folder', 'origin.defaultBranch'),
      },
      context: ctx('workflow.run.decide'),
      inputTemplate: {
        state: {
          owner: { $firstOf: [bind('ownerGiven'), bind('folderOwner')] },
          repo: { $firstOf: [bind('repoGiven'), bind('folderRepo')] },
          base: { $firstOf: [bind('baseGiven'), bind('folderBase')] },
        },
        rules: REPOSITORY_KNOWN_RULES,
        otherwise: REPOSITORY_UNKNOWN,
      },
      outputProjection: {
        decision: { path: 'decision', onMissing: 'error' as const },
        reason: { path: 'reason', onMissing: 'error' as const },
        repository: { fromInput: 'state' },
      },
    },

    {
      taskId: 'repository-unknown',
      name: 'Stop where nothing names the repository',
      goal: 'Fail the publication before anything is committed where neither the caller nor the folder names the GitHub repository and the branch its pull request targets, saying which inputs name them.',
      type: 'operation' as const,
      operation: 'workflow.run.fail',
      dependsOn: [RESOLVE_TASK],
      when: {
        expression: `tasks.${RESOLVE_TASK}.output.decision == 'unknown'`,
        onMissingRef: SKIP,
      },
      retryability: 'safe' as const,
      maxAttempts: 1,
      context: ctx('workflow.run.fail'),
      inputTemplate: { reason: REPOSITORY_UNKNOWN_FAILURE },
    },
  ];
}
