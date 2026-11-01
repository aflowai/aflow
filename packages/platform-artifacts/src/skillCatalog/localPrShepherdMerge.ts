import {
  PULL_REQUEST_REVIEWS_PER_PAGE,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_LEASE_ROOT,
  SHEPHERD_MERGE_OUTCOME_DOCS,
  SHEPHERD_RESPONSE_PRESETS,
} from '@aflow/schemas';
import {
  MERGE_HANDED_BACK,
  MERGE_OUTCOME_OTHERWISE,
  MERGE_OUTCOME_RULES,
  MERGE_REFUSAL_BASE_MOVED,
  MERGE_REFUSAL_OTHERWISE,
  MERGE_REFUSAL_RULES,
} from './localPrShepherdRules.js';
import {
  BASE_REF,
  bind,
  ctx,
  DECIDED_MERGE,
  github,
  GITHUB_READ_PROJECTION,
  HEAD_REF,
  LEASE_TAKERS,
  NUMBER,
  OURS_WHEN_GREEN,
  out,
  REPOSITORY,
  SKIP,
} from './localPrShepherdWiring.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';

/**
 * The merge of the Local PR Shepherd (Plan 321 D6): what a folder whose merge
 * posture is `when-green` reads before the rules — the base branch's required
 * checks, the people's reviews, and the publication's own verdict for the
 * head — and the merge itself, by squash and pinned to the head, behind the
 * endpoint's write approval. Every read here is optional: one that could not
 * be made holds the merge back by rule, and nothing else.
 */

/** The task whose output names the base branch's required checks, for the check-run read's argument. */
export const REQUIRED_CHECKS_TASK = 'read-required-protection';

/** The publication's task whose verdict, and the head it reviewed, the merge reads. */
const REVIEW_TASK = 'review-commit';

/**
 * The publication's tasks that say which commit it pushed: `commit`'s output
 * names the commit whose refspec `push` sent, so a run that succeeded in both
 * pushed exactly that sha.
 */
export const PUBLICATION_PUSH_TASK = 'push';
export const PUBLICATION_COMMIT_TASK = 'commit';
export const PUBLICATION_PUSHED_SHA_PATH = 'commit.sha';
/**
 * Where `push`'s output names the merge it sent, where `origin`'s base had
 * moved and merged cleanly (Plan 339 D3): the head is then that merge, not
 * `commit.sha`, and `baseMerge.branchCommit` is the commit the publication
 * made and reviewed.
 */
export const PUBLICATION_PUSHED_MERGE_PATH = 'baseMerge.commit';

/** The publication whose verdict the merge reads: the one that pushed the head as its commit, else as a base merge. */
const PUBLICATION_RUN_ID = {
  $firstOf: [bind('pushedRunId'), bind('mergedRunId')],
};
const PUBLICATION_RUN_BINDINGS = {
  pushedRunId: out('read-publication', 'runs[0].id'),
  mergedRunId: out('read-merged-publication', 'runs[0].id'),
};
const PUBLICATION_FOUND = {
  anyOf: [
    'tasks.read-publication.output.runs[0].id != null',
    'tasks.read-merged-publication.output.runs[0].id != null',
  ],
  onMissingRef: SKIP,
};

export const MERGE_READ_TASKS = [
  {
    taskId: 'read-required-rules',
    name: "Read the base branch's ruleset checks",
    goal: 'Read the checks the repository rulesets require of a merge into the pull request’s base branch.',
    type: 'operation' as const,
    operation: 'api.http.call',
    when: OURS_WHEN_GREEN,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { ...REPOSITORY, ...BASE_REF },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'getBranchRules',
      { owner: bind('owner'), repo: bind('repo'), branch: bind('baseRef'), per_page: 100 },
      SHEPHERD_RESPONSE_PRESETS.requiredRules,
    ),
    outputProjection: GITHUB_READ_PROJECTION,
  },

  {
    taskId: REQUIRED_CHECKS_TASK,
    name: "Read the base branch's protected checks",
    goal: "Read the checks the base branch's classic protection requires, and unite them with the rulesets' — the base branch's required checks, from both places GitHub keeps them.",
    type: 'operation' as const,
    operation: 'api.http.call',
    when: {
      expression: 'tasks.read-required-rules.output.statusCode == 200',
      onMissingRef: SKIP,
    },
    optional: true,
    retryability: 'safe' as const,
    inputBindings: {
      ...REPOSITORY,
      ...BASE_REF,
      ruleset: out('read-required-rules', 'data.encoded'),
    },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'getBranch',
      { owner: bind('owner'), repo: bind('repo'), branch: bind('baseRef') },
      { $concat: [`${SHEPHERD_RESPONSE_PRESETS.requiredProtection}:`, bind('ruleset')] },
    ),
    outputProjection: GITHUB_READ_PROJECTION,
  },

  {
    taskId: 'read-pr-reviews',
    name: "Read the people's reviews",
    goal: 'Read one page of the pull request’s reviews and keep each person’s standing verdict — the latest that approves, requests changes or was dismissed — and whether the page held them all.',
    type: 'operation' as const,
    operation: 'api.http.call',
    when: OURS_WHEN_GREEN,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { ...REPOSITORY, ...NUMBER },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'listPullRequestReviews',
      {
        owner: bind('owner'),
        repo: bind('repo'),
        pull_number: bind('number'),
        per_page: PULL_REQUEST_REVIEWS_PER_PAGE,
        page: 1,
      },
      SHEPHERD_RESPONSE_PRESETS.reviews,
    ),
    outputProjection: GITHUB_READ_PROJECTION,
  },

  {
    taskId: 'read-publication',
    name: 'Find the publication that pushed the head',
    goal: "Find the space's finished publication of the pull request's branch that pushed its head — its push succeeded, sending the commit that is the head — whose Local Code Review is the loop's own word on that head. A newer publication that reviewed a commit it never pushed is not it.",
    type: 'operation' as const,
    operation: 'workflow.run.list',
    when: OURS_WHEN_GREEN,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { ...HEAD_REF, headSha: out('read-pr', 'data.headSha') },
    context: ctx('workflow.run.list'),
    inputTemplate: {
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: bind('headRef') },
      succeeded: [
        { taskId: PUBLICATION_PUSH_TASK },
        {
          taskId: PUBLICATION_COMMIT_TASK,
          output: { path: PUBLICATION_PUSHED_SHA_PATH, equals: bind('headSha') },
        },
      ],
      status: ['completed', 'failed', 'cancelled'],
      limit: 1,
    },
  },

  {
    taskId: 'read-merged-publication',
    name: 'Find the publication that pushed the head as a base merge',
    goal: "Find the space's finished publication of the pull request's branch whose push sent the head as the merge of a moved base into the commit it made and reviewed. It is read where no publication pushed the head as its own commit.",
    type: 'operation' as const,
    operation: 'workflow.run.list',
    when: OURS_WHEN_GREEN,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { ...HEAD_REF, headSha: out('read-pr', 'data.headSha') },
    context: ctx('workflow.run.list'),
    inputTemplate: {
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: bind('headRef') },
      succeeded: [
        {
          taskId: PUBLICATION_PUSH_TASK,
          output: { path: PUBLICATION_PUSHED_MERGE_PATH, equals: bind('headSha') },
        },
      ],
      status: ['completed', 'failed', 'cancelled'],
      limit: 1,
    },
  },

  {
    taskId: 'read-publication-merge',
    name: "Read the base merge the publication's push sent",
    goal: 'Read, from the same publication run as the review, the base merge its push recorded, if any: the merge commit it sent and the commit it made and reviewed. A head that is that merge counts as reviewed where the review is of that commit.',
    type: 'operation' as const,
    operation: 'workflow.run.detail',
    when: PUBLICATION_FOUND,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: PUBLICATION_RUN_BINDINGS,
    context: ctx('workflow.run.detail'),
    inputTemplate: { runId: PUBLICATION_RUN_ID, compact: true, taskOutput: PUBLICATION_PUSH_TASK },
  },

  {
    taskId: 'read-publication-review',
    name: "Read the publication's review and override",
    goal: "Read the pushed head's publication review, its reviewed commit, and its overrideCheck and pushDecision from result.output, trusted only from that publication run. Read the verdict from the review run's final attempt, including a review retried in place.",
    type: 'operation' as const,
    operation: 'workflow.run.detail',
    when: PUBLICATION_FOUND,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: PUBLICATION_RUN_BINDINGS,
    context: ctx('workflow.run.detail'),
    inputTemplate: { runId: PUBLICATION_RUN_ID, compact: true, taskOutput: REVIEW_TASK },
  },
];

/**
 * `shepherd/<owner>/<repo>/pulls/<number>/merges/<headSha>.json`: the outcome
 * of the merge asked for on one head of one pull request, bound from `owner`,
 * `repo`, `number` and `headSha`.
 */
const MERGE_OUTCOME_PATH = {
  $concat: [
    `${SHEPHERD_LEASE_ROOT}/`,
    bind('owner'),
    '/',
    bind('repo'),
    `/${SHEPHERD_HANDOFF_PINS}/`,
    { $text: [bind('number')] },
    `/${SHEPHERD_MERGE_OUTCOME_DOCS}/`,
    bind('headSha'),
    '.json',
  ],
};

const MERGE_OUTCOME_BINDINGS = {
  ...REPOSITORY,
  ...NUMBER,
  headSha: out('read-pr', 'data.headSha'),
};

/** What the claim records until the merge's outcome replaces it: this head was asked about. */
export const MERGE_ASKED = 'merge_asked';

/**
 * The merge is asked for only where this pass's claim on the head succeeded:
 * a create that fails where anything is recorded for the head — a claim, a
 * decline, a refusal or a merge — and fails as well where the store cannot
 * answer. The claim is written before any ask, under the lease, so no outcome
 * that goes unwritten afterwards — a failed write, a pass that ends at its
 * card — can let a later pass ask for the same head again. The handoff's
 * record is read before the lease and written after its release, so between
 * overlapping passes it can be stale; the claim cannot.
 */
const CLAIMED_HEAD = {
  allOf: [DECIDED_MERGE.expression, "tasks.claim-merge.status == 'succeeded'"],
  onMissingRef: SKIP,
};

const MERGE_REQUEST_BINDINGS = {
  ...REPOSITORY,
  ...NUMBER,
  headSha: out('read-pr', 'data.headSha'),
};

const MERGE_REQUEST = github('mergePullRequest', {
  owner: bind('owner'),
  repo: bind('repo'),
  pull_number: bind('number'),
  body: { merge_method: 'squash', sha: bind('headSha') },
});

export const MERGE_TASKS = [
  {
    taskId: 'claim-merge',
    name: 'Claim the merge of this head',
    goal: 'Under the lease and before any merge is asked for, record that a merge of this head is being asked for — created only where nothing is recorded for the head, so a head a pass already asked about, declined, refused or merged is never asked about again, however passes overlap and whatever becomes of the outcome’s own record.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    dependsOn: [...LEASE_TAKERS],
    when: DECIDED_MERGE,
    // A claim refused — something is recorded, or the store could not
    // answer — leaves the merge unasked; the pass still records and releases.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { ...MERGE_OUTCOME_BINDINGS, runId: { kind: 'run_id' as const } },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: MERGE_OUTCOME_PATH,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'The Local PR Shepherd asked to merge this head.',
      content: {
        inlineJson: { headSha: bind('headSha'), outcome: MERGE_ASKED, runId: bind('runId') },
      },
    },
  },

  {
    taskId: 'merge',
    name: 'Merge the pull request',
    goal: "Merge the pull request by squash, pinned to the head this pass read, so GitHub refuses it if the head moved since — only where this pass claimed the head, nothing being recorded for it. The merge waits on the operator's approval of exactly this request, as the space's write policy has it.",
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: [...LEASE_TAKERS],
    when: CLAIMED_HEAD,
    // A denied approval fails it; the pass still records and releases.
    optional: true,
    // A second attempt asks a second approval.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: MERGE_REQUEST_BINDINGS,
    context: ctx('api.http.call'),
    inputTemplate: MERGE_REQUEST,
  },

  // GitHub computes a pull request's mergeability again when it is read, so
  // this read comes before any re-attempt as well as showing whether the head moved.
  {
    taskId: 'reread-pr-after-refusal',
    name: 'Read the pull request again after a refused merge',
    goal: 'Where GitHub refused the merge with 405, read the pull request again — its head, and whether it merges into its base as the base now stands — to tell a base that moved under an unchanged head from a head that is no longer the one pinned.',
    type: 'operation' as const,
    operation: 'api.http.call',
    when: {
      allOf: [...CLAIMED_HEAD.allOf, 'tasks.merge.output.statusCode == 405'],
      onMissingRef: SKIP,
    },
    optional: true,
    retryability: 'safe' as const,
    inputBindings: {
      ...REPOSITORY,
      ...NUMBER,
      prefix: out('read-folder', 'branchPolicy.branchPrefix'),
    },
    context: ctx('api.http.call'),
    inputTemplate: github(
      'getPullRequest',
      { owner: bind('owner'), repo: bind('repo'), pull_number: bind('number') },
      { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequest}:`, bind('prefix')] },
    ),
    outputProjection: GITHUB_READ_PROJECTION,
  },

  {
    taskId: 'judge-merge-refusal',
    name: 'Judge the kind of refusal',
    goal: 'Name the kind of refusal GitHub gave the merge: `base_moved` where only the base branch moved and the head, read again, is still the one pinned with its required checks passed — attempted again, and never left — or `head_invalid` for anything else, recorded against the head as before.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    when: {
      allOf: [...CLAIMED_HEAD.allOf, 'tasks.merge.output.statusCode != 200'],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: {
      merge: out('merge'),
      pr: out('reread-pr-after-refusal'),
      pinnedHead: out('read-pr', 'data.headSha'),
      checks: out('read-pr-checks'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        merge: bind('merge'),
        pr: bind('pr'),
        pinnedHead: bind('pinnedHead'),
        checks: bind('checks'),
      },
      rules: MERGE_REFUSAL_RULES,
      otherwise: MERGE_REFUSAL_OTHERWISE,
    },
  },

  {
    taskId: 'merge-again',
    name: 'Merge the pull request again',
    goal: 'Where the merge was refused only because the base branch moved, under a head still as pinned and green, send the same merge once more: by squash, pinned to the same head.',
    type: 'operation' as const,
    operation: 'api.http.call',
    when: {
      allOf: [
        ...CLAIMED_HEAD.allOf,
        `tasks.judge-merge-refusal.output.decision == '${MERGE_REFUSAL_BASE_MOVED}'`,
      ],
      onMissingRef: SKIP,
    },
    // The same request the operator approved, in the same run: the grant
    // already minted covers it, so no second card is raised.
    optional: true,
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: MERGE_REQUEST_BINDINGS,
    context: ctx('api.http.call'),
    inputTemplate: MERGE_REQUEST,
  },

  {
    taskId: 'record-merge',
    name: 'Record how the merge ended',
    goal: 'Name how the merge ended — merged, refused by GitHub on the pinned head, or not made because the operator declined it — as the field the handoff records it under; or, where only the base moved and the re-attempt did not merge either, hand back `merge` and record nothing against the head.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: ['merge', 'merge-again'],
    // Only a merge that was asked for — answered, refused or denied — has an outcome to name.
    when: {
      allOf: [...CLAIMED_HEAD.allOf, "tasks.merge.status != 'skipped'"],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: {
      merge: out('merge'),
      refusal: out('judge-merge-refusal', 'decision'),
      mergeAgain: out('merge-again'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { merge: bind('merge'), refusal: bind('refusal'), mergeAgain: bind('mergeAgain') },
      rules: MERGE_OUTCOME_RULES,
      otherwise: MERGE_OUTCOME_OTHERWISE,
    },
  },

  {
    taskId: 'remember-merge-outcome',
    name: "Record this head's merge outcome",
    goal: 'Replace the claim on this head, before the lease is released, with how its merge ended and the commit it names.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: {
      allOf: [
        "tasks.record-merge.status == 'succeeded'",
        `tasks.record-merge.output.decision != '${MERGE_HANDED_BACK}'`,
      ],
      onMissingRef: SKIP,
    },
    // The release waits for it. One that could not be written leaves the
    // claim, which stops a second ask for this head as well; the handoff
    // records the outcome.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 3,
    inputBindings: {
      ...MERGE_OUTCOME_BINDINGS,
      outcome: out('record-merge', 'decision'),
      mergeCommit: out('merge', 'data.sha'),
      mergeAgainCommit: out('merge-again', 'data.sha'),
      runId: { kind: 'run_id' as const },
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: MERGE_OUTCOME_PATH,
      writeMode: 'upsert',
      docType: 'json',
      mimeType: 'application/json',
      indexing: 'disabled',
      summary: 'How a merge the Local PR Shepherd asked for on this head ended.',
      content: {
        inlineJson: {
          headSha: bind('headSha'),
          outcome: bind('outcome'),
          mergeCommit: { $firstOf: [bind('mergeCommit'), bind('mergeAgainCommit')] },
          runId: bind('runId'),
        },
      },
    },
  },

  {
    taskId: 'release-merge-claim',
    name: 'Release the claim on this head',
    goal: "Where the merge was handed back because only the base moved, delete this pass's claim on the head before the lease is released — only as this pass wrote it — so the next pass may ask to merge the same head again.",
    type: 'operation' as const,
    operation: 'memory.store.delete',
    when: {
      expression: `tasks.record-merge.output.decision == '${MERGE_HANDED_BACK}'`,
      onMissingRef: SKIP,
    },
    // One that could not be deleted leaves the claim, which holds the head as
    // a recorded outcome would: its merge is then the operator's.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 3,
    inputBindings: { ...MERGE_OUTCOME_BINDINGS, claimHash: out('claim-merge', 'contentHash') },
    context: ctx('memory.store.delete'),
    inputTemplate: { target: { path: MERGE_OUTCOME_PATH }, expectedHash: bind('claimHash') },
  },
];
