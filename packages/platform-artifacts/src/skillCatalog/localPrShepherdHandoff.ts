import {
  SHEPHERD_HANDOFF_CLOSE,
  SHEPHERD_HANDOFF_OPEN,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_ROOT,
  SHEPHERD_MERGE_OUTCOME_FIELDS,
  SHEPHERD_MERGE_OUTCOME_LINE,
  SHEPHERD_RESPONSE_PRESETS,
} from '@aflow/schemas';
import { REMEDY } from './localPrShepherdRemedies.js';
import {
  bind,
  ctx,
  github,
  HANDOFF_READS,
  handoffBindings,
  handoffText,
  handoffValue,
  leaseBindings,
  leaseText,
  NUMBER,
  OURS,
  optionalPart,
  out,
  REPOSITORY,
  SKIP,
  text,
} from './localPrShepherdWiring.js';

/**
 * `shepherd/<owner>/<repo>/pulls/<number>.json`: a pull request's pinned
 * handoff, never a branch's, bound from `owner`, `repo` and `number`. Its one
 * spelling: Local Publish verifies a shepherd-rule override by reading the pin
 * here, and a read spelled apart from this write would refuse every one.
 */
export const HANDOFF_PIN_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    `/${SHEPHERD_HANDOFF_PINS}/`,
    { $text: [bind('number')] },
    '.json',
  ],
};

/** The login the pinned handoff was posted as: the one author whose record is trusted. */
const PINNED_AUTHOR = { author: out('read-handoff-pin', 'dataJson.author') };

/**
 * `loop_handoff:<author>:<number>` — the record trusted only from the pinned
 * author, and only on this pull request; with no pin, no author, and nothing
 * trusted.
 */
const HANDOFF_PRESET = {
  $concat: [
    `${SHEPHERD_RESPONSE_PRESETS.handoff}:`,
    { $firstOf: [{ $text: [bind('author')] }, ''] },
    ':',
    { $text: [bind('number')] },
  ],
};

/**
 * The same, with the attempt state the pin kept — `:<attempts>:<checkRunId>`
 * — wherever a pin holds one: the newest page is read with a pin only after
 * its comment answered 404, and a deleted record is not a first pass.
 */
const HANDOFF_PRESET_CARRIED = {
  $concat: [
    ...HANDOFF_PRESET.$concat,
    optionalPart(':', text('carriedAttempts'), ':', {
      $firstOf: [text('carriedCheckRun'), ''],
    }),
  ],
};

/** The handoff this pass wrote, from whichever write it was: posted, or rewritten. */
const HANDOFF_WRITES = ['handoff', 'handoff-edit'] as const;

function writtenBindings(name: string, path: string) {
  return Object.fromEntries(
    HANDOFF_WRITES.map((taskId) => [`${name}_${taskId.replace(/-/g, '_')}`, out(taskId, path)]),
  );
}

function writtenValue(name: string) {
  return { $firstOf: HANDOFF_WRITES.map((taskId) => bind(`${name}_${taskId.replace(/-/g, '_')}`)) };
}

// --- The handoff -------------------------------------------------------------

/**
 * The record a pass leaves: the last action and this pass's decision, as
 * `key: value` lines the next pass reads back (`parseShepherdHandoff`), then
 * the same in words. What was acted on comes from the lease — which a pass
 * takes only to act — and otherwise stands as the earlier record had it.
 */
/** The first of the alternatives each node offers, then `fallback`. */
function firstText(nodes: Array<{ $firstOf: unknown[] }>, fallback: string) {
  return { $firstOf: [...nodes.flatMap((node) => node.$firstOf), fallback] };
}

// The count a fix writes rides on its remedy record, which only a fix makes:
// a merge takes the lease too, and is no failure acted on.
const ATTEMPTS = firstText([{ $firstOf: [text('fixAttempt')] }, handoffText('priorAttempt')], '0');
const CHECK_RUN = firstText([leaseText('leaseCheckRun'), handoffText('priorCheckRun')], '');
const HEAD_SHA = firstText([leaseText('leaseHeadSha'), handoffText('priorHeadSha')], '');
const CLASSIFICATION = firstText(
  [{ $firstOf: [text('classification')] }, handoffText('priorClassification')],
  '',
);
const PUBLICATION = firstText(
  [{ $firstOf: [text('publicationRunId')] }, handoffText('priorPublication')],
  '',
);
const REMEDY_TAKEN = firstText([{ $firstOf: [text('remedy')] }, handoffText('priorRemedy')], '');

/**
 * Each merge outcome an earlier pass recorded, carried forward: the rules
 * compare it to the head, so one recorded for a head a push has since moved
 * holds nothing back.
 */
const PRIOR_MERGE_OUTCOMES = SHEPHERD_MERGE_OUTCOME_FIELDS.flatMap((field) => [
  `\n${field}: `,
  firstText([handoffText(`prior_${field}`)], ''),
]);

/**
 * This pass's merge outcome, as the rule step that read it named it, with the
 * merge commit GitHub answered with, or else the head the request was pinned
 * to. The reader files it under the outcome's field, over one carried forward.
 */
const MERGE_OUTCOME = optionalPart(
  `\n${SHEPHERD_MERGE_OUTCOME_LINE}: `,
  bind('mergeOutcome'),
  ' ',
  { $firstOf: [text('mergeCommit'), leaseText('leaseHeadSha')] },
);

const HANDOFF_BODY = {
  $concat: [
    `${SHEPHERD_HANDOFF_OPEN}\n`,
    'attemptCount: ',
    ATTEMPTS,
    '\ncheckRunId: ',
    CHECK_RUN,
    '\nheadSha: ',
    HEAD_SHA,
    '\ndecision: ',
    bind('decision'),
    '\nclassification: ',
    CLASSIFICATION,
    '\nremedy: ',
    REMEDY_TAKEN,
    '\npublicationRunId: ',
    PUBLICATION,
    ...PRIOR_MERGE_OUTCOMES,
    MERGE_OUTCOME,
    `\n${SHEPHERD_HANDOFF_CLOSE}\n`,
    '**Local PR Shepherd** — this pass: `',
    bind('decision'),
    '`. ',
    bind('reason'),
    optionalPart('\n\nRequired checks not passed on the head: ', text('requiredUnmet'), '.'),
    optionalPart('\n\nThe merge: ', bind('mergeReason')),
    optionalPart(' GitHub answered ', text('mergeStatus'), ': ', text('mergeMessage')),
    '\n\nFailures acted on: ',
    ATTEMPTS,
    '. Last acted on check run `',
    firstText([leaseText('leaseCheckRun'), handoffText('priorCheckRun')], 'none'),
    '`; the remedy question answered `',
    firstText(
      [{ $firstOf: [text('classification')] }, handoffText('priorClassification')],
      'nothing',
    ),
    '`; publication run `',
    firstText([{ $firstOf: [text('publicationRunId')] }, handoffText('priorPublication')], 'none'),
    `\`.\n\n_The shepherd never approves or closes a pull request, and merges one only where its folder's merge posture is \`when-green\`, on the operator's approval. Label it \`${SHEPHERD_HANDS_OFF_LABEL}\` to have it left alone._`,
  ],
};

const HANDOFF_BINDINGS = {
  ...REPOSITORY,
  decision: out('decide', 'decision'),
  reason: out('decide', 'reason'),
  fixAttempt: out('record-remedy', 'round.attempt'),
  ...Object.fromEntries(
    SHEPHERD_MERGE_OUTCOME_FIELDS.flatMap((field) =>
      Object.entries(handoffBindings(`prior_${field}`, `data.${field}`)),
    ),
  ),
  requiredUnmet: out('read-pr-checks', 'data.required.summary'),
  mergeOutcome: out('record-merge', 'decision'),
  mergeReason: out('record-merge', 'reason'),
  mergeCommit: out('merge', 'data.sha'),
  mergeStatus: out('merge', 'statusCode'),
  mergeMessage: out('merge', 'data.message'),
  ...leaseBindings('leaseCheckRun', 'lease.inlineJson.checkRunId'),
  ...leaseBindings('leaseHeadSha', 'lease.inlineJson.headSha'),
  ...handoffBindings('priorAttempt', 'data.attemptCount'),
  ...handoffBindings('priorCheckRun', 'data.checkRunId'),
  ...handoffBindings('priorHeadSha', 'data.headSha'),
  ...handoffBindings('priorClassification', 'data.classification'),
  ...handoffBindings('priorPublication', 'data.publicationRunId'),
  classification: out('classify-failure', `${REMEDY}.value`),
  remedy: out('record-remedy', 'decision'),
  ...handoffBindings('priorRemedy', 'data.remedy'),
  publicationRunId: out('publish', 'runId'),
};

/** What {@link ATTEMPTS} and {@link CHECK_RUN} read, for the pin that keeps them. */
const ATTEMPT_STATE_BINDINGS = {
  ...REPOSITORY,
  fixAttempt: HANDOFF_BINDINGS.fixAttempt,
  ...leaseBindings('leaseCheckRun', 'lease.inlineJson.checkRunId'),
  ...handoffBindings('priorAttempt', 'data.attemptCount'),
  ...handoffBindings('priorCheckRun', 'data.checkRunId'),
};

/**
 * Written where a handoff read answered: only on the loop's own pull request,
 * not labelled hands-off, since the reads run only there. A handoff found is
 * rewritten; none found, one is posted.
 */
function handoffWhen(found: boolean) {
  return {
    anyOf: HANDOFF_READS.map((taskId) => `tasks.${taskId}.output.data.found == ${String(found)}`),
    onMissingRef: SKIP,
  };
}

/** Which comment is the handoff, then the handoff itself: by the pinned id, or from the newest page. */
export const HANDOFF_READ_TASKS = [
  {
    taskId: 'read-handoff-pin',
    name: 'Read which comment is the handoff',
    goal: 'Read the handoff pinned for this pull request — the comment’s id and the login it was posted as — so the handoff is read by its id wherever it sits in a long conversation, and trusted only from that author. A read that finds no pin is the first pass’s; a read that fails is not, since the pin may be there.',
    type: 'operation' as const,
    operation: 'memory.store.get',
    when: {
      allOf: [...OURS.allOf, 'tasks.read-pr.output.data.handsOff == false'],
      onMissingRef: SKIP,
    },
    // No pin succeeds as `found: false`, so a failure here is a pin that
    // could not be read, never its absence. It stays optional so the
    // rules decide it — as wait — rather than the run failing.
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
    taskId: 'read-pr-handoff-pinned',
    name: 'Read the pinned handoff',
    goal: 'Read the pinned handoff comment by its id, and take its record only where the pinned author wrote it, on this pull request.',
    type: 'operation' as const,
    operation: 'api.http.call',
    when: {
      expression: 'tasks.read-handoff-pin.output.dataJson.commentId != null',
      onMissingRef: SKIP,
    },
    // GitHub's answer stands with its status: a 404 — the comment deleted,
    // the pin stale — is the one answer the newest page is read after. Any
    // other, or a call that fails outright, leaves the record unread, and
    // the rules wait on it.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      ...PINNED_AUTHOR,
      commentId: out('read-handoff-pin', 'dataJson.commentId'),
    },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'getIssueComment',
      { owner: bind('owner'), repo: bind('repo'), comment_id: bind('commentId') },
      HANDOFF_PRESET,
    ),
    outputProjection: {
      statusCode: { path: 'statusCode', onMissing: 'error' as const },
      data: { path: 'data', onMissing: 'error' as const },
    },
  },

  {
    taskId: 'read-pr-handoff',
    name: 'Read the handoff',
    goal: 'Where no handoff is pinned, or the pinned comment is gone (404), read the newest page of the pull request’s conversation for the handoff the pinned author left on it. With no pin there is no author to trust, and no record is taken: the pass decides as on a pull request with none. A pinned comment that is gone is no first pass: the pin kept the failures acted on and the check run last acted on, and with no handoff on the page the read answers those, so deleting the comment restarts neither the budget nor the guard. Where the pin, or the pinned comment, could not be read it is not read either: past one page of conversation the newest holds no handoff rewritten in place, so no handoff is written over a record that may exist.',
    type: 'operation' as const,
    operation: 'api.http.call',
    // Either clause implies the loop's own pull request, not labelled
    // hands-off: the pin is read only there, and the pinned comment only
    // after it. An unread pin or pinned comment matches neither, leaving
    // both handoff reads empty — which keeps the handoff writes, and the
    // pin's rewrite, from running.
    when: {
      anyOf: [
        'tasks.read-handoff-pin.output.found == false',
        'tasks.read-pr-handoff-pinned.output.statusCode == 404',
      ],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      ...PINNED_AUTHOR,
      carriedAttempts: out('read-handoff-pin', 'dataJson.attemptCount'),
      carriedCheckRun: out('read-handoff-pin', 'dataJson.checkRunId'),
      page: out('read-pr', 'data.commentPages'),
    },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'listIssueComments',
      {
        owner: bind('owner'),
        repo: bind('repo'),
        issue_number: bind('number'),
        per_page: 100,
        page: bind('page'),
      },
      HANDOFF_PRESET_CARRIED,
    ),
  },
];

/** The handoff this pass leaves — posted, or rewritten — and the pin naming it for the next pass. */
export const HANDOFF_WRITE_TASKS = [
  {
    taskId: 'handoff',
    name: 'Write the handoff',
    goal: 'Post the handoff comment on the pull request — the record the next pass reads — where none is there yet.',
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: ['release'],
    when: handoffWhen(false),
    // A second attempt would post a second handoff.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: { ...HANDOFF_BINDINGS, ...NUMBER },
    context: ctx('api.http.call'),
    inputTemplate: github('createIssueComment', {
      owner: bind('owner'),
      repo: bind('repo'),
      issue_number: bind('number'),
      body: { body: HANDOFF_BODY },
    }),
  },

  {
    taskId: 'handoff-edit',
    name: 'Rewrite the handoff',
    goal: 'Rewrite the handoff comment on the pull request with this pass’s record, where the last pass left one.',
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: ['release'],
    when: handoffWhen(true),
    retryability: 'safe' as const,
    inputBindings: {
      ...HANDOFF_BINDINGS,
      ...handoffBindings('commentId', 'data.commentId'),
    },
    context: ctx('api.http.call'),
    inputTemplate: github('updateIssueComment', {
      owner: bind('owner'),
      repo: bind('repo'),
      comment_id: handoffValue('commentId'),
      body: { body: HANDOFF_BODY },
    }),
  },

  {
    taskId: 'remember-handoff',
    name: 'Pin the handoff',
    goal: 'Pin the handoff comment this pass wrote — posted, or found on the newest page and rewritten — for this pull request: its id, the login GitHub says it was written as, and the failures acted on and check run last acted on that it records. The next pass reads it by its id however long the conversation grows, and trusts its record from that author only; where the comment has been deleted, that attempt state still stands.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: {
      anyOf: [
        'tasks.handoff.output.statusCode == 201',
        'tasks.handoff-edit.output.statusCode == 200',
      ],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: {
      ...ATTEMPT_STATE_BINDINGS,
      ...NUMBER,
      ...writtenBindings('commentId', 'data.id'),
      ...writtenBindings('author', 'data.user.login'),
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: HANDOFF_PIN_PATH,
      writeMode: 'upsert',
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd’s handoff comment on this pull request.',
      content: {
        inlineJson: {
          commentId: writtenValue('commentId'),
          author: writtenValue('author'),
          // As the comment records them, as text: read back into the handoff preset.
          attemptCount: ATTEMPTS,
          checkRunId: CHECK_RUN,
        },
      },
    },
  },
];
