import {
  SHEPHERD_HAND_OVER_DOCS,
  SHEPHERD_HAND_OVER_TARGET,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_LEASE_ROOT,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import {
  DECIDED_HAND_OVER,
  HAND_OVER_CASE_OTHERWISE,
  HAND_OVER_CASE_RULES,
  HAND_OVER_MERGE_REFUSED,
} from './localPrShepherdRules.js';
import {
  bind,
  ctx,
  handoffBindings,
  handoffText,
  optionalPart,
  out,
  REPOSITORY,
  runInput,
  SKIP,
  text,
} from './localPrShepherdWiring.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';

/**
 * The hand-over of the Local PR Shepherd to the agent: a pass that ends on a
 * case its rules decide they cannot act on — a rule in `HAND_OVER_RULES`, or
 * a merge GitHub refused on the head — starts a Helmsman conversation carrying
 * what the pass read, what it decided and why, and what was tried before, so
 * the Helmsman decides and acts with the skills it has. The shepherd grows no
 * rule per case: what its rules do not cover is the agent's.
 *
 * The conversation is started as the platform starts any agent from a
 * workflow task: `agent.schedule.create`, one firing, now, the Helmsman its
 * target — as a plan stream's schedule starts it (Plan 322 P2b). A claim
 * created once per case comes first, so a case is handed over once however
 * many passes find it: a pull request's case is its head and what the pass
 * ended on, so a push that moves the head is a new one, and so is another
 * case on the same head.
 */

const MERGE_REFUSED = `tasks.record-merge.output.decision == '${HAND_OVER_MERGE_REFUSED}'`;

/**
 * `shepherd/<owner>/<repo>/pulls/<number>/handovers/<headSha>/<case>.json`
 * where the pass read a pull request, and else — a repository it could not
 * list — `shepherd/<owner>/<repo>/handovers/<turn>/<case>.json`, keyed by the
 * content hash of the turn as the pass read it, `none` where no turn was
 * read: one case until a pass lists the pull requests again. `<case>` is
 * the name `name-hand-over-case` gives it.
 */
const HAND_OVER_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    '/',
    {
      $firstOf: [
        {
          $concat: [
            `${SHEPHERD_HANDOFF_PINS}/`,
            text('number'),
            `/${SHEPHERD_HAND_OVER_DOCS}/`,
            bind('headSha'),
          ],
        },
        {
          $concat: [`${SHEPHERD_HAND_OVER_DOCS}/`, { $firstOf: [text('turnHash'), 'none'] }],
        },
      ],
    },
    '/',
    bind('handOverCase'),
    '.json',
  ],
};

export const NAME_HAND_OVER_CASE_TASK = 'name-hand-over-case';
export const READ_BRANCH_OWNER_TASK = 'read-branch-owner';
export const JUDGE_HAND_OVER_OWNER_TASK = 'judge-hand-over-owner';
export const CLAIM_HAND_OVER_TASK = 'claim-hand-over';
export const HAND_OVER_TO_AGENT_TASK = 'hand-over-to-agent';

/** The judgement that lets a case be claimed and handed to a new conversation. */
export const HAND_OVER_TO_NEW_CONVERSATION = 'hand_over';

const HAND_OVER_DEFERRED = 'defer';

/**
 * Plan 339 D4: a branch whose owning conversation is live is that
 * conversation's. The owner is the Helmsman conversation that started a
 * publication of the branch, and has not ended. A hand-over would start a
 * second conversation on the branch, and two publications on one branch
 * refuse each other, so the case is not handed over while the owner lives.
 * The owner hears the pull request's events itself. The claim is not taken,
 * so a pass after the owner has ended hands the case over.
 */
export const HAND_OVER_OWNER_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { allOf: ['state.headRef != null', 'state.owner == null'] },
    decision: HAND_OVER_DEFERRED,
    reason:
      "Whether a live conversation drives this pull request's branch could not be read, so no other conversation is started on it. A later pass reads it again.",
  },
  {
    when: { expression: 'state.owner.runs[0] != null' },
    decision: HAND_OVER_DEFERRED,
    reason:
      "A Helmsman conversation that has not ended started a publication of this branch, so the branch is that conversation's. It hears the pull request's events itself. No second conversation is started on the branch, because two publications on one branch refuse each other.",
  },
];

export const HAND_OVER_OWNER_OTHERWISE = {
  decision: HAND_OVER_TO_NEW_CONVERSATION,
  reason:
    'No live conversation drives this branch, so the case is handed to a new Helmsman conversation.',
};

const NAMED_A_CASE = `tasks.${NAME_HAND_OVER_CASE_TASK}.status == 'succeeded'`;
const HANDS_OVER = {
  expression: `tasks.${JUDGE_HAND_OVER_OWNER_TASK}.output.decision == '${HAND_OVER_TO_NEW_CONVERSATION}'`,
  onMissingRef: SKIP,
};

const ENDED_ON_HAND_OVER = { anyOf: [...DECIDED_HAND_OVER, MERGE_REFUSED], onMissingRef: SKIP };

/**
 * What the pass read, decided and tried, as the Helmsman reads it: one line
 * each, a line left out where its read did not happen. Facts, not a path: the
 * Helmsman decides what the case needs.
 */
const BRIEF = {
  $concat: [
    'The Local PR Shepherd ended a pass on a case its rules do not act on, and hands it to you. Decide what the case needs and act on it with the skills you have — Commission Change (`',
    COMMISSION_CHANGE.bundle.workflow.slug,
    "`) on the pull request's branch, its `base` the branch and its `mergeFrom` the base on origin; Local Publish (`",
    PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
    '`) to publish what that changed; `workflow.run.detail` on the pass; the space’s memory — or tell the operator what only they can do. The shepherd hands this case over once; its later passes read the pull request again and act where their rules allow.',
    '\n\nWhat the pass decided: `',
    bind('decision'),
    '` — ',
    bind('reason'),
    optionalPart('\nIts merge: ', bind('mergeReason')),
    optionalPart(' GitHub answered ', text('mergeStatus'), ': ', text('mergeMessage')),
    optionalPart(
      ' Attempted again, GitHub answered ',
      text('mergeAgainStatus'),
      ': ',
      text('mergeAgainMessage'),
    ),
    '\nThe pass: run `',
    bind('runId'),
    '` of the Local PR Shepherd.',
    '\nThe folder: `',
    bind('bindingId'),
    '`, whose origin is ',
    bind('owner'),
    '/',
    bind('repo'),
    '.',
    optionalPart(
      "\nGitHub's answer to the list of the repository's open pull requests: ",
      text('listStatus'),
    ),
    optionalPart(' — ', text('listMessage')),
    optionalPart('\nThe pull request: #', text('number')),
    optionalPart(' ', bind('url')),
    optionalPart(' — “', bind('title'), '”'),
    optionalPart(
      '\nIts branch: `',
      bind('headRef'),
      '` at `',
      bind('headSha'),
      '`, into `',
      bind('baseRef'),
      '`.',
    ),
    optionalPart('\nWhether it merges into its base, as GitHub says: ', text('mergeable')),
    optionalPart(' (`', bind('mergeableState'), '`)'),
    optionalPart('\nCI on the head: ', text('checksState')),
    optionalPart(
      '; the failing check run it reads: `',
      bind('failingName'),
      '` (',
      text('failingId'),
      ')',
    ),
    optionalPart('\nRequired checks not passed on the head: ', text('requiredUnmet')),
    optionalPart(
      '\nThe Local Code Review of the publication that pushed the head: `',
      text('verdict'),
      '`, for `',
      text('reviewedAt'),
      '`',
    ),
    optionalPart('\nA person’s review requests changes: ', text('changesRequestedBy')),
    optionalPart(
      '\nTried before, as the handoff comment records it: failures acted on ',
      handoffText('attempts'),
    ),
    optionalPart('; the last decision `', handoffText('priorDecision'), '`'),
    optionalPart('; the last remedy `', handoffText('priorRemedy'), '`'),
    optionalPart('; the remedy question answered `', handoffText('priorClassification'), '`'),
    optionalPart('; the last publication run `', handoffText('priorPublication'), '`'),
    '\n\nTwo rules hold whatever you decide. Start every commission on this branch fresh, with no `continueFrom`. A kept coding session belongs to the conversation or the run that made it, so the machine refuses it to this one. Never publish the branch as it stands while CI is red on its head and the head has not moved, because the checks would run again on a commit CI has judged.',
  ],
};

export const HAND_OVER_TASKS = [
  {
    taskId: NAME_HAND_OVER_CASE_TASK,
    name: 'Name the case handed over',
    goal: 'Where the pass ended on a case its rules cannot act on, name it — the merge GitHub refused, or the rule the pass ended on — so its claim is kept per case: a head handed over for one case is still handed over for another.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    when: ENDED_ON_HAND_OVER,
    retryability: 'safe' as const,
    inputBindings: {
      rule: out('decide', 'rule'),
      mergeOutcome: out('record-merge', 'decision'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { rule: bind('rule'), mergeOutcome: bind('mergeOutcome') },
      rules: HAND_OVER_CASE_RULES,
      otherwise: HAND_OVER_CASE_OTHERWISE,
    },
  },

  {
    taskId: READ_BRANCH_OWNER_TASK,
    name: "Read whether a live conversation drives the pull request's branch",
    goal: "Where the pass ended on a case it hands over, list the publications of the pull request's branch that a Helmsman conversation started and has not ended, whatever their status. Such a conversation owns the branch, and no second one is started on it.",
    type: 'operation' as const,
    operation: 'workflow.run.list',
    when: {
      allOf: [NAMED_A_CASE, 'tasks.read-pr.output.data.headRef != null'],
      onMissingRef: SKIP,
    },
    // A read that failed binds as absent, which the judgement reads as an
    // owner not known to be gone: nothing is handed over on it.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { headRef: out('read-pr', 'data.headRef') },
    context: ctx('workflow.run.list'),
    inputTemplate: {
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: bind('headRef') },
      drivenByLiveConversation: true,
      status: ['running', 'paused', 'completed', 'failed', 'cancelled'],
      limit: 1,
    },
  },

  {
    taskId: JUDGE_HAND_OVER_OWNER_TASK,
    name: 'Judge whether the case goes to a new conversation',
    goal: "Decide whether the case goes to a new Helmsman conversation. It does not where a live conversation drives the pull request's branch, or where that could not be read: the branch is that conversation's, and two publications on one branch refuse each other.",
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    when: { expression: NAMED_A_CASE, onMissingRef: SKIP },
    retryability: 'safe' as const,
    inputBindings: {
      headRef: out('read-pr', 'data.headRef'),
      owner: out(READ_BRANCH_OWNER_TASK),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { headRef: bind('headRef'), owner: bind('owner') },
      rules: HAND_OVER_OWNER_RULES,
      otherwise: HAND_OVER_OWNER_OTHERWISE,
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'decision', toState: 'handOver' },
      { kind: 'output_path' as const, path: 'reason', toState: 'handOverReason' },
    ],
  },

  {
    taskId: CLAIM_HAND_OVER_TASK,
    name: 'Claim the hand-over of this case',
    goal: 'Where the pass ended on a case its rules cannot act on — a rule that hands its case over, or a merge GitHub refused on the head — and no live conversation drives the branch, record that the case is handed to the agent: created only where nothing is recorded for it, so a case is handed over once however many passes find it. A pull request’s case is its head and the case’s name, so a push that moves the head is a new case, and so is another case on the same head.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: HANDS_OVER,
    // Refused where the case was handed over already — the claim doing its
    // job — or where the store could not answer: nothing is handed over twice.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...REPOSITORY,
      number: out('read-pr', 'data.number'),
      headSha: out('read-pr', 'data.headSha'),
      turnHash: out('read-turn', 'stat.contentHash'),
      handOverCase: out(NAME_HAND_OVER_CASE_TASK, 'decision'),
      rule: out('decide', 'rule'),
      decision: out('decide', 'decision'),
      mergeOutcome: out('record-merge', 'decision'),
      runId: { kind: 'run_id' as const },
      handedOverAtMs: { kind: 'clock' as const },
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: HAND_OVER_PATH,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd handed this case to the Helmsman.',
      content: {
        inlineJson: {
          headSha: bind('headSha'),
          case: bind('handOverCase'),
          rule: bind('rule'),
          decision: bind('decision'),
          mergeOutcome: bind('mergeOutcome'),
          runId: bind('runId'),
          handedOverAtMs: bind('handedOverAtMs'),
        },
      },
    },
  },

  {
    taskId: HAND_OVER_TO_AGENT_TASK,
    name: 'Hand the case to the Helmsman',
    goal: "Start a Helmsman conversation on the case this pass claimed, now and once, carrying what the pass read — the pull request, its head, CI, whether it merges, the review's verdict, GitHub's refusal and its message, the folder — what it decided and why, and what the handoff records as tried before, so the Helmsman decides and acts with the skills it has.",
    type: 'operation' as const,
    operation: 'agent.schedule.create',
    when: {
      expression: `tasks.${CLAIM_HAND_OVER_TASK}.status == 'succeeded'`,
      onMissingRef: SKIP,
    },
    // A hand-over that could not be made leaves the pass as it decided; the
    // claim stands, so the case is not handed over again.
    optional: true,
    // A second attempt would start a second conversation.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...REPOSITORY,
      bindingId: runInput('bindingId'),
      runId: { kind: 'run_id' as const },
      now: { kind: 'clock' as const, format: 'iso' as const },
      decision: out('decide', 'decision'),
      reason: out('decide', 'reason'),
      mergeReason: out('record-merge', 'reason'),
      mergeStatus: out('merge', 'statusCode'),
      mergeMessage: out('merge', 'data.message'),
      mergeAgainStatus: out('merge-again', 'statusCode'),
      mergeAgainMessage: out('merge-again', 'data.message'),
      listStatus: out('list-prs', 'statusCode'),
      listMessage: out('list-prs', 'data.message'),
      number: out('read-pr', 'data.number'),
      url: out('read-pr', 'data.url'),
      title: out('read-pr', 'data.title'),
      headRef: out('read-pr', 'data.headRef'),
      headSha: out('read-pr', 'data.headSha'),
      baseRef: out('read-pr', 'data.baseRef'),
      mergeable: out('read-pr', 'data.mergeable'),
      mergeableState: out('read-pr', 'data.mergeableState'),
      checksState: out('read-pr-checks', 'data.state'),
      failingName: out('read-pr-checks', 'data.firstFailing.name'),
      failingId: out('read-pr-checks', 'data.firstFailing.id'),
      requiredUnmet: out('read-pr-checks', 'data.required.summary'),
      verdict: out('read-publication-review', 'taskOutput.output.verdict'),
      reviewedAt: out('read-publication-review', 'taskOutput.output.reviewed.at'),
      changesRequestedBy: out('read-pr-reviews', 'data.changesRequestedBy[0]'),
      ...handoffBindings('attempts', 'data.attemptCount'),
      ...handoffBindings('priorDecision', 'data.decision'),
      ...handoffBindings('priorRemedy', 'data.remedy'),
      ...handoffBindings('priorClassification', 'data.classification'),
      ...handoffBindings('priorPublication', 'data.publicationRunId'),
    },
    context: ctx('agent.schedule.create'),
    inputTemplate: {
      name: {
        $concat: [
          'Local PR Shepherd hands over ',
          bind('owner'),
          '/',
          bind('repo'),
          optionalPart(' #', text('number')),
        ],
      },
      description:
        'A case a pass of the Local PR Shepherd ended on and its rules do not act on, handed to the Helmsman once.',
      action: 'start_run',
      target: SHEPHERD_HAND_OVER_TARGET,
      scheduledAt: bind('now'),
      input: { input: BRIEF },
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'scheduleId', toState: 'handOverScheduleId' },
    ],
  },
];
