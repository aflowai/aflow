import {
  HOST_HARNESS_TIMEOUT_MAX_MS,
  PullRequestGapsSchema,
  SHEPHERD_ATTEMPT_BUDGET_DEFAULT,
  SHEPHERD_HANDOFF_CLOSE,
  SHEPHERD_HANDOFF_OPEN,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_DOCUMENT,
  SHEPHERD_LEASE_ROOT,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  SHEPHERD_RESPONSE_PRESETS,
  type SkillCatalogEntry,
  toJsonSchemaSync,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { REMEDY_QUESTION, REMEDY_QUESTION_NAME } from './localPrShepherdDecisions.js';

/**
 * Local PR Shepherd (Plan 321): one pass over the pull requests the loop
 * opened from a connected folder. It reads, decides by rules, and — for a red
 * check no rule holds back — commissions the fix on the branch and publishes
 * it through Local Publish. Every decision is read from data: the rules are
 * `workflow.run.decide`, and the one judgement no rule can make, which remedy
 * a log wants, is a routed decision whose abstention is the fix commission.
 */

function ctx(operation: string) {
  return {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: { operations: [operation], integrations: [] },
  };
}

function out(taskId: string, path?: string) {
  return { kind: 'task_output' as const, taskId, ...(path !== undefined ? { path } : {}) };
}

function runInput(path: string) {
  return { kind: 'run_input' as const, path };
}

function bind(name: string) {
  return { $bind: name };
}

/** A value as text, absent where it is absent or null — so a `$concat` part falls through to its default. */
function text(name: string) {
  return { $text: [bind(name)] };
}

const SKIP = 'skip' as const;

const BINDING_ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
const PULL_NUMBER_SCHEMA = {
  type: 'string',
  pattern: '^[1-9][0-9]{0,9}$',
  description: 'The number of one pull request, as digits.',
};
const ATTEMPT_BUDGET_SCHEMA = { type: 'integer', minimum: 1, maximum: 10 };

// --- Reads every task after the folder shares -------------------------------

const REPOSITORY = {
  owner: out('read-folder', 'origin.owner'),
  repo: out('read-folder', 'origin.repo'),
};

const NUMBER = { number: out('read-pr', 'data.number') };
const HEAD_REF = { headRef: out('read-pr', 'data.headRef') };
const BASE_REF = { baseRef: out('read-pr', 'data.baseRef') };

/** The loop's own pull request, as GitHub returned it: what every read after it reads under. */
const OURS = {
  allOf: ['tasks.read-pr.output.statusCode == 200', 'tasks.read-pr.output.data.ours == true'],
  onMissingRef: SKIP,
};

const DECIDED_FIX = { expression: "tasks.decide.output.decision == 'fix'", onMissingRef: SKIP };

/** `shepherd/<owner>/<repo>/<branch>/<document>` in the space's memory, beside the branch's lease. */
function branchDocument(document: string) {
  return {
    $concat: [
      `${SHEPHERD_LEASE_ROOT}/`,
      bind('owner'),
      '/',
      bind('repo'),
      '/',
      bind('headRef'),
      `/${document}`,
    ],
  };
}
const LEASE_PATH = branchDocument(SHEPHERD_LEASE_DOCUMENT);

/** `shepherd/<owner>/<repo>/pulls/<number>.json`: a pull request's pinned handoff, never a branch's. */
const HANDOFF_PIN_PATH = {
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
 * The handoff, from whichever read found it: the comment a pass pinned, read
 * by its id, or — where none is pinned, or it is gone — the newest page of
 * the conversation. At most one of the two holds a record.
 */
const HANDOFF_READS = ['read-pr-handoff-pinned', 'read-pr-handoff'] as const;

function handoffBindings(name: string, path?: string) {
  return Object.fromEntries(
    HANDOFF_READS.map((taskId) => [`${name}_${taskId.replace(/-/g, '_')}`, out(taskId, path)]),
  );
}

function handoffValue(name: string) {
  return {
    $firstOf: HANDOFF_READS.map((taskId) => bind(`${name}_${taskId.replace(/-/g, '_')}`)),
  };
}

/** The same, for a part of the handoff body: text, or absent. */
function handoffText(name: string) {
  return {
    $firstOf: HANDOFF_READS.map((taskId) => ({
      $text: [bind(`${name}_${taskId.replace(/-/g, '_')}`)],
    })),
  };
}

/** The lease, from whichever task took it: created where none was, or taken over from a stale one. */
const LEASE_TAKERS = ['lease', 'lease-takeover'] as const;

function leaseBindings(name: string, path: string) {
  return Object.fromEntries(
    LEASE_TAKERS.map((taskId) => [`${name}_${taskId.replace(/-/g, '_')}`, out(taskId, path)]),
  );
}

function leaseText(name: string) {
  return {
    $firstOf: LEASE_TAKERS.map((taskId) => ({
      $text: [bind(`${name}_${taskId.replace(/-/g, '_')}`)],
    })),
  };
}

function leaseValue(name: string) {
  return { $firstOf: LEASE_TAKERS.map((taskId) => bind(`${name}_${taskId.replace(/-/g, '_')}`)) };
}

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

const LEASE_HELD = {
  anyOf: LEASE_TAKERS.map((taskId) => `tasks.${taskId}.status == 'succeeded'`),
  onMissingRef: SKIP,
};

function github(endpointId: string, params: Record<string, unknown>, transformPresetId?: unknown) {
  return {
    apiId: 'github',
    endpointId,
    params,
    response: {
      format: 'json',
      ...(transformPresetId !== undefined ? { transformPresetId } : {}),
    },
  };
}

// --- The rules ---------------------------------------------------------------

/**
 * Read in order; the first that holds decides. A rule a missing read must not
 * pass is written `!= <expected>`, since a path through a read that did not
 * happen reads as null. Every way to `fix` runs through the last two: CI
 * failed on a check run the shepherd has not acted on, within the budget.
 */
export const SHEPHERD_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.folder.branchPolicy.branchPrefix == null' },
    decision: 'leave',
    reason:
      'The folder allows no pushes, so no pull request from it is the shepherd’s to fix. Reconnect it with a publish prefix.',
  },
  {
    when: { expression: 'state.folder.origin == null' },
    decision: 'leave',
    reason:
      "The folder's `origin` is not a repository on GitHub, so there is no pull request to read.",
  },
  {
    when: { expression: 'state.candidates.statusCode != 200' },
    decision: 'wait',
    reason:
      "GitHub did not list the repository's open pull requests, so nothing was read to act on. The GitHub connection's access to the repository is the thing to check.",
  },
  {
    when: { expression: 'state.candidates.data.count == 0' },
    decision: 'leave',
    reason:
      "No open pull request Local Publish opened under the folder's prefix — or none of the number this pass was aimed at.",
  },
  {
    when: { expression: 'state.pr.statusCode != 200' },
    decision: 'wait',
    reason: 'GitHub did not return the pull request, so nothing was read to act on.',
  },
  {
    when: {
      anyOf: ['state.pr.data.ours != true', "state.pr.data.state != 'open'"],
    },
    decision: 'leave',
    reason: "The pull request is not an open one Local Publish opened under the folder's prefix.",
  },
  {
    when: { expression: 'state.pr.data.handsOff == true' },
    decision: 'wait',
    reason: `The pull request is labelled \`${SHEPHERD_HANDS_OFF_LABEL}\`: a person is working on it, and the shepherd writes nothing on it until the label goes.`,
  },
  // A pin read that finds none answers `found: false`; only one that failed
  // leaves nothing. Deciding that as a first pass would drop the acted-on
  // guard and restart the attempt count over a record that may exist.
  {
    when: { expression: 'state.pin == null' },
    decision: 'wait',
    reason:
      "The pin naming this pull request's handoff could not be read from the space's memory, so its record may exist unread: what was acted on before, and how many attempts are spent, is unknown. Nothing is written until it reads.",
  },
  {
    when: {
      anyOf: ['state.checks.statusCode != 200', 'state.handoff.statusCode != 200'],
    },
    decision: 'wait',
    reason:
      "GitHub did not return the head's check runs or the pull request's comments, so what CI says, or what was done before, is unknown.",
  },
  // A lease is live while its run is: running or paused, and taken within the
  // stated bound. One whose run ended, or that is older, is stale, and this
  // pass takes it over (`lease-takeover`).
  ...(['running', 'paused'] as const).map((status) => ({
    when: {
      allOf: [
        'state.lease.dataJson.runId != null',
        `state.leaseOwner.run.status == '${status}'`,
        'state.lease.dataJson.takenAtMs >= state.staleBefore',
      ],
    },
    decision: 'wait',
    reason:
      'Another pass holds the lease on this branch, and its run is still going: its fix is still being made or published.',
  })),
  {
    when: { expression: 'state.publications.runs[0] != null' },
    decision: 'wait',
    reason:
      'A publication of this branch is in flight — running, or paused at its approval — whoever started it.',
  },
  {
    when: { expression: 'state.commissions.runs[0] != null' },
    decision: 'wait',
    reason: 'A commission based on this branch is in flight, whoever started it.',
  },
  {
    when: { expression: "state.checks.data.state == 'passing'" },
    decision: 'leave',
    reason: 'CI passes on the head. The merge is the operator’s.',
  },
  {
    when: { expression: "state.checks.data.state != 'failing'" },
    decision: 'wait',
    reason:
      'CI has not failed on the head: its checks are still running, stopped short, or not there yet.',
  },
  {
    when: { expression: 'state.checks.data.firstFailing.id == state.handoff.data.checkRunId' },
    decision: 'wait',
    reason:
      'This check run’s failure was acted on already, and CI has not run again since: the fix is still to be published or checked.',
  },
  {
    when: { expression: 'state.handoff.data.attemptCount >= state.budget' },
    decision: 'abandon',
    reason:
      'The shepherd has acted on as many failures of this pull request as its budget allows, and CI fails again. It leaves the pull request to a person.',
  },
];

export const SHEPHERD_OTHERWISE = {
  decision: 'fix',
  reason: 'CI failed on a check run the shepherd has not acted on: the failure is commissioned.',
};

// --- The remedies ----------------------------------------------------------

/** What every commission reports, which its publication is made from. */
const COMMISSION_RESULT_SCHEMA = {
  type: 'object',
  required: ['commitMessage', 'gaps'],
  additionalProperties: false,
  properties: {
    commitMessage: {
      type: 'string',
      minLength: 1,
      maxLength: 20_000,
      description:
        'The commit message: a subject line saying what this round changes, a blank line, then what it does and why.',
    },
    gaps: {
      ...toJsonSchemaSync(PullRequestGapsSchema),
      description:
        'What was left undone or could not be verified, one item each; empty where nothing was.',
    },
  },
};

const STANDING_RULES = `Rules every commission keeps:
- Work on the branch as it stands in this checkout; never push, commit outside the checkout, or touch another branch.
- Run the repository's own checks over what you touched — its tests on the touched files, its type check, its linter and formatter — and report what they said.
- Start no process that outlives the work: no dev server, watcher or daemon.
- Write nothing under \`.aflow/\`.
- Report, as your result, the commit message for this round and any gaps.`;

const FIX_BRIEF = `CI failed on this pull request's branch, and this checkout is that branch with its base merged in. Make CI pass.

The inputs name the pull request, the failing checks, the jobs that failed and the end of each failing job's log, and what earlier rounds on this pull request did. Read the logs first: the failure and its assertion are in them. Fix the cause in the change, not the test's expectation, unless the expectation is what the change was meant to alter. Where the merge of the base left conflicts, resolve them as part of the fix.

${STANDING_RULES}`;

const BUMP_BRIEF = `A dependency audit failed on this pull request's branch: an advisory against a package the repository resolves, which arrived since the branch was last green. This checkout is that branch with its base merged in. Clear the advisory.

The inputs name the failing jobs and the end of each one's log, where the advisory, the package and the fixed version are. Bump the package to the first version the advisory names as fixed: a direct dependency in its manifest, a transitive one through the root \`resolutions\` field. Install so the lockfile records it, and change nothing else.

${STANDING_RULES}`;

const MERGE_BRIEF = `This pull request's branch no longer merges cleanly into its base, and CI refused it or failed on it for that reason. This checkout is that branch with its base merged in, and git left what conflicted for you to resolve.

Resolve every conflict so both sides' intent stands, and nothing else: no fix to anything the merge did not touch. The inputs name the pull request and the failing checks.

${STANDING_RULES}`;

/** Everything a commission is briefed from: data, never prose about it (D5). */
const COMMISSION_BINDINGS = {
  bindingId: runInput('bindingId'),
  headRef: out('read-pr', 'data.headRef'),
  baseRef: out('read-pr', 'data.baseRef'),
  pullRequest: out('read-pr', 'data'),
  failingChecks: out('read-pr-checks', 'data.failing'),
  failingJobs: out('read-failure', 'data.jobs'),
  log1: out('read-failure-log-1', 'data'),
  log2: out('read-failure-log-2', 'data'),
  log3: out('read-failure-log-3', 'data'),
  ...handoffBindings('earlierRounds', 'data'),
};

function commission(taskId: string, name: string, goal: string, brief: string) {
  return {
    taskId,
    name,
    goal,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [...LEASE_TAKERS],
    // A failed commission ends nothing but itself: the lease is still
    // released and the handoff still written.
    optional: true,
    // A retry would start a second coding agent over the same brief.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: COMMISSION_BINDINGS,
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      task: brief,
      inputs: {
        pullRequest: bind('pullRequest'),
        failingChecks: bind('failingChecks'),
        failingJobs: bind('failingJobs'),
        logs: [bind('log1'), bind('log2'), bind('log3')],
        earlierRounds: handoffValue('earlierRounds'),
      },
      base: bind('headRef'),
      mergeFrom: { $concat: ['origin/', bind('baseRef')] },
      outputSchema: COMMISSION_RESULT_SCHEMA,
      timeoutMs: HOST_HARNESS_TIMEOUT_MAX_MS,
    },
  };
}

const COMMISSIONS = ['fix', 'bump-dependency', 'merge-round'] as const;

function commissionBinding(taskId: string, path: string): string {
  return `${taskId}_${path}`.replace(/[^A-Za-z0-9]/g, '_');
}

/** Each commission's value at `path`; at most one is present, since one route enables each. */
function fromCommission(path: string) {
  return Object.fromEntries(
    COMMISSIONS.map((taskId) => [commissionBinding(taskId, path), out(taskId, path)]),
  );
}

function firstOfCommissions(path: string) {
  return { $firstOf: COMMISSIONS.map((taskId) => bind(commissionBinding(taskId, path))) };
}

const REMEDY = `answers.${REMEDY_QUESTION_NAME}`;

function confident(option: string) {
  return {
    allOf: [`output.${REMEDY}.value == '${option}'`, `output.${REMEDY}.decided == true`],
  };
}

/**
 * Which remedy the routes took, as a label the record keeps — the routes of
 * `classify-failure`, read as rules over its answer: a confident answer takes
 * its remedy, and anything else the fix commission. Recorded so the next
 * round is briefed with what this one did; a test holds the two to the same
 * answers.
 */
export const REMEDY_TAKEN_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.answer == null' },
    decision: 'none',
    reason: 'The remedy question could not be asked, so no remedy ran.',
  },
  ...(
    [
      ['flaky_or_timeout', 'rerun_failed_jobs', 'The failed jobs were run again.'],
      ['dependency_advisory', 'dependency_bump', 'The flagged dependency was bumped.'],
      ['base_conflict', 'merge_round', 'The base was merged into the branch.'],
      ['ci_outage', 'wait_on_ci', 'CI itself was down; nothing in the repository was changed.'],
    ] as const
  ).map(([option, decision, reason]) => ({
    when: { allOf: ['state.answer.decided == true', `state.answer.value == '${option}'`] },
    decision,
    reason,
  })),
];

export const REMEDY_TAKEN_OTHERWISE = {
  decision: 'fix_commission',
  reason: 'The failure was commissioned as a fix.',
};

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

const ATTEMPTS = firstText([leaseText('leaseAttempt'), handoffText('priorAttempt')], '0');
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
    `\n${SHEPHERD_HANDOFF_CLOSE}\n`,
    '**Local PR Shepherd** — this pass: `',
    bind('decision'),
    '`. ',
    bind('reason'),
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
    `\`.\n\n_The shepherd never approves, merges or closes a pull request. Label it \`${SHEPHERD_HANDS_OFF_LABEL}\` to have it left alone._`,
  ],
};

const HANDOFF_BINDINGS = {
  ...REPOSITORY,
  decision: out('decide', 'decision'),
  reason: out('decide', 'reason'),
  ...leaseBindings('leaseAttempt', 'lease.inlineJson.attempt'),
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

/** Every task that can still be running while the lease is held: the release waits for all of them. */
const LEASED_WORK = [
  ...LEASE_TAKERS,
  'read-failure',
  'read-failure-log-1',
  'read-failure-log-2',
  'read-failure-log-3',
  'classify-failure',
  'rerun-jobs',
  ...COMMISSIONS,
  'publish',
];

/**
 * The lease, taken before anything is commissioned: the run that holds it,
 * when it was taken, and the check run and head it acts on. Where there is
 * none it is created, never overwritten, so the second of two passes fails
 * here with nothing done. Where there is one, the rules found it stale — its
 * run ended, or it is past `SHEPHERD_LEASE_STALE_AFTER_MS` — and it is taken
 * over by overwriting exactly the lease that was read: a pass that took it
 * over first changed it, so a second takeover fails the same way.
 */
function leaseTask(taskId: (typeof LEASE_TAKERS)[number]) {
  const takeover = taskId === 'lease-takeover';
  return {
    taskId,
    name: takeover ? 'Take over the stale lease' : 'Take the lease on the branch',
    goal: takeover
      ? "Overwrite the branch's stale lease — its run has ended, or it is older than the bound — with this pass's own, before anything is commissioned, and only as it was read."
      : "Write the branch's lease in the space's memory before anything is commissioned, holding the run, the time, and the check run and head this pass acts on.",
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: {
      allOf: [
        DECIDED_FIX.expression,
        `tasks.read-in-flight-lease.status ${takeover ? '==' : '!='} 'succeeded'`,
      ],
      onMissingRef: SKIP,
    },
    // Not optional: a lease another pass took first ends this one, and only
    // the pass that holds a lease releases it.
    retryability: 'safe' as const,
    maxAttempts: 1,
    failureInstruction:
      'The lease on this branch could not be taken — most often because another pass took it first, which is the lease doing its job. Nothing was commissioned or published by this pass.',
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      ...HEAD_REF,
      headSha: out('read-pr', 'data.headSha'),
      checkRunId: out('read-pr-checks', 'data.firstFailing.id'),
      ...handoffBindings('attempt', 'data.nextAttemptCount'),
      runId: { kind: 'run_id' as const },
      takenAtMs: { kind: 'clock' as const },
      ...(takeover ? { staleHash: out('read-in-flight-lease', 'stat.contentHash') } : {}),
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: LEASE_PATH,
      writeMode: takeover ? 'overwrite' : 'create',
      ...(takeover ? { expectedHash: bind('staleHash') } : {}),
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd is acting on this branch.',
      content: {
        inlineJson: {
          runId: bind('runId'),
          takenAtMs: bind('takenAtMs'),
          pullNumber: bind('number'),
          headSha: bind('headSha'),
          checkRunId: bind('checkRunId'),
          attempt: handoffValue('attempt'),
        },
      },
    },
    outputProjection: {
      path: { path: 'path', onMissing: 'error' as const },
      lease: { fromInput: 'content' },
      // What the lease holds as this pass wrote it: `release` deletes only that.
      contentHash: { path: 'contentHash', onMissing: 'error' as const },
    },
  };
}

function failureLog(slot: 1 | 2 | 3) {
  return {
    taskId: `read-failure-log-${String(slot)}`,
    name: `Read the end of failing job ${String(slot)}'s log`,
    goal: `Read the end of the log of the ${['first', 'second', 'third'][slot - 1]!} failing job — its last 300 lines, fewer where those pass 60 KB — where the failure and its assertion are.`,
    type: 'operation' as const,
    operation: 'api.http.call',
    when: {
      allOf: [
        DECIDED_FIX.expression,
        `tasks.read-failure.output.data.jobs[${String(slot - 1)}].id != null`,
      ],
      onMissingRef: SKIP,
    },
    // A log that cannot be read leaves the brief without it, not the pass.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: {
      ...REPOSITORY,
      jobId: out('read-failure', `data.jobs[${String(slot - 1)}].id`),
    },
    context: ctx('api.http.call'),
    inputTemplate: github('getJobLogs', {
      owner: bind('owner'),
      repo: bind('repo'),
      job_id: bind('jobId'),
    }),
  };
}

interface ShepherdTask {
  taskId: string;
  dependsOn?: string[];
  when?: { expression?: string; anyOf?: string[]; allOf?: string[] };
  inputBindings?: Record<string, { kind: string; taskId?: string }>;
}

const WHEN_TASK_REF = /tasks\.([a-zA-Z0-9_-]+)\./g;

/**
 * Each task depends on every task whose output it binds or its `when` reads,
 * as well as on those it names. A guard over a task that has not run yet
 * reads a missing value and skips, so the order is part of the rule. Written
 * once here rather than beside every binding and guard, so one added later
 * cannot read a task the graph does not order before it.
 */
function withBindingDependencies<T extends ShepherdTask>(tasks: T[]): T[] {
  return tasks.map((task) => {
    const bound = Object.values(task.inputBindings ?? {}).flatMap((binding) =>
      binding.kind === 'task_output' && binding.taskId !== undefined ? [binding.taskId] : [],
    );
    const guarded = [
      ...(task.when?.expression !== undefined ? [task.when.expression] : []),
      ...(task.when?.anyOf ?? []),
      ...(task.when?.allOf ?? []),
    ].flatMap((expression) => [...expression.matchAll(WHEN_TASK_REF)].map((match) => match[1]!));
    const dependsOn = [
      ...new Set(
        [...(task.dependsOn ?? []), ...bound, ...guarded].filter((id) => id !== task.taskId),
      ),
    ];
    return dependsOn.length > 0 ? { ...task, dependsOn } : task;
  });
}

const LOCAL_PR_SHEPHERD: SkillCatalogEntry = {
  catalogId: 'local-pr-shepherd',
  version: 1,
  name: 'Local PR Shepherd',
  tagline:
    'Tend the pull requests the loop opened: read their CI, and fix and publish a red check through Local Publish — never approving, merging or closing.',
  description: `One pass over the pull requests Local Publish opened from a connected folder. It reads the folder, the loop's open pull requests under its publish prefix, the head's check runs, its own handoff comment and the space's work in flight on the branch, and decides by rules — \`fix\`, \`wait\`, \`abandon\` or \`leave\`, with the reason. A red check no rule holds back is fixed: the remedy question reads the failing jobs' logs and picks re-running the jobs, a fix commission, a dependency bump or a merge round, and anything it is not sure of is the fix commission. The fix is commissioned on the branch with its base merged in and published through Local Publish, which asks the operator exactly where it would when started by hand. Every pass leaves its record in the handoff comment.

**What it needs**: the connected folder, \`bindingId\`, connected with a publish prefix and an \`origin\` on GitHub, and the GitHub connection for the space. \`pullNumber\` aims a pass at one pull request, which must still be one the loop opened; without it a pass tends the most recently updated. \`attemptBudget\` is how many failures of one pull request it acts on before it stops — ${String(SHEPHERD_ATTEMPT_BUDGET_DEFAULT)} unless named.

**What it never does**: approve, merge or close a pull request, or push other than through Local Publish under the folder's push approval. A pull request a person opened, or one labelled \`${SHEPHERD_HANDS_OFF_LABEL}\`, is left untouched; a branch with a publication or a commission in flight, whoever started it, is \`wait\`; the same check run is acted on once.

**With the result**: report the decision and its reason, and for a fix the publication's run — its pull request, and whether it pushed or is waiting at its approval.`,
  tags: ['coding', 'github', 'pull-requests', 'ci', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        "GitHub REST API — list and read the loop's pull requests, their check runs and comments, a failing run's jobs and the end of a job's log, re-run failed jobs, and write the handoff comment.",
      requiredEndpoints: [
        'listPullRequests',
        'getPullRequest',
        'listCheckRuns',
        'listIssueComments',
        'getIssueComment',
        'listWorkflowRunJobs',
        'getJobLogs',
        'reRunFailedJobs',
        'createIssueComment',
        'updateIssueComment',
      ],
      authKind: 'bearer',
      setupNote:
        "Bind the GitHub connector for the space with a token that reads pull requests, checks and Actions and writes comments. A job's log is served from a signed URL on Azure blob storage: the binding allows redirects to `*.blob.core.windows.net` and `*.actions.githubusercontent.com`, and the token is not sent there.",
    },
  ],
  bundle: {
    workflow: {
      slug: 'local-pr-shepherd',
      name: 'Local PR Shepherd',
      description:
        "One pass over the loop's open pull requests from a connected folder: read the folder, the pull request, its checks, its handoff and the work in flight on its branch; decide by rules; for a red check, take the lease, read the failing jobs' logs, ask which remedy they want, re-run the jobs or commission the fix on the branch and publish it through Local Publish; release the lease and write the handoff.",
      goal: "Keep the loop's pull requests moving through CI without a hand: a red check is fixed and pushed through Local Publish under the folder's posture, acted on once, within a budget, and never where a person or other work holds the branch — with every pass recorded on the pull request.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'pass-recorded',
          name: 'Pass decided and recorded',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The pass decided from what it read — fix, wait, abandon or leave, with the reason — and acted only on fix: the remedy went through Local Publish without approving, merging or closing anything, the lease was released, and the handoff comment holds the record.',
          },
        },
      ],
      runInputs: [
        {
          id: 'bindingId',
          required: true,
          description:
            'The connected folder whose pull requests are tended: connected with a publish prefix, its `origin` on GitHub.',
          schema: BINDING_ID_SCHEMA,
        },
        {
          id: 'pullNumber',
          required: false,
          description:
            "Aims the pass at one pull request, by its number as digits. It is tended only where Local Publish opened it under the folder's prefix; absent, the pass tends the most recently updated such pull request.",
          schema: PULL_NUMBER_SCHEMA,
        },
        {
          id: 'attemptBudget',
          required: false,
          description: `How many failures of one pull request the shepherd acts on before it leaves the pull request to a person. Absent, ${String(SHEPHERD_ATTEMPT_BUDGET_DEFAULT)}.`,
          schema: ATTEMPT_BUDGET_SCHEMA,
        },
      ],
      tasks: withBindingDependencies([
        {
          taskId: 'read-folder',
          name: "Read the folder's prefix, posture and origin",
          goal: 'Read, from the machine holding the folder, the branch prefix its pushes are held to, its push approval, and the GitHub repository its `origin` fetches from.',
          type: 'operation' as const,
          operation: 'host.binding.inspect',
          retryability: 'safe' as const,
          inputBindings: { bindingId: runInput('bindingId') },
          // The entry task's contract is the skill's input surface: a run
          // input missing from it is refused at start.
          inputContract: {
            bindings: {
              bindingId: {
                kind: 'run_input' as const,
                bindAs: 'bindingId',
                path: 'bindingId',
                schema: BINDING_ID_SCHEMA,
              },
              pullNumber: {
                kind: 'run_input' as const,
                bindAs: 'pullNumber',
                path: 'pullNumber',
                schema: PULL_NUMBER_SCHEMA,
              },
              attemptBudget: {
                kind: 'run_input' as const,
                bindAs: 'attemptBudget',
                path: 'attemptBudget',
                schema: ATTEMPT_BUDGET_SCHEMA,
              },
            },
          },
          context: ctx('host.binding.inspect'),
          inputTemplate: { bindingId: bind('bindingId') },
        },

        {
          taskId: 'list-prs',
          name: "List the loop's open pull requests",
          goal: "List the repository's open pull requests and keep those Local Publish opened under the folder's prefix — its marker closes their body — the ones labelled hands-off last, then the most recently updated.",
          type: 'operation' as const,
          operation: 'api.http.call',
          when: {
            allOf: [
              'tasks.read-folder.output.origin.owner != null',
              'tasks.read-folder.output.branchPolicy.branchPrefix != null',
            ],
            onMissingRef: SKIP,
          },
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            prefix: out('read-folder', 'branchPolicy.branchPrefix'),
            pullNumber: runInput('pullNumber'),
          },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'listPullRequests',
            {
              owner: bind('owner'),
              repo: bind('repo'),
              state: 'open',
              sort: 'updated',
              direction: 'desc',
              per_page: 100,
            },
            {
              $firstOf: [
                {
                  $concat: [
                    `${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`,
                    bind('prefix'),
                    ':',
                    bind('pullNumber'),
                  ],
                },
                { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`, bind('prefix')] },
              ],
            },
          ),
        },

        {
          taskId: 'read-pr',
          name: 'Read the pull request',
          goal: "Read the first of them as it stands now: its head, its base, its labels, whether it still carries the loop's marker on a branch under the prefix, and whether it merges into its base.",
          type: 'operation' as const,
          operation: 'api.http.call',
          when: { expression: 'tasks.list-prs.output.data.count > 0', onMissingRef: SKIP },
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            prefix: out('read-folder', 'branchPolicy.branchPrefix'),
            number: out('list-prs', 'data.pullRequests[0].number'),
          },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'getPullRequest',
            { owner: bind('owner'), repo: bind('repo'), pull_number: bind('number') },
            { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequest}:`, bind('prefix')] },
          ),
        },

        {
          taskId: 'read-pr-checks',
          name: "Read the head's check runs",
          goal: "Read the check runs on the pull request's head: whether CI fails, runs, passes or stopped, and the failing check run a pass acts on.",
          type: 'operation' as const,
          operation: 'api.http.call',
          when: OURS,
          retryability: 'safe' as const,
          inputBindings: { ...REPOSITORY, sha: out('read-pr', 'data.headSha') },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'listCheckRuns',
            { owner: bind('owner'), repo: bind('repo'), ref: bind('sha'), per_page: 100 },
            SHEPHERD_RESPONSE_PRESETS.checkRuns,
          ),
        },

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
          // A comment since deleted answers 404, which shapes no record: the
          // task fails, and the newest page is read instead.
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
            found: { path: 'data.found', onMissing: 'error' as const },
          },
        },

        {
          taskId: 'read-pr-handoff',
          name: 'Read the handoff',
          goal: 'Where no pinned handoff was read, read the newest page of the pull request’s conversation for the handoff the pinned author left on it. With no pin there is no author to trust, and no record is taken: the pass decides as on a pull request with none. Where the pin could not be read it is not read either, so no handoff is written over a record that may exist.',
          type: 'operation' as const,
          operation: 'api.http.call',
          when: {
            allOf: [
              ...OURS.allOf,
              'tasks.read-pr.output.data.handsOff == false',
              // An unread pin leaves both handoff reads empty, which is what
              // keeps the handoff writes, and the pin's rewrite, from running.
              "tasks.read-handoff-pin.status == 'succeeded'",
              "tasks.read-pr-handoff-pinned.status != 'succeeded'",
            ],
            onMissingRef: SKIP,
          },
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            ...NUMBER,
            ...PINNED_AUTHOR,
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
            HANDOFF_PRESET,
          ),
        },

        {
          taskId: 'read-in-flight-lease',
          name: "Read the branch's lease",
          goal: "Read the lease on the pull request's branch in the space's memory, where there is one — the run that took it and when — taken for the length of a fix and released at its end.",
          type: 'operation' as const,
          operation: 'memory.store.get',
          when: OURS,
          // No lease is the usual case. The read only advises: the lease is
          // taken by a write that fails where another holds it.
          optional: true,
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: { ...REPOSITORY, ...HEAD_REF },
          context: ctx('memory.store.get'),
          inputTemplate: { target: { path: LEASE_PATH }, view: 'content' },
        },

        {
          taskId: 'read-lease-owner',
          name: "Read the lease's run",
          goal: 'Read the run that holds the lease: a lease whose run has ended, or that cannot be read, is stale.',
          type: 'operation' as const,
          operation: 'workflow.run.detail',
          when: {
            expression: 'tasks.read-in-flight-lease.output.dataJson.runId != null',
            onMissingRef: SKIP,
          },
          optional: true,
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: { runId: out('read-in-flight-lease', 'dataJson.runId') },
          context: ctx('workflow.run.detail'),
          inputTemplate: { runId: bind('runId'), compact: true },
        },

        {
          taskId: 'read-in-flight-publications',
          name: 'Read the publications of the branch in flight',
          goal: "List the space's publications of the pull request's branch still in flight — running, or paused at their approval — whoever started them.",
          type: 'operation' as const,
          operation: 'workflow.run.list',
          when: OURS,
          retryability: 'safe' as const,
          inputBindings: { headRef: out('read-pr', 'data.headRef') },
          context: ctx('workflow.run.list'),
          inputTemplate: {
            slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
            input: { field: 'branch', equals: bind('headRef') },
          },
        },

        {
          taskId: 'read-in-flight-commissions',
          name: 'Read the commissions on the branch in flight',
          goal: "List the space's commissions based on the pull request's branch still in flight, whoever started them.",
          type: 'operation' as const,
          operation: 'workflow.run.list',
          when: OURS,
          retryability: 'safe' as const,
          inputBindings: { headRef: out('read-pr', 'data.headRef') },
          context: ctx('workflow.run.list'),
          inputTemplate: {
            slug: COMMISSION_CHANGE.bundle.workflow.slug,
            input: { field: 'base', equals: bind('headRef') },
          },
        },

        {
          taskId: 'decide',
          name: 'Decide by rules',
          goal: 'Decide this pass — fix, wait, abandon or leave, with the reason — by rules over what the reads returned, with no model: the first rule that holds decides, and fix where none does.',
          type: 'operation' as const,
          operation: 'workflow.run.decide',
          retryability: 'safe' as const,
          inputBindings: {
            folder: out('read-folder'),
            candidates: out('list-prs'),
            pr: out('read-pr'),
            checks: out('read-pr-checks'),
            pin: out('read-handoff-pin'),
            ...handoffBindings('handoff'),
            lease: out('read-in-flight-lease'),
            leaseOwner: out('read-lease-owner'),
            staleBefore: { kind: 'clock' as const, offsetMs: -SHEPHERD_LEASE_STALE_AFTER_MS },
            publications: out('read-in-flight-publications'),
            commissions: out('read-in-flight-commissions'),
            budget: runInput('attemptBudget'),
          },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: {
              folder: bind('folder'),
              candidates: bind('candidates'),
              pr: bind('pr'),
              checks: bind('checks'),
              pin: bind('pin'),
              handoff: handoffValue('handoff'),
              lease: bind('lease'),
              leaseOwner: bind('leaseOwner'),
              staleBefore: bind('staleBefore'),
              publications: bind('publications'),
              commissions: bind('commissions'),
              budget: { $firstOf: [bind('budget'), SHEPHERD_ATTEMPT_BUDGET_DEFAULT] },
            },
            rules: SHEPHERD_RULES,
            otherwise: SHEPHERD_OTHERWISE,
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'decision', toState: 'decision' },
            { kind: 'output_path' as const, path: 'reason', toState: 'reason' },
          ],
        },

        leaseTask('lease'),
        leaseTask('lease-takeover'),

        {
          taskId: 'read-failure',
          name: "Read the failing run's jobs",
          goal: 'List the jobs of the Actions run the failing check belongs to, and keep those that failed, each with the steps that failed.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: [...LEASE_TAKERS],
          when: {
            allOf: [
              DECIDED_FIX.expression,
              'tasks.read-pr-checks.output.data.firstFailing.runId != null',
            ],
            onMissingRef: SKIP,
          },
          // A failure outside Actions has no jobs to read; the brief goes
          // with the failing checks alone.
          optional: true,
          retryability: 'safe' as const,
          inputBindings: { ...REPOSITORY, runId: out('read-pr-checks', 'data.firstFailing.runId') },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'listWorkflowRunJobs',
            { owner: bind('owner'), repo: bind('repo'), run_id: bind('runId'), per_page: 100 },
            SHEPHERD_RESPONSE_PRESETS.failingJobs,
          ),
        },

        failureLog(1),
        failureLog(2),
        failureLog(3),

        {
          taskId: 'classify-failure',
          name: 'Ask which remedy the failure wants',
          goal: "Ask the space's decision model which remedy the red check wants, from the failing jobs' names and the end of their logs, the pull request's title and description, and the record of earlier attempts. A confident answer takes its remedy; any other takes the fix commission.",
          type: 'operation' as const,
          operation: 'ai.decision.decide',
          dependsOn: [...LEASE_TAKERS],
          when: DECIDED_FIX,
          // A decision that could not be made leaves the remedies skipped and
          // the pass recorded; the lease is still released.
          optional: true,
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            title: out('read-pr', 'data.title'),
            body: out('read-pr', 'data.body'),
            mergeableState: out('read-pr', 'data.mergeableState'),
            failingChecks: out('read-pr-checks', 'data.failing'),
            failingJobs: out('read-failure', 'data.jobs'),
            log1: out('read-failure-log-1', 'data'),
            log2: out('read-failure-log-2', 'data'),
            log3: out('read-failure-log-3', 'data'),
            ...handoffBindings('earlierRounds', 'data'),
          },
          context: ctx('ai.decision.decide'),
          // No model is named: the space's decision model answers.
          inputTemplate: {
            state: {
              pullRequest: {
                title: bind('title'),
                body: bind('body'),
                mergeableState: bind('mergeableState'),
              },
              failingChecks: bind('failingChecks'),
              failingJobs: bind('failingJobs'),
              logs: [bind('log1'), bind('log2'), bind('log3')],
              earlierRounds: handoffValue('earlierRounds'),
            },
            questions: { [REMEDY_QUESTION_NAME]: REMEDY_QUESTION },
          },
          // The decider routes; it gates nothing that leaves the machine. The
          // push is Local Publish's to clear, under the folder's posture (316 D9).
          routes: [
            { when: confident('flaky_or_timeout'), enable: ['rerun-jobs'] },
            {
              when: {
                anyOf: [
                  `output.${REMEDY}.value == 'code_defect'`,
                  `output.${REMEDY}.decided == false`,
                ],
              },
              enable: ['fix'],
            },
            { when: confident('dependency_advisory'), enable: ['bump-dependency'] },
            { when: confident('base_conflict'), enable: ['merge-round'] },
          ],
        },

        {
          taskId: 'record-remedy',
          name: 'Record which remedy was taken',
          goal: 'Name the remedy the routes took from the remedy question’s answer — re-run, fix, bump, merge round, or a wait on CI — for the handoff to record, so the next round is briefed with it.',
          type: 'operation' as const,
          operation: 'workflow.run.decide',
          when: DECIDED_FIX,
          dependsOn: ['classify-failure'],
          retryability: 'safe' as const,
          inputBindings: { answer: out('classify-failure', REMEDY) },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: { answer: bind('answer') },
            rules: REMEDY_TAKEN_RULES,
            otherwise: REMEDY_TAKEN_OTHERWISE,
          },
        },

        {
          taskId: 'rerun-jobs',
          name: 'Re-run the failed jobs',
          goal: 'Re-run the failed jobs of the Actions run the failing check belongs to, as a new attempt on the same commit, for a failure that was the machine and not the change.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: [...LEASE_TAKERS],
          optional: true,
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: { ...REPOSITORY, runId: out('read-pr-checks', 'data.firstFailing.runId') },
          context: ctx('api.http.call'),
          inputTemplate: github('reRunFailedJobs', {
            owner: bind('owner'),
            repo: bind('repo'),
            run_id: bind('runId'),
          }),
        },

        commission(
          'fix',
          'Commission the fix',
          "Have the machine's coding agent fix what CI failed on, on the pull request's branch with its base merged in, briefed from the pull request, the failing checks, the end of each failing job's log and the earlier rounds.",
          FIX_BRIEF,
        ),
        commission(
          'bump-dependency',
          'Commission the dependency bump',
          "Have the machine's coding agent bump the package a dependency audit flagged to its fixed version — through `resolutions` where it is transitive — on the pull request's branch with its base merged in.",
          BUMP_BRIEF,
        ),
        commission(
          'merge-round',
          'Commission the merge round',
          "Have the machine's coding agent resolve what merging the base into the pull request's branch left conflicting, and nothing else.",
          MERGE_BRIEF,
        ),

        {
          taskId: 'publish',
          name: 'Publish the fix through Local Publish',
          goal: "Publish the commission's change onto the pull request's branch through Local Publish and wait for it to end: its checks, its scan, its review and its approval as the folder's posture has them — it asks the operator exactly where it would when started by hand.",
          type: 'operation' as const,
          operation: 'workflow.run.start',
          when: {
            anyOf: COMMISSIONS.flatMap((taskId) => [
              `tasks.${taskId}.output.patchRef != null`,
              `tasks.${taskId}.output.merge.from != null`,
            ]),
            onMissingRef: SKIP,
          },
          optional: true,
          // A second attempt starts a second publication.
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: {
            ...REPOSITORY,
            ...HEAD_REF,
            ...BASE_REF,
            bindingId: runInput('bindingId'),
            ...fromCommission('patchRef'),
            ...fromCommission('baseSha'),
            ...fromCommission('merge.from'),
            ...fromCommission('result.commitMessage'),
            ...fromCommission('result.gaps'),
          },
          context: ctx('workflow.run.start'),
          inputTemplate: {
            slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
            catalogId: PUBLISH_LOCAL_CHANGES.catalogId,
            inputs: {
              bindingId: bind('bindingId'),
              patchRef: firstOfCommissions('patchRef'),
              branch: bind('headRef'),
              baseSha: firstOfCommissions('baseSha'),
              mergeFrom: firstOfCommissions('merge.from'),
              commitMessage: firstOfCommissions('result.commitMessage'),
              gaps: firstOfCommissions('result.gaps'),
              owner: bind('owner'),
              repo: bind('repo'),
              base: bind('baseRef'),
            },
            wait: 'until_complete',
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'runId', toState: 'publicationRunId' },
          ],
        },

        {
          taskId: 'release',
          name: 'Release the lease',
          goal: "Delete the branch's lease once everything this pass started has ended, whichever way it ended — only while it is still this pass's own, as it wrote it. A lease another run has since taken over is that run's, and is left.",
          type: 'operation' as const,
          operation: 'memory.store.delete',
          dependsOn: LEASED_WORK,
          when: LEASE_HELD,
          // A lease taken over refuses the delete; the pass still records.
          optional: true,
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: {
            ...leaseBindings('leasePath', 'path'),
            ...leaseBindings('leaseHash', 'contentHash'),
          },
          context: ctx('memory.store.delete'),
          inputTemplate: {
            target: { path: leaseValue('leasePath') },
            // The content this pass wrote — its run and the time it took it.
            expectedHash: leaseValue('leaseHash'),
          },
        },

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
          goal: 'Pin the handoff comment this pass wrote — posted, or found on the newest page and rewritten — for this pull request: its id, and the login GitHub says it was written as. The next pass reads it by its id however long the conversation grows, and trusts its record from that author only.',
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
            ...REPOSITORY,
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
              inlineJson: { commentId: writtenValue('commentId'), author: writtenValue('author') },
            },
          },
        },
      ]),
      stateVariables: [
        {
          variableId: 'decision',
          name: 'Decision',
          description: 'What this pass decided: fix, wait, abandon or leave.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'reason',
          name: 'Reason',
          description: 'Why, as the rule that decided says it.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'publicationRunId',
          name: 'Publication',
          description: 'The Local Publish run that published the fix, where this pass made one.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'decision',
        guidance:
          'Report the decision and its reason. Where publicationRunId is set, the fix went through Local Publish: report its pull request and whether it pushed or waits at its approval, which is the operator’s.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'local-pr-shepherd',
      name: 'Local PR Shepherd',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'pass-recorded',
            description:
              "A pass over the loop's pull requests decides from what it read, acts only on fix — through Local Publish, under the folder's posture, never approving, merging or closing — and leaves its record in the handoff comment.",
          },
        ],
      },
      mode: 'process' as const,
      // Passes overlap by design — a pass may wait hours at its publication's
      // approval — and the lease, not the run count, keeps two off one branch.
      concurrency: {
        maxParallelTasksPerRun: 3,
        maxConcurrentRuns: 'unlimited' as const,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: [
        'shepherd the pull requests',
        'fix the red ci on the loop’s pull requests',
        'tend the pull requests local publish opened',
        'run the pr shepherd',
      ],
      activationHint:
        "Run one pass of the Local PR Shepherd over a connected folder's pull requests: it reads CI, decides by rules, and fixes a red check through Local Publish. Start it with the folder's bindingId — and pullNumber to aim it at one pull request.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 321 P1. Typed reads — folder, pull requests, checks, handoff, lease, the branch’s publications and commissions — then workflow.run.decide: the first rule that holds is the decision and its reason, fix where none does; a read GitHub refused is wait. For fix: the lease is created, never overwritten, so a second pass stops there; the failing jobs and up to three log excerpts are read; the remedy question routes a confident answer to re-run, fix, bump or merge round and anything else to the fix commission. Commissions run on the branch with origin/<base> merged in, briefed from data; the publication is Local Publish, waited on through its approval. The lease is released once all leased work ends; the handoff is written from the lease and the earlier record. No step approves, merges or closes.',
  },
};

export { LOCAL_PR_SHEPHERD };
