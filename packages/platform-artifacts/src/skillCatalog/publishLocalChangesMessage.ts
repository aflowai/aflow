import type { WorkflowRunDecideRule, WorkflowRunInputRequiredWhen } from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * Where a publication's commit message comes from. A caller who passes
 * `commitMessage` says it themselves; otherwise a change a commission made is
 * committed under the commission's own `summary` — a title line under 72
 * characters and one paragraph — read from the completed Commission Change on
 * this folder that reported the `patchRef` being published. A run id named as
 * `commission` is held to that run: one naming any other is refused before
 * anything is committed, rather than committing the change under another
 * change's title. A change with no `patchRef` — a diff the operator hands
 * over, or a merge alone — has no summary that can be checked against it, and
 * is refused at the start without `commitMessage`.
 */

/** The commission's task, whose recorded `patchRef` finds its run. */
const COMMISSION_TASK = COMMISSION_CHANGE.bundle.workflow.tasks[0]?.taskId ?? 'commission';

export const COMMISSION_RUN_ID_SCHEMA = {
  type: 'string',
  format: 'uuid',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'The run id `workflow.run.start` reported for the Commission Change.',
};

export const COMMIT_MESSAGE_REQUIRED_WHEN: WorkflowRunInputRequiredWhen = {
  anyGiven: ['patch', 'mergeFrom'],
  noneGiven: ['patchRef'],
  reason:
    "every commit needs a message, and only the `summary` of the commission that reported the `patchRef` being published stands in for one. Pass `commitMessage` — a title line under 72 characters, a blank line, then what the change does and why — or publish the commission's change as its `patchRef`.",
};

export const MESSAGE_FROM_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.commitMessage != null' },
    decision: 'given',
    reason: 'The caller passed the commit message: the commit carries it as it stands.',
  },
  {
    when: {
      allOf: ['state.patchRef == null', 'state.patch == null', 'state.mergeFrom == null'],
    },
    decision: 'as_it_stands',
    reason:
      'Nothing is committed: the branch is published as it stands, and its head keeps its own message.',
  },
  {
    when: { allOf: ['state.commission != null', 'state.patchRef != null'] },
    decision: 'from_commission',
    reason:
      'The commit carries the summary of the commission the caller named, once it is found to be the one on this folder that reported this `patchRef`: its title, a blank line, then its paragraph.',
  },
  {
    when: { expression: 'state.patchRef != null' },
    decision: 'find_commission',
    reason:
      'The commit carries the summary of the commission that reported this `patchRef`: its title, a blank line, then its paragraph.',
  },
];

export const MESSAGE_FROM_OTHERWISE = {
  decision: 'none',
  reason:
    'No commit message and no commission to take one from: the start refuses such a change, so the commit is made without one only where nothing is committed.',
};

const FINDS_COMMISSION = {
  anyOf: [
    "tasks.message-from.output.decision == 'from_commission'",
    "tasks.message-from.output.decision == 'find_commission'",
  ],
  onMissingRef: SKIP,
};

export const COMMISSION_CHECK_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.found == state.commission' },
    decision: 'confirmed',
    reason:
      'The commission the caller named is the completed Commission Change on this folder that reported this `patchRef`.',
  },
];

export const COMMISSION_CHECK_OTHERWISE = {
  decision: 'refused',
  reason:
    'The commission the caller named is not the completed Commission Change on this folder that reported this `patchRef`.',
};

/** The commission whose summary is read: the one the `patchRef` found, named or not. */
const READS_COMMISSION = {
  anyOf: [
    "tasks.message-from.output.decision == 'find_commission'",
    "tasks.check-commission.output.decision == 'confirmed'",
  ],
  onMissingRef: SKIP,
};

/**
 * The publication's first tasks: which way the message comes, the commission
 * found by its `patchRef`, a named run id checked against it and the stop on
 * one that differs, and the found commission's summary read.
 * `entryContract` is the run's whole input surface, which the entry task
 * carries for the start to check the caller's inputs against.
 */
export function commitMessageTasks<Contract extends { bindings: object }>(entryContract: Contract) {
  return [
    {
      taskId: 'message-from',
      name: 'Decide where the commit message comes from',
      goal: "Decide, by rules over the run's inputs, where the commit's message comes from: the `commitMessage` the caller passed; none, where the branch is published as it stands; or the `summary` of the commission that made the change — the one on this folder that reported this `patchRef`, which a commission named as `commission` has to be.",
      type: 'operation' as const,
      operation: 'workflow.run.decide',
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        commitMessage: runInput('commitMessage'),
        commission: runInput('commission'),
        patchRef: runInput('patchRef'),
        patch: runInput('patch'),
        mergeFrom: runInput('mergeFrom'),
      },
      // Every run input is declared here, including the ones only later tasks
      // read: start-time validation checks the caller's inputs against the
      // ENTRY task's surface, and a slot missing from it is refused rather
      // than passed on.
      inputContract: entryContract,
      context: ctx('workflow.run.decide'),
      inputTemplate: {
        state: {
          commitMessage: bind('commitMessage'),
          commission: bind('commission'),
          patchRef: bind('patchRef'),
          patch: bind('patch'),
          mergeFrom: bind('mergeFrom'),
        },
        rules: MESSAGE_FROM_RULES,
        otherwise: MESSAGE_FROM_OTHERWISE,
      },
      outputProjection: {
        decision: { path: 'decision', onMissing: 'error' as const },
        reason: { path: 'reason', onMissing: 'error' as const },
      },
    },

    {
      taskId: 'find-commission',
      name: 'Find the commission that made the change',
      goal: "Find the completed Commission Change on this folder whose change is this run's `patchRef`, so the commit carries that commission's summary — and a commission the caller named is held to it.",
      failureInstruction:
        'No completed Commission Change on this folder reported this `patchRef`, so there is no summary to commit it under, and nothing was committed. Start the publication again with `commitMessage` — a title line under 72 characters, a blank line, then what the change does and why.',
      type: 'operation' as const,
      operation: 'workflow.run.list',
      dependsOn: ['message-from'],
      when: FINDS_COMMISSION,
      // One attempt and no output contract: a commission that cannot be found
      // fails the run here, with nothing committed.
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        bindingId: runInput('bindingId'),
        patchRef: runInput('patchRef'),
      },
      context: ctx('workflow.run.list'),
      inputTemplate: {
        slug: COMMISSION_CHANGE.bundle.workflow.slug,
        input: { field: 'bindingId', equals: bind('bindingId') },
        succeeded: [
          { taskId: COMMISSION_TASK, output: { path: 'patchRef', equals: bind('patchRef') } },
        ],
        status: ['completed'],
        limit: 1,
      },
      outputProjection: {
        commissionRunId: { path: 'runs[0].id', onMissing: 'error' as const },
      },
    },

    {
      taskId: 'check-commission',
      name: 'Check the named commission',
      goal: 'Decide whether the commission the caller named is the one found to have reported this `patchRef` on this folder, so the change is never committed under the summary of another.',
      type: 'operation' as const,
      operation: 'workflow.run.decide',
      dependsOn: ['message-from', 'find-commission'],
      when: {
        expression: "tasks.message-from.output.decision == 'from_commission'",
        onMissingRef: SKIP,
      },
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        commission: runInput('commission'),
        found: out('find-commission', 'commissionRunId'),
      },
      context: ctx('workflow.run.decide'),
      inputTemplate: {
        state: { commission: bind('commission'), found: bind('found') },
        rules: COMMISSION_CHECK_RULES,
        otherwise: COMMISSION_CHECK_OTHERWISE,
      },
      outputProjection: {
        decision: { path: 'decision', onMissing: 'error' as const },
        reason: { path: 'reason', onMissing: 'error' as const },
      },
    },

    {
      taskId: 'commission-refused',
      name: 'Stop on the wrong commission',
      goal: "Fail the publication where the commission the caller named is not the one that reported this `patchRef` on this folder, naming the one that did, so nothing is committed under another change's summary.",
      type: 'operation' as const,
      operation: 'workflow.run.fail',
      dependsOn: ['check-commission'],
      when: {
        expression: "tasks.check-commission.output.decision == 'refused'",
        onMissingRef: SKIP,
      },
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        commission: runInput('commission'),
        found: out('find-commission', 'commissionRunId'),
      },
      context: ctx('workflow.run.fail'),
      inputTemplate: {
        reason: {
          $concat: [
            '`commission` names the run `',
            bind('commission'),
            '`, but the completed Commission Change on this folder that reported this `patchRef` is the run `',
            bind('found'),
            "`, so the change would have been committed under another change's summary, and nothing was committed. Start the publication again with `",
            bind('found'),
            '` as `commission`, or with `commitMessage`.',
          ],
        },
      },
    },

    {
      taskId: 'read-commission',
      name: "Read the commission's summary",
      goal: "Read the summary the commission's coding agent wrote of its change — a title line and one paragraph — from the run of the commission that reported this `patchRef`, for the commit to carry.",
      failureInstruction:
        "The commission's run holds no summary to commit the change under — its coding agent wrote no valid one, which its `resultProblem` says, or it ran before commissions reported one — and nothing was committed. Start the publication again with `commitMessage`: a title line under 72 characters, a blank line, then what the change does and why.",
      type: 'operation' as const,
      operation: 'workflow.run.detail',
      // After the stop on a wrong commission: a dependency that failed holds
      // this task, and with it the commit, from running at all.
      dependsOn: ['message-from', 'find-commission', 'check-commission', 'commission-refused'],
      when: READS_COMMISSION,
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        foundRunId: out('find-commission', 'commissionRunId'),
      },
      context: ctx('workflow.run.detail'),
      inputTemplate: {
        runId: bind('foundRunId'),
        compact: true,
      },
      outputProjection: {
        title: { path: 'result.output.summary.title', onMissing: 'error' as const },
        paragraph: { path: 'result.output.summary.paragraph', onMissing: 'error' as const },
      },
    },
  ];
}

/** What the commit binds to compose a message from the commission's summary. */
export const COMMIT_MESSAGE_BINDINGS = {
  commitMessage: runInput('commitMessage'),
  summaryTitle: out('read-commission', 'title'),
  summaryParagraph: out('read-commission', 'paragraph'),
};

/**
 * The message the commit is made with: the caller's, else the summary as a
 * commit message — its title, a blank line, its paragraph — else none, which
 * only a branch published as it stands goes without.
 */
export const COMMIT_MESSAGE_VALUE = {
  $firstOf: [
    bind('commitMessage'),
    { $concat: [bind('summaryTitle'), '\n\n', bind('summaryParagraph')] },
  ],
};
