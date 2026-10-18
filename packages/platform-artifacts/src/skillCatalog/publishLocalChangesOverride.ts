import {
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_RESPONSE_PRESETS,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';
import { HANDOFF_PIN_PATH } from './localPrShepherdHandoff.js';
import { SHEPHERD_BUDGET_SPENT } from './localPrShepherdRules.js';
import { bind, ctx, github, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * An override sets the decision on the review's findings aside only on an
 * authority the run verifies from what it reads itself (Plan 315 D22), never
 * on the caller's say. `claim-override` reads which authority it names, and
 * only where it would set a decision aside — the review returned findings and
 * the decision is not already `publish_as_is` — which is exactly where the
 * composition records one. Only that authority's reads run; `verify-override`
 * decides from them, and a refusal fails the run with nothing pushed.
 *
 * The operator's word is the one authority no read can stand in for: it is
 * taken from the operator, as their approval of the push in this run, so a
 * verified operator override is one the gate asks about. A path through a
 * read that did not happen reads as null, so every rule that verifies
 * compares equal to what verifies it, and anything else is refused.
 */
export const OVERRIDE_CLAIM_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.override == null' },
    decision: 'none',
    reason: "No override was passed: the decision on the review's findings stands.",
  },
  {
    when: { expression: 'state.findings[0] == null' },
    decision: 'none',
    reason:
      'The review returned no findings, so nothing was decided: an override sets nothing aside, and is neither checked nor recorded.',
  },
  {
    when: { expression: "state.decided == 'publish_as_is'" },
    decision: 'none',
    reason:
      'The decision already is `publish_as_is`: an override sets nothing aside, and is neither checked nor recorded.',
  },
  {
    when: { expression: "state.override.by == 'operator'" },
    decision: 'operator',
    reason: "The override names the operator's word.",
  },
  {
    when: { expression: "state.override.by == 'hands_off_label'" },
    decision: 'hands_off_label',
    reason: `The override names the \`${SHEPHERD_HANDS_OFF_LABEL}\` label.`,
  },
  {
    when: { expression: "state.override.by == 'shepherd_rule'" },
    decision: 'shepherd_rule',
    reason: "The override names a rule of the shepherd's.",
  },
];

export const OVERRIDE_CLAIM_OTHERWISE = {
  decision: 'unrecognised',
  reason: 'The override names no authority the publication knows how to check.',
};

const STANDS =
  "Nothing was pushed, and the decision on the review's findings stands: the commit is still on its branch in the folder.";

export const OVERRIDE_VERIFY_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.override == null' },
    decision: 'none',
    reason: "No override was passed: the decision on the review's findings stands.",
  },
  {
    when: { expression: "state.claim == 'none'" },
    decision: 'none',
    reason: 'The override sets no decision aside here, so there is nothing to verify.',
  },
  {
    when: { expression: "state.claim == 'operator'" },
    decision: 'operator',
    reason:
      "The operator's word is taken only from the operator: the push waits for their approval in this run, which is that word on record, and a decline pushes nothing.",
  },
  {
    when: {
      allOf: ["state.claim == 'hands_off_label'", 'state.pr.pullRequests[0].handsOff == true'],
    },
    decision: 'hands_off_label',
    reason: `The branch's open pull request into the base carries the \`${SHEPHERD_HANDS_OFF_LABEL}\` label, as GitHub returned it.`,
  },
  {
    when: {
      allOf: [
        "state.claim == 'shepherd_rule'",
        'state.handoffStatus == 200',
        'state.handoff.found == true',
        "state.handoff.trust == 'verified'",
        `state.handoff.decision == '${SHEPHERD_BUDGET_SPENT}'`,
      ],
    },
    decision: 'shepherd_rule',
    reason: `The shepherd's own record on the branch's pull request — its pinned handoff, from the author it was pinned as — holds its decision \`${SHEPHERD_BUDGET_SPENT}\`: its attempt budget is spent.`,
  },
  {
    when: { expression: "state.claim == 'hands_off_label'" },
    decision: 'refused',
    reason: `The override names the \`${SHEPHERD_HANDS_OFF_LABEL}\` label, and no open pull request of the branch into the base — the loop's own, under the folder's prefix — carries it as GitHub returned it, or GitHub could not be asked. ${STANDS}`,
  },
  {
    when: { expression: "state.claim == 'shepherd_rule'" },
    decision: 'refused',
    reason: `The override names a rule of the shepherd's, and the shepherd's own record on the branch's pull request — its pinned handoff, trusted only from the author it was pinned as — does not hold the decision \`${SHEPHERD_BUDGET_SPENT}\`, or could not be read. ${STANDS}`,
  },
];

export const OVERRIDE_VERIFY_OTHERWISE = {
  decision: 'refused',
  reason: `The override names an authority the publication could not check. ${STANDS}`,
};

/** The stop on a refused override, beneath the refusal's own reason. */
export const OVERRIDE_REFUSED = `An override is taken only on an authority the publication verifies itself, and the reason above says which it named and what it read. Publish this branch as it stands without \`override\` to follow the decision — on \`fix_before_merge\`, commission the fix from the review run first — or once the authority holds: the operator's word is given at the publication's own approval, the \`${SHEPHERD_HANDS_OFF_LABEL}\` label is put on the branch's pull request by a person, and a shepherd rule is the shepherd's own record on it.`;

const claimed = (authority: string) => `tasks.claim-override.output.decision == '${authority}'`;

const REPOSITORY = { owner: runInput('owner'), repo: runInput('repo') };
const NUMBER = { number: out('read-override-pr', 'data.pullRequests[0].number') };

/**
 * The tasks that read and check an override, between the decision on the
 * findings and the composition, which runs only where none was refused.
 * `checksCleared` is the publication's own guard: nothing here runs on a
 * commit its checks did not clear.
 */
export function overrideTasks(checksCleared: { anyOf: string[]; onMissingRef: typeof SKIP }) {
  return [
    {
      taskId: 'claim-override',
      name: 'Read whose act the override names',
      goal: "Read whether an override was passed that would set the decision on the review's findings aside — the review returned findings, and the decision is not already publish_as_is — and which authority it names, so that authority's check alone runs.",
      type: 'operation' as const,
      operation: 'workflow.run.decide',
      dependsOn: ['review-commit', 'decide-after-review'],
      when: checksCleared,
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        override: runInput('override'),
        findings: out('review-commit', 'findings'),
        decided: out('decide-after-review', 'afterReview'),
      },
      context: ctx('workflow.run.decide'),
      inputTemplate: {
        state: { override: bind('override'), findings: bind('findings'), decided: bind('decided') },
        rules: OVERRIDE_CLAIM_RULES,
        otherwise: OVERRIDE_CLAIM_OTHERWISE,
      },
      outputProjection: {
        decision: { path: 'decision', onMissing: 'error' as const },
        reason: { path: 'reason', onMissing: 'error' as const },
      },
    },

    {
      taskId: 'read-override-pr',
      name: "Read the branch's pull request for the override",
      goal: `Where the override names the \`${SHEPHERD_HANDS_OFF_LABEL}\` label or a rule of the shepherd's, ask GitHub for the branch's open pull request into the base — the loop's own, under the folder's prefix — with whether it carries the label: either authority is read there.`,
      type: 'operation' as const,
      operation: 'api.http.call',
      dependsOn: ['claim-override', 'read-push-approval'],
      when: {
        anyOf: [claimed('hands_off_label'), claimed('shepherd_rule')],
        onMissingRef: SKIP,
      },
      // An answer that could not be had verifies nothing: the override is refused.
      optional: true,
      retryability: 'safe' as const,
      maxAttempts: 2,
      inputBindings: {
        ...REPOSITORY,
        branch: runInput('branch'),
        base: runInput('base'),
        prefix: out('read-push-approval', 'branchPolicy.branchPrefix'),
      },
      context: ctx('api.http.call'),
      inputTemplate: github(
        'listPullRequests',
        {
          owner: bind('owner'),
          repo: bind('repo'),
          head: { $concat: [bind('owner'), ':', bind('branch')] },
          base: bind('base'),
          state: 'open',
        },
        { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`, bind('prefix')] },
      ),
    },

    {
      taskId: 'read-override-pin',
      name: "Read which comment is the shepherd's record",
      goal: "Where the override names a rule of the shepherd's, read the handoff the shepherd pinned for the branch's pull request — the comment's id and the login it was posted as — so its record is read by that id and trusted only from that author.",
      type: 'operation' as const,
      operation: 'memory.store.get',
      dependsOn: ['read-override-pr'],
      when: {
        allOf: [
          claimed('shepherd_rule'),
          'tasks.read-override-pr.output.data.pullRequests[0].number != null',
        ],
        onMissingRef: SKIP,
      },
      optional: true,
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: { ...REPOSITORY, ...NUMBER },
      context: ctx('memory.store.get'),
      inputTemplate: {
        target: { path: HANDOFF_PIN_PATH },
        view: 'content',
        ifMissing: 'absent',
      },
    },

    {
      taskId: 'read-override-handoff',
      name: "Read the shepherd's record",
      goal: "Read the shepherd's pinned handoff comment by its id, and take its record only where the author it was pinned as wrote it, on this pull request.",
      type: 'operation' as const,
      operation: 'api.http.call',
      dependsOn: ['read-override-pr', 'read-override-pin'],
      when: {
        expression: 'tasks.read-override-pin.output.dataJson.commentId != null',
        onMissingRef: SKIP,
      },
      optional: true,
      retryability: 'safe' as const,
      maxAttempts: 2,
      inputBindings: {
        ...REPOSITORY,
        ...NUMBER,
        author: out('read-override-pin', 'dataJson.author'),
        commentId: out('read-override-pin', 'dataJson.commentId'),
      },
      context: ctx('api.http.call'),
      inputTemplate: github(
        'getIssueComment',
        { owner: bind('owner'), repo: bind('repo'), comment_id: bind('commentId') },
        {
          $concat: [
            `${SHEPHERD_RESPONSE_PRESETS.handoff}:`,
            { $firstOf: [{ $text: [bind('author')] }, ''] },
            ':',
            { $text: [bind('number')] },
          ],
        },
      ),
      outputProjection: {
        statusCode: { path: 'statusCode', onMissing: 'error' as const },
        data: { path: 'data', onMissing: 'error' as const },
      },
    },

    {
      taskId: 'verify-override',
      name: "Verify the override's authority",
      goal: `Decide, by rules over what the run read, whether the override's authority holds: the operator's word is taken at the push's approval; the \`${SHEPHERD_HANDS_OFF_LABEL}\` label must be on the branch's open pull request; a shepherd rule must be the shepherd's own pinned record holding \`${SHEPHERD_BUDGET_SPENT}\`. Anything else is refused.`,
      type: 'operation' as const,
      operation: 'workflow.run.decide',
      dependsOn: [
        'claim-override',
        'read-override-pr',
        'read-override-pin',
        'read-override-handoff',
      ],
      when: checksCleared,
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: {
        override: runInput('override'),
        claim: out('claim-override', 'decision'),
        pr: out('read-override-pr', 'data'),
        handoff: out('read-override-handoff', 'data'),
        handoffStatus: out('read-override-handoff', 'statusCode'),
      },
      context: ctx('workflow.run.decide'),
      inputTemplate: {
        state: {
          override: bind('override'),
          claim: bind('claim'),
          pr: bind('pr'),
          handoff: bind('handoff'),
          handoffStatus: bind('handoffStatus'),
        },
        rules: OVERRIDE_VERIFY_RULES,
        otherwise: OVERRIDE_VERIFY_OTHERWISE,
      },
      outputProjection: {
        decision: { path: 'decision', onMissing: 'error' as const },
        reason: { path: 'reason', onMissing: 'error' as const },
      },
      promoteOutputs: [
        { kind: 'output_path' as const, path: 'decision', toState: 'overrideCheck' },
        { kind: 'output_path' as const, path: 'reason', toState: 'overrideCheckReason' },
      ],
    },

    {
      taskId: 'override-refused',
      name: 'Stop on the refused override',
      goal: 'Fail the publication where the override names an authority the run could not verify, with what it read as the reason, so whoever started it is woken with the refusal and nothing is pushed.',
      failureInstruction: OVERRIDE_REFUSED,
      type: 'operation' as const,
      operation: 'workflow.run.fail',
      dependsOn: ['verify-override'],
      when: {
        expression: "tasks.verify-override.output.decision == 'refused'",
        onMissingRef: SKIP,
      },
      retryability: 'safe' as const,
      maxAttempts: 1,
      inputBindings: { reason: out('verify-override', 'reason') },
      context: ctx('workflow.run.fail'),
      inputTemplate: { reason: bind('reason') },
    },
  ];
}
