import {
  SHEPHERD_ABANDON_DOCS,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_ROOT,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';
import { HANDOFF_WRITE_TASKS } from './localPrShepherdHandoff.js';
import { SHEPHERD_BUDGET_SPENT } from './localPrShepherdRules.js';
import { bind, ctx, NUMBER, out, REPOSITORY, SKIP } from './localPrShepherdWiring.js';

/**
 * The hand-over of the Local PR Shepherd (Plan 321 D4): where the attempt
 * budget is spent, the pass's handoff comment says why it stopped, and one
 * Action Center item asks a person to take the pull request — one per head,
 * however many passes find the budget spent on it.
 */

/**
 * `shepherd/<owner>/<repo>/pulls/<number>/abandons/<headSha>.json`, bound from
 * `owner`, `repo`, `number` and `headSha`.
 */
const ABANDON_CLAIM_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    `/${SHEPHERD_HANDOFF_PINS}/`,
    { $text: [bind('number')] },
    `/${SHEPHERD_ABANDON_DOCS}/`,
    bind('headSha'),
    '.json',
  ],
};

const DECIDED_ABANDON = `tasks.decide.output.decision == '${SHEPHERD_BUDGET_SPENT}'`;

const CLAIM_BINDINGS = { ...REPOSITORY, ...NUMBER, headSha: out('read-pr', 'data.headSha') };

/** The pass whose hand-over task closed its item: an answered item is never raised again. */
export const HAND_OVER_TASK = 'hand-over';

/**
 * Whether the head's claim stands. The decision is the claim's write mode:
 * `create` where none was read — a read that failed included, since a create
 * is refused wherever one exists — and `overwrite` where the claim is dead.
 * A claim is live while its pass is paused at the item, still running within
 * the lease's bound, or ended with the item answered. Any other — its pass
 * ended without an answer, cannot be read, or has run past the bound — left
 * no item a person can answer: its claim may have been written by a task that
 * never reported it, which then raised nothing, and it is taken over.
 */
export const ABANDON_CLAIM_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { anyOf: ['state.claim == null', 'state.claim.found == false'] },
    decision: 'create',
    reason: 'No hand-over of this head is recorded: this pass claims it and raises the item.',
  },
  {
    when: { expression: 'state.owner.taskOutput.taskId != null' },
    decision: 'live',
    reason: 'The item for this head was raised and answered: it is not raised again.',
  },
  {
    when: { expression: "state.owner.run.status == 'paused'" },
    decision: 'live',
    reason: 'The pass that claimed this head is paused at its item, waiting on a person.',
  },
  {
    when: {
      allOf: [
        "state.owner.run.status == 'running'",
        'state.claim.dataJson.handedOverAtMs >= state.staleBefore',
      ],
    },
    decision: 'live',
    reason:
      'The pass that claimed this head is still running, within the bound: it raises the item.',
  },
];

export const ABANDON_CLAIM_OTHERWISE = {
  decision: 'overwrite',
  reason:
    'The pass that claimed this head ended without an answered item, cannot be read, or has run past the bound: no item stands for the head, and this pass takes the claim over.',
};

/** A claim is written as the rules judged it: created, or a dead one taken over. */
const CLAIM_TASKS = ['create', 'overwrite'] as const;
type ClaimMode = (typeof CLAIM_TASKS)[number];

function claimTaskId(mode: ClaimMode) {
  return mode === 'create' ? 'claim-abandon' : 'claim-abandon-takeover';
}

/**
 * The head's claim, naming this run, written after the handoff comment. A
 * create is refused where another pass created one first; a takeover writes
 * over exactly the dead claim read, so of two passes taking it over the
 * second is refused. Either refusal leaves the pass without an item, which
 * is the other pass's to raise.
 */
function claimTask(mode: ClaimMode) {
  const takeover = mode === 'overwrite';
  return {
    taskId: claimTaskId(mode),
    name: takeover ? "Take over this head's dead claim" : 'Claim the hand-over of this head',
    goal: takeover
      ? 'Once the handoff comment says why the shepherd stopped, take over the claim on this head that a pass left without an item a person can answer — its run ended unanswered, cannot be read, or ran past the bound — exactly as it was read, so this pass raises the one Action Center item for the head.'
      : 'Once the handoff comment says why the shepherd stopped, record that this head of the pull request has been handed to a person — created only where nothing is recorded for it, so one Action Center item is raised for a head, however many passes find its budget spent and however they overlap.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    // After the comment: the item follows the record a person reads first.
    dependsOn: HANDOFF_WRITE_TASKS.map((task) => task.taskId),
    when: {
      allOf: [DECIDED_ABANDON, `tasks.judge-abandon-claim.output.decision == '${mode}'`],
      onMissingRef: SKIP,
    },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...CLAIM_BINDINGS,
      ...(takeover ? { claimHash: out('read-abandon-claim', 'stat.contentHash') } : {}),
      checkRunId: out('read-pr-checks', 'data.firstFailing.id'),
      runId: { kind: 'run_id' as const },
      handedOverAtMs: { kind: 'clock' as const },
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: ABANDON_CLAIM_PATH,
      writeMode: mode,
      ...(takeover ? { expectedHash: bind('claimHash') } : {}),
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd handed this head of the pull request to a person.',
      content: {
        inlineJson: {
          headSha: bind('headSha'),
          checkRunId: bind('checkRunId'),
          runId: bind('runId'),
          handedOverAtMs: bind('handedOverAtMs'),
        },
      },
    },
  };
}

export const ABANDON_TASKS = [
  {
    taskId: 'read-abandon-claim',
    name: "Read this head's hand-over claim",
    goal: 'Where the budget is spent, read whether a pass has already claimed the hand-over of this head, and which pass.',
    type: 'operation' as const,
    operation: 'memory.store.get',
    when: { expression: DECIDED_ABANDON, onMissingRef: SKIP },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: CLAIM_BINDINGS,
    context: ctx('memory.store.get'),
    inputTemplate: { target: { path: ABANDON_CLAIM_PATH }, view: 'content', ifMissing: 'absent' },
  },

  {
    taskId: 'read-abandon-owner',
    name: "Read the claim's pass",
    goal: 'Read the pass that claimed this head, and whether its item was answered.',
    type: 'operation' as const,
    operation: 'workflow.run.detail',
    when: {
      expression: 'tasks.read-abandon-claim.output.dataJson.runId != null',
      onMissingRef: SKIP,
    },
    // Unreadable, the claim is dead by rule.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { runId: out('read-abandon-claim', 'dataJson.runId') },
    context: ctx('workflow.run.detail'),
    inputTemplate: { runId: bind('runId'), compact: true, taskOutput: HAND_OVER_TASK },
  },

  {
    taskId: 'judge-abandon-claim',
    name: "Decide whether this head's claim stands",
    goal: 'Decide by rules whether this head is claimed by a pass whose item stands — raised and waiting, about to be raised, or answered — or the claim is to be created, or taken over from a pass that ended without one.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    when: { expression: DECIDED_ABANDON, onMissingRef: SKIP },
    retryability: 'safe' as const,
    inputBindings: {
      claim: out('read-abandon-claim'),
      owner: out('read-abandon-owner'),
      staleBefore: { kind: 'clock' as const, offsetMs: -SHEPHERD_LEASE_STALE_AFTER_MS },
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { claim: bind('claim'), owner: bind('owner'), staleBefore: bind('staleBefore') },
      rules: ABANDON_CLAIM_RULES,
      otherwise: ABANDON_CLAIM_OTHERWISE,
    },
  },

  claimTask('create'),
  claimTask('overwrite'),

  {
    taskId: HAND_OVER_TASK,
    name: 'The shepherd stopped on a pull request',
    goal: 'Ask a person to take over the pull request the shepherd stopped on — one Action Center item for its head. It approves nothing and changes nothing: whatever the person writes closes the item and ends the pass.',
    type: 'human' as const,
    intent: 'collect' as const,
    failureMode: 'isolate' as const,
    dependsOn: CLAIM_TASKS.map(claimTaskId),
    // Only a pass deciding `abandon` runs either claim.
    when: {
      anyOf: CLAIM_TASKS.map((mode) => `tasks.${claimTaskId(mode)}.status == 'succeeded'`),
      onMissingRef: SKIP,
    },
    pauseInstruction: `The Local PR Shepherd stopped on one of the loop's pull requests: CI failed on it again after the shepherd had acted on as many failures as its attempt budget allows. Its handoff comment on the pull request — the run's "Read the pull request" task names which — says which check run it last acted on and what each round did. It acts on this head no more: fix the branch yourself, push to it to have the shepherd read the new head, or label the pull request \`${SHEPHERD_HANDS_OFF_LABEL}\` to have it left alone. Submitting this closes the item and changes nothing else.`,
    outputContract: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: {
            type: 'string',
            maxLength: 2000,
            description:
              'What you will do with the pull request, for the run’s record. No rule reads it.',
          },
        },
      },
    },
  },
];
