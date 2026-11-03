import type { SkillCatalogEntry, WorkflowRunDecideRule } from '@aflow/schemas';
import { COMMISSION_BRIEF_MAX_LENGTH, COMMISSION_CHANGE } from './commissionChange.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import { entryContract } from './localBrowserRule.js';
import { aboveMinorRules, minorRules } from './publishLocalChangesAfterReview.js';
import { COMMISSION_RUN_ID_SCHEMA } from './publishLocalChangesMessage.js';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';

/**
 * Review Rounds (Plan 341 P2): the loop's review, fix rounds and rounds-rule
 * decision on a folder's patch alone — nothing pushed, no pull request, no
 * remote read. The measurement space runs without a publication (Plan 341
 * D5), so the rounds cannot live inside Publish Local Changes. This skill is
 * what the measurement's driver starts in its place, with the commission the
 * loop made.
 *
 * The shape, and what it reuses:
 *
 * - A commission goes in by its run id. Its `patchRef`, `baseSha` and
 *   `summary` are read from that run, as the publication reads the summary.
 * - Each round commits its patch on a local branch with `host.file.patch`.
 *   The commit names no `pushBase`, so nothing fetches from or measures
 *   against a remote. The review then reads `baseSha..<head>`.
 * - The review is Review Local Changes, started as its own run, exactly as
 *   the publication starts it. Its findings are the findings ledger: each
 *   round's decision records the verdict, the findings and the head they are
 *   for, and the run appends every record to `rounds`.
 * - The decision is `workflow.run.decide` over the publication's own rule
 *   builders (`aboveMinorRules`, `minorRules`) and its decision names
 *   (`fix_before_merge`, `publish_as_is`), ordered to the operator's rule. No
 *   model is asked.
 * - A fix round is Commission Change on the branch, briefed from the brief
 *   and the review's summary, as the conversation briefs one after a
 *   publication.
 *
 * Rejected:
 *
 * - A driver-side loop in the benchmark runner. Its decisions would live in
 *   a script's memory or a file. The board and the Coach read none of it, and
 *   D6 asks for platform records.
 * - Splitting the rounds out of Publish Local Changes. That changes the
 *   loop's own skill, which Plan 341 D7 leaves alone, to serve a measurement.
 * - An agent deciding the rounds. The publication's rounds rule is decided by
 *   rules because no measured model cleared the bar (Plan 316 §7). A second
 *   judge would make the arms differ by more than the process.
 *
 * The workflow graph cannot loop, so the rounds are unrolled to the
 * operator's limit, `REVIEW_ROUNDS_MAX`. A round runs only where the round
 * before it decided `fix_before_merge`, and each task skips once one before
 * it found nothing to act on. A last decision, `record-stop`, names the
 * round that ended the rounds and why, as `stoppedAt`. The last round's
 * `decision` cannot say it: a fix round that broke leaves it at
 * `fix_before_merge`, as the limit does.
 */

/** The most reviews one run makes: the operator's limit on the rounds. */
export const REVIEW_ROUNDS_MAX = 3;

export const READ_COMMISSION_TASK_ID = 'read-commission';
export const commitTaskId = (round: number) => `commit-${String(round)}`;
export const reviewTaskId = (round: number) => `review-${String(round)}`;
export const decideTaskId = (round: number) => `decide-${String(round)}`;
export const fixTaskId = (round: number) => `fix-${String(round)}`;
export const RECORD_STOP_TASK_ID = 'record-stop';

export const MAJOR_ALWAYS_REASON =
  'The review found a blocker or a major. Under the rounds rule a major always takes its fix round, whatever the round.';
export const LATER_ROUND_REASON =
  'A fix round has run, and the review found no blocker or major. Under the rounds rule the patch is taken as it stands, its minors and nits recorded open.';
export const NOT_APPROVED_FIRST_REASON =
  'The first review did not approve. Under the rounds rule a first review short of approve takes a fix round.';
export const FIRST_ROUND_MINOR_REASON =
  'The first review found a minor. Under the rounds rule a minor or worse in the first round takes a fix round.';
export const NITS_ONLY_FIRST_REASON =
  'The first review approved with nits alone, or with nothing. Under the rounds rule the rounds end and the patch is taken as it stands.';

/**
 * The rounds rule as the operator set it: a blocker or a major takes a fix
 * round in every round. After the first round, minors and nits are taken as
 * they stand. In the first round a review short of approve, or a minor, takes
 * a fix round. A `needs_setup` finding counts as none, as in the publication.
 * The publication's own rule differs in two places, and stays as it is:
 *
 * - After a fix round it publishes an approving review's major, because its
 *   push gate then asks the operator. Here no operator stands behind a push,
 *   so the major takes its fix, bounded by `REVIEW_ROUNDS_MAX`.
 * - After a fix round it fixes a review that does not approve and names no
 *   blocker or major. Here that review is taken as it stands, its minors and
 *   nits recorded open.
 */
export const REVIEW_ROUNDS_RULES: readonly WorkflowRunDecideRule[] = [
  ...aboveMinorRules(MAJOR_ALWAYS_REASON),
  {
    when: { expression: 'state.round > 1' },
    decision: 'publish_as_is',
    reason: LATER_ROUND_REASON,
  },
  {
    when: { expression: "state.verdict != 'approve'" },
    decision: 'fix_before_merge',
    reason: NOT_APPROVED_FIRST_REASON,
  },
  ...minorRules(FIRST_ROUND_MINOR_REASON),
];

export const REVIEW_ROUNDS_OTHERWISE = {
  decision: 'publish_as_is',
  reason: NITS_ONLY_FIRST_REASON,
};

/**
 * The fix round's brief, before the commission's own brief and the review's
 * summary. The review's findings ledger stays on its run. Its summary names
 * every finding by severity and `file:line`, which is what a coding agent
 * fixes from.
 */
export const FIX_BRIEF_OPENING =
  'This is a fix round. The branch this checkout starts at holds a change made for the brief below, and a review of that change found what its summary below says. Fix every finding the summary names, blockers and majors first, and keep to what the brief asks. A finding of kind `needs_setup` is setup on the machine, not a defect of the change: leave it. Run the checks the brief names again before you return.\n\nThe brief:\n\n';
export const FIX_BRIEF_REVIEW = '\n\nThe review:\n\n';

const REVIEW_SKILL = {
  catalogId: REVIEW_LOCAL_CHANGES.catalogId,
  slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
};
const COMMISSION_SKILL = {
  catalogId: COMMISSION_CHANGE.catalogId,
  slug: COMMISSION_CHANGE.bundle.workflow.slug,
};

const ROUNDS_RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      'The connected folder holding the repository the commission changed. It must allow writes: each round commits on a local branch there.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'commission',
    required: true,
    description:
      'The run id of the completed Commission Change whose patch the rounds review. Its `patchRef`, `baseSha` and `summary` are read from that run.',
    schema: COMMISSION_RUN_ID_SCHEMA,
  },
  {
    id: 'brief',
    required: true,
    description:
      'The brief that commission ran on, as it was passed. A fix round is briefed with it and with the review’s summary.',
    schema: { type: 'string', minLength: 1, maxLength: COMMISSION_BRIEF_MAX_LENGTH },
  },
  {
    id: 'branch',
    required: true,
    description:
      'A branch name the folder does not hold yet. The rounds commit on it locally, and it is never pushed.',
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  },
  {
    id: 'depth',
    required: false,
    description:
      'The depth each review reads at: "brief", "standard" or "deep". Absent, the review reads at its own default, "standard".',
    schema: { type: 'string', enum: ['brief', 'standard', 'deep'] },
  },
  {
    id: 'harness',
    required: false,
    description:
      'Which coding agent makes each fix round, by the id the operator configured on the machine. Absent, Commission Change picks as it does.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewHarness',
    required: false,
    description:
      'Which coding agent reviews each round, by the id the operator configured on the machine. Absent, Review Local Changes picks as it does.',
    schema: { type: 'string', minLength: 1 },
  },
];

const READ_COMMISSION_TASK = {
  taskId: READ_COMMISSION_TASK_ID,
  name: 'Read the commission',
  goal: 'Read the patch, the base it was made against and the summary of the Commission Change named as `commission`, from its run.',
  type: 'operation' as const,
  operation: 'workflow.run.detail',
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: { commission: runInput('commission') },
  // The start checks the caller's inputs against the entry task's contract.
  inputContract: entryContract(ROUNDS_RUN_INPUTS),
  context: ctx('workflow.run.detail'),
  inputTemplate: { runId: bind('commission'), compact: true },
  // A commission that changed nothing reports no patch: the rounds then have
  // nothing to review, and every task after this one skips.
  outputProjection: {
    status: { path: 'run.status', onMissing: 'error' as const },
    patchRef: { path: 'result.output.patchRef', onMissing: 'null' as const },
    baseSha: { path: 'result.output.baseSha', onMissing: 'null' as const },
    title: { path: 'result.output.summary.title', onMissing: 'null' as const },
    paragraph: { path: 'result.output.summary.paragraph', onMissing: 'null' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'baseSha', toState: 'baseSha' }],
};

/** Where a round's patch, its base and its summary come from: the commission read, or the round's fix. */
function patchSource(round: number): string {
  return round === 1 ? READ_COMMISSION_TASK_ID : fixTaskId(round);
}

function commitTask(round: number) {
  const source = patchSource(round);
  const fallback =
    round === 1
      ? 'Take the commissioned change for review'
      : `Fix what review round ${String(round - 1)} found`;
  return {
    taskId: commitTaskId(round),
    name: `Commit round ${String(round)}'s patch on the local branch`,
    goal:
      round === 1
        ? "Commit the commission's patch on a new local branch at the commit it was made against, under the commission's summary. Nothing is fetched or pushed, and the folder's working tree is left as it was."
        : `Commit fix round ${String(round)}'s patch on the local branch, appended to its head, under the fix commission's summary. Nothing is fetched or pushed.`,
    type: 'operation' as const,
    operation: 'host.file.patch',
    dependsOn: round === 1 ? [source] : [source, decideTaskId(round - 1)],
    when: { expression: `tasks.${source}.output.patchRef != null`, onMissingRef: SKIP },
    // A second attempt would commit the patch a second time.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      branch: runInput('branch'),
      patchRef: out(source, 'patchRef'),
      baseSha: out(source, 'baseSha'),
      title: out(source, 'title'),
      paragraph: out(source, 'paragraph'),
    },
    context: ctx('host.file.patch'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      patchRef: bind('patchRef'),
      mode: 'clean',
      // No `pushBase`: the commit is measured against no remote, so the
      // rounds run in a folder that has none.
      commit: {
        branch: bind('branch'),
        message: {
          $firstOf: [{ $concat: [bind('title'), '\n\n', bind('paragraph')] }, fallback],
        },
        baseSha: bind('baseSha'),
      },
    },
    // A patch that no longer fits applies nothing and reports no commit: the
    // round's review then skips, and the head stays where it was.
    outputProjection: {
      state: { path: 'state', onMissing: 'error' as const },
      branch: { path: 'commit.branch', onMissing: 'null' as const },
      sha: { path: 'commit.sha', onMissing: 'null' as const },
    },
    // Only the first round makes the branch, so only it names it: a later
    // commit that did not land would write null over it.
    ...(round === 1
      ? { promoteOutputs: [{ kind: 'output_path' as const, path: 'branch', toState: 'branch' }] }
      : {}),
  };
}

function reviewTask(round: number) {
  const commit = commitTaskId(round);
  return {
    taskId: reviewTaskId(round),
    name: `Review round ${String(round)}`,
    goal: `Run a Local Code Review of everything the branch adds over the commission's base, as a run of its own, standing at round ${String(round)}'s commit, and wait for its verdict and findings.`,
    type: 'operation' as const,
    operation: 'workflow.run.start',
    dependsOn: [READ_COMMISSION_TASK_ID, commit],
    when: { expression: `tasks.${commit}.output.sha != null`, onMissingRef: SKIP },
    // A review that could not run ends the rounds. The run says so on this task.
    optional: true,
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      from: out(READ_COMMISSION_TASK_ID, 'baseSha'),
      at: out(commit, 'sha'),
      depth: runInput('depth'),
      reviewHarness: runInput('reviewHarness'),
    },
    context: ctx('workflow.run.start'),
    inputTemplate: {
      slug: REVIEW_SKILL.slug,
      catalogId: REVIEW_SKILL.catalogId,
      inputs: {
        bindingId: bind('bindingId'),
        from: bind('from'),
        at: bind('at'),
        depth: bind('depth'),
        harness: bind('reviewHarness'),
      },
      wait: 'until_complete',
    },
    // A review that failed, was cancelled or paused promoted nothing, so its
    // findings read null and the round decides nothing.
    outputProjection: {
      verdict: { path: 'result.output.verdict', onMissing: 'null' as const },
      reviewSummary: { path: 'result.output.reviewSummary', onMissing: 'null' as const },
      findings: { path: 'result.output.findings', onMissing: 'null' as const },
      outcome: { path: 'outcome', onMissing: 'error' as const },
      reviewRunId: { path: 'runId', onMissing: 'error' as const },
    },
  };
}

function decideTask(round: number) {
  const review = reviewTaskId(round);
  const commit = commitTaskId(round);
  return {
    taskId: decideTaskId(round),
    name: `Decide round ${String(round)} by the rounds rule`,
    goal: `Decide by the rounds rule over round ${String(round)}'s verdict and the severities of its findings: a blocker or a major takes a fix round in every round. In the first round a review short of approve, or a minor, takes one too. Otherwise the patch is taken as it stands. A \`needs_setup\` finding counts as none. No model is asked.${round === REVIEW_ROUNDS_MAX ? ' This is the last round the limit allows, so a fix decided here ends the rounds at the limit.' : ''}`,
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [commit, review],
    when: { expression: `tasks.${review}.output.findings != null`, onMissingRef: SKIP },
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      verdict: out(review, 'verdict'),
      findings: out(review, 'findings'),
      reviewRunId: out(review, 'reviewRunId'),
      headSha: out(commit, 'sha'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        round,
        verdict: bind('verdict'),
        findings: bind('findings'),
        reviewRunId: bind('reviewRunId'),
        headSha: bind('headSha'),
      },
      rules: REVIEW_ROUNDS_RULES,
      otherwise: REVIEW_ROUNDS_OTHERWISE,
    },
    // The round's record is what it decided on: the run appends it to `rounds`.
    outputProjection: {
      decision: { path: 'decision', onMissing: 'error' as const },
      reason: { path: 'reason', onMissing: 'error' as const },
      round: { fromInput: 'state' },
    },
    // The run's head, verdict and findings are the last decided round's, so
    // the head the run reports is always one a review read and the rule
    // decided. A fix whose review did not finish stays on the branch past it.
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'decision', toState: 'decision' },
      { kind: 'output_path' as const, path: 'round.headSha', toState: 'headSha' },
      { kind: 'output_path' as const, path: 'round.verdict', toState: 'verdict' },
      { kind: 'output_path' as const, path: 'round.findings', toState: 'findings' },
      { kind: 'output_path' as const, path: 'round', toState: 'rounds' },
    ],
  };
}

function fixTask(round: number) {
  const decide = decideTaskId(round - 1);
  const review = reviewTaskId(round - 1);
  return {
    taskId: fixTaskId(round),
    name: `Commission fix round ${String(round)}`,
    goal: `Where round ${String(round - 1)} decided \`fix_before_merge\`, run Commission Change on the local branch, briefed with the brief and the review's summary, and wait for its patch.`,
    type: 'operation' as const,
    operation: 'workflow.run.start',
    dependsOn: [decide, review],
    when: {
      expression: `tasks.${decide}.output.decision == 'fix_before_merge'`,
      onMissingRef: SKIP,
    },
    // A fix that could not run, or a brief over the commission's limit, ends
    // the rounds with the head the last review read.
    optional: true,
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      branch: runInput('branch'),
      brief: runInput('brief'),
      harness: runInput('harness'),
      reviewSummary: out(review, 'reviewSummary'),
    },
    context: ctx('workflow.run.start'),
    inputTemplate: {
      slug: COMMISSION_SKILL.slug,
      catalogId: COMMISSION_SKILL.catalogId,
      inputs: {
        bindingId: bind('bindingId'),
        task: {
          $concat: [FIX_BRIEF_OPENING, bind('brief'), FIX_BRIEF_REVIEW, bind('reviewSummary')],
        },
        // The branch is local: its name is the only base that holds the
        // earlier rounds, and no remote is fetched for it.
        base: bind('branch'),
        harness: bind('harness'),
      },
      wait: 'until_complete',
    },
    outputProjection: {
      patchRef: { path: 'result.output.patchRef', onMissing: 'null' as const },
      baseSha: { path: 'result.output.baseSha', onMissing: 'null' as const },
      title: { path: 'result.output.summary.title', onMissing: 'null' as const },
      paragraph: { path: 'result.output.summary.paragraph', onMissing: 'null' as const },
      outcome: { path: 'outcome', onMissing: 'error' as const },
      commissionRunId: { path: 'runId', onMissing: 'error' as const },
    },
  };
}

/**
 * Why the rounds stopped, each a label `stoppedAt.why` carries. Only
 * `taken_as_it_stands` and `round_limit` are ends the rounds rule chose. The
 * rest are a step that broke, and the run's head is the last reviewed one.
 */
export const STOP_REASONS = {
  taken_as_it_stands: 'The rounds rule took the patch as it stands after this round’s review.',
  round_limit:
    'This round’s review decided a fix, and the limit on rounds allows no further one. Its findings stand open.',
  fix_failed:
    'This fix round did not complete: it failed, was refused, timed out or paused. The head is the last one a review read.',
  fix_no_patch:
    'This fix round completed with no patch, so nothing was left to review. The head is the last one a review read.',
  commit_failed:
    'This round’s patch did not apply on the local branch, so it was not reviewed. The head is the last one a review read.',
  review_failed:
    'This round’s review returned no findings: it failed, was cancelled or paused. The rounds rule decided nothing on it.',
  no_patch: 'The commission reported no patch, so no round was reviewed.',
} as const;
export type StopReason = keyof typeof STOP_REASONS;

function stopRule(round: number, why: StopReason, comparisons: string[]): WorkflowRunDecideRule {
  const [only] = comparisons;
  return {
    when:
      comparisons.length === 1 && only !== undefined
        ? { expression: only }
        : { allOf: comparisons },
    decision: why,
    reason: STOP_REASONS[why],
    value: { round, why, reason: STOP_REASONS[why] },
  };
}

/** The state name of the patch a round commits: the commission's, or its fix round's. */
function patchState(round: number): string {
  return round === 1 ? 'commissionPatch' : `fix${String(round)}Patch`;
}

/** What the stop decision reads, by its state name: every round's patch, commit, decision and fix outcome. */
function stopBindings() {
  const bindings: Record<string, ReturnType<typeof out>> = {
    commissionPatch: out(READ_COMMISSION_TASK_ID, 'patchRef'),
  };
  for (let round = 1; round <= REVIEW_ROUNDS_MAX; round += 1) {
    const n = String(round);
    if (round > 1) {
      bindings[`fix${n}Patch`] = out(fixTaskId(round), 'patchRef');
      bindings[`fix${n}Outcome`] = out(fixTaskId(round), 'outcome');
    }
    bindings[`commit${n}`] = out(commitTaskId(round), 'sha');
    bindings[`decision${n}`] = out(decideTaskId(round), 'decision');
  }
  return bindings;
}

/**
 * One rule for each way each round can end. They are exclusive, so their
 * order decides nothing. The default is the commission with no patch, the one
 * end no rule names.
 */
export const STOP_RULES: readonly WorkflowRunDecideRule[] = Array.from(
  { length: REVIEW_ROUNDS_MAX },
  (_, i) => {
    const round = i + 1;
    const n = String(round);
    const patch = `state.${patchState(round)}`;
    const rules: WorkflowRunDecideRule[] = [];
    if (round > 1) {
      const decidedFix = `state.decision${String(round - 1)} == 'fix_before_merge'`;
      rules.push(
        stopRule(round, 'fix_failed', [decidedFix, `state.fix${n}Outcome != 'completed'`]),
        stopRule(round, 'fix_no_patch', [
          decidedFix,
          `state.fix${n}Outcome == 'completed'`,
          `${patch} == null`,
        ]),
      );
    }
    rules.push(
      stopRule(round, 'commit_failed', [`${patch} != null`, `state.commit${n} == null`]),
      stopRule(round, 'review_failed', [`state.commit${n} != null`, `state.decision${n} == null`]),
      stopRule(round, 'taken_as_it_stands', [`state.decision${n} == 'publish_as_is'`]),
    );
    if (round === REVIEW_ROUNDS_MAX) {
      rules.push(stopRule(round, 'round_limit', [`state.decision${n} == 'fix_before_merge'`]));
    }
    return rules;
  },
).flat();

export const STOP_OTHERWISE = {
  decision: 'no_patch',
  reason: STOP_REASONS.no_patch,
  value: { round: 1, why: 'no_patch', reason: STOP_REASONS.no_patch },
};

function recordStopTask(roundTaskIds: string[]) {
  const bindings = stopBindings();
  return {
    taskId: RECORD_STOP_TASK_ID,
    name: 'Record where the rounds stopped',
    goal: 'Decide by rules which round ended the rounds and why: the rounds rule took the patch, the limit ended them, or a commit, a review or a fix round broke. No model is asked.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: roundTaskIds,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: bindings,
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      // A task that skipped or failed binds nothing, and its value reads null.
      state: Object.fromEntries(Object.keys(bindings).map((name) => [name, bind(name)])),
      rules: STOP_RULES,
      otherwise: STOP_OTHERWISE,
    },
    outputProjection: {
      stoppedAt: { path: 'value', onMissing: 'error' as const },
    },
    promoteOutputs: [{ kind: 'output_path' as const, path: 'stoppedAt', toState: 'stoppedAt' }],
  };
}

function roundTasks(round: number) {
  return [
    ...(round === 1 ? [] : [fixTask(round)]),
    commitTask(round),
    reviewTask(round),
    decideTask(round),
  ];
}

const ROUND_TASKS = [
  READ_COMMISSION_TASK,
  ...Array.from({ length: REVIEW_ROUNDS_MAX }, (_, i) => roundTasks(i + 1)).flat(),
];

const ROUNDS_TASKS = [...ROUND_TASKS, recordStopTask(ROUND_TASKS.map((task) => task.taskId))];

const REVIEW_ROUNDS_PITFALLS: string[] = [
  'What it needs: the folder, the completed Commission Change as `commission`, the `brief` that commission ran on, and a `branch` name the folder does not hold yet. The folder must allow writes, and it needs no remote.',
  'It never pushes, opens no pull request and runs no publication. Where the change is meant to land, publish it with Publish Local Changes instead.',
  'The final patch is `git diff <baseSha>..<headSha>` in the folder, on `branch`. The folder’s working tree is left as the commission found it, so a patch read from the working tree is empty.',
  `It reviews at most ${String(REVIEW_ROUNDS_MAX)} times. Read how the rounds ended from \`stoppedAt\`, not from \`decision\`. A fix round that broke leaves \`decision\` at \`fix_before_merge\`, as the limit does. Only a \`stoppedAt.why\` of \`round_limit\` means the limit ended them.`,
];

const REVIEW_ROUNDS: SkillCatalogEntry = {
  catalogId: 'review-rounds',
  version: 1,
  name: 'Review Rounds',
  tagline:
    "Review a commission's patch in rounds and fix it by the rounds rule, on a local branch, with nothing pushed.",
  description: `Fits a measurement of the loop, where no pull request is opened and the patch is the output (Plan 341 D5). It takes a completed Commission Change, commits its patch on a local branch, has Review Local Changes read it, and decides by the rounds rule whether a fix round follows. A fix round is a further Commission Change on that branch. The run records every round's verdict, findings and decision, and ends with the branch's head. Nothing is pushed and no remote is read. Publishing a change is Publish Local Changes, which runs its own rounds.`,
  tags: ['coding', 'review', 'local', 'benchmark'],
  bundle: {
    workflow: {
      slug: 'review-rounds',
      name: 'Review Rounds',
      description:
        "Run the loop's review rounds on a commission's patch in a connected folder: each round commits on a local branch, Review Local Changes reads the branch, and the rounds rule decides whether Commission Change fixes it. No push, no pull request, no remote.",
      usage: {
        whenToUse: [
          "Measuring the loop in a space with no publication: a commission's patch reviewed and fixed in rounds by the rounds rule, with the final patch on a local branch",
        ],
        whenNotToUse: [
          'A change meant to land in the repository — that is Publish Local Changes, whose own rounds gate a push',
          'One review of committed work — that is Review Local Changes',
        ],
        next: [],
        pitfalls: REVIEW_ROUNDS_PITFALLS,
      },
      goal: "Return the head of a local branch holding the commission's change after the review rounds the rounds rule decided, with every round's verdict, findings and decision recorded.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'rounds-decided',
          name: 'Rounds decided',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The commission's patch was committed on a local branch, each round's review returned a verdict, and the rounds rule decided each round, with nothing pushed.",
          },
        },
      ],
      runInputs: ROUNDS_RUN_INPUTS,
      tasks: ROUNDS_TASKS,
      stateVariables: [
        {
          variableId: 'headSha',
          name: 'Head',
          description:
            'The commit the last decided round reviewed. The final patch is the diff from `baseSha` to it. A fix whose review did not finish may sit on the branch past it.',
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'branch',
          name: 'Branch',
          description: 'The local branch the rounds committed on. It is never pushed.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'baseSha',
          name: 'Base',
          description: 'The commit the commission started from, where the final patch begins.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'verdict',
          name: 'Verdict',
          description: "The last review's verdict: approve, request_changes or comment.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'findings',
          name: 'Findings',
          description: "The last review's findings, as Review Local Changes returned them.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'decision',
          name: 'Decision',
          description:
            "The last decided round's decision by the rounds rule. It does not say how the rounds ended: a fix round that broke leaves `fix_before_merge` here, as the limit does. `stoppedAt` says it.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'stoppedAt',
          name: 'Stopped at',
          description:
            'Which round ended the rounds, and why: its `round`, `why` and `reason`. A `why` of `taken_as_it_stands` or `round_limit` is an end the rounds rule chose. `fix_failed`, `fix_no_patch`, `commit_failed` and `review_failed` name a step of that round that broke. `no_patch` means the commission had no patch.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'rounds',
          name: 'Rounds',
          description:
            "Every round's record, oldest first: its round, verdict, findings, review run and the head it read. Each round's decision and reason are on its decide task.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'append' as const,
        },
      ],
      output: {
        primary: 'headSha',
        guidance:
          'The final patch is the diff from baseSha to headSha on branch, in the folder. Report stoppedAt for which round ended the rounds and why. Report verdict and decision as they stand, and rounds for what each round found. Only a stoppedAt.why of round_limit means the limit on rounds ended them. Nothing was pushed.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'review-rounds',
      name: 'Review Rounds',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'rounds-decided',
            description:
              "A commission's patch is reviewed in rounds on a local branch of a connected folder, each round decided by the rounds rule, with nothing pushed.",
          },
        ],
      },
      mode: 'process' as const,
      concurrency: {
        maxParallelTasksPerRun: 1,
        maxConcurrentRuns: 'unlimited' as const,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: ['review the commission in rounds', 'run the review rounds'],
      activationHint:
        "Run to review and fix a commission's patch in rounds by the rounds rule on a local branch, with nothing pushed. Its usage says what it needs.",
      prerequisites: [],
      priority: 40,
    },
    rationale:
      "The publication's rounds without the publication: host.file.patch commits each round's patch on a local branch with no pushBase, workflow.run.start runs Review Local Changes and Commission Change as runs of their own, and workflow.run.decide applies the rounds rule from the publication's own rule builders. The graph is unrolled to REVIEW_ROUNDS_MAX rounds, each gated on the decision before it, so every round's review, decision and fix is a task of the run. A last workflow.run.decide records which round stopped the rounds and why, so a broken fix round never reads as the limit.",
  },
};

export { REVIEW_ROUNDS };
