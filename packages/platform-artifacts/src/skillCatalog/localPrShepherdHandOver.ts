import {
  SHEPHERD_HAND_OVER_DOCS,
  SHEPHERD_HAND_OVER_TARGET,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_LEASE_ROOT,
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
export const CLAIM_HAND_OVER_TASK = 'claim-hand-over';
export const HAND_OVER_TO_AGENT_TASK = 'hand-over-to-agent';

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
    taskId: CLAIM_HAND_OVER_TASK,
    name: 'Claim the hand-over of this case',
    goal: 'Where the pass ended on a case its rules cannot act on — a rule that hands its case over, or a merge GitHub refused on the head — record that the case is handed to the agent: created only where nothing is recorded for it, so a case is handed over once however many passes find it. A pull request’s case is its head and the case’s name, so a push that moves the head is a new case, and so is another case on the same head.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: ENDED_ON_HAND_OVER,
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
