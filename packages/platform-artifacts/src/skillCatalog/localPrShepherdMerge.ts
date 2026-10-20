import {
  PULL_REQUEST_REVIEWS_PER_PAGE,
  SHEPHERD_HANDOFF_PINS,
  SHEPHERD_LEASE_ROOT,
  SHEPHERD_MERGE_OUTCOME_DOCS,
  SHEPHERD_RESPONSE_PRESETS,
} from '@aflow/schemas';
import { MERGE_OUTCOME_OTHERWISE, MERGE_OUTCOME_RULES } from './localPrShepherdRules.js';
import {
  BASE_REF,
  bind,
  ctx,
  DECIDED_MERGE,
  github,
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
  },

  {
    taskId: 'read-publication',
    name: "Find the branch's newest publication",
    goal: "Find the space's newest finished publication of the pull request's branch, whose Local Code Review is the loop's own word on the head it pushed.",
    type: 'operation' as const,
    operation: 'workflow.run.list',
    when: OURS_WHEN_GREEN,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { ...HEAD_REF },
    context: ctx('workflow.run.list'),
    inputTemplate: {
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: bind('headRef') },
      status: ['completed', 'failed', 'cancelled'],
      limit: 1,
    },
  },

  {
    taskId: 'read-publication-review',
    name: "Read the publication's review verdict",
    goal: "Read the verdict the newest publication's Local Code Review returned, and the commit it reviewed — trusted only from the run, never from the pull request's body, which any collaborator can edit.",
    type: 'operation' as const,
    operation: 'workflow.run.detail',
    when: { expression: 'tasks.read-publication.output.runs[0].id != null', onMissingRef: SKIP },
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { runId: out('read-publication', 'runs[0].id') },
    context: ctx('workflow.run.detail'),
    inputTemplate: { runId: bind('runId'), compact: true, taskOutput: REVIEW_TASK },
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

/**
 * The merge is asked for only where the outcome read under the lease
 * succeeded and found none for this head. The handoff's record is read before
 * the lease and written after its release, so between two overlapping passes
 * it can be stale; this read cannot: an outcome is recorded before the lease
 * that covered it is released, and this read follows taking the lease.
 */
const NO_OUTCOME_FOR_HEAD = {
  allOf: [DECIDED_MERGE.expression, 'tasks.read-merge-outcome.output.found == false'],
  onMissingRef: SKIP,
};

export const MERGE_TASKS = [
  {
    taskId: 'read-merge-outcome',
    name: "Read this head's merge outcome",
    goal: 'Under the lease, read whether a merge of this head was already asked for and how it ended — declined, refused or merged — by this pass’s predecessors, however they overlapped. Only a read that found none lets the merge be asked for.',
    type: 'operation' as const,
    operation: 'memory.store.get',
    dependsOn: [...LEASE_TAKERS],
    when: DECIDED_MERGE,
    // A read that fails is not an absence: the merge stays unasked.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: MERGE_OUTCOME_BINDINGS,
    context: ctx('memory.store.get'),
    inputTemplate: { target: { path: MERGE_OUTCOME_PATH }, view: 'content', ifMissing: 'absent' },
  },

  {
    taskId: 'merge',
    name: 'Merge the pull request',
    goal: "Merge the pull request by squash, pinned to the head this pass read, so GitHub refuses it if the head moved since — only where no outcome is recorded for this head. The merge waits on the operator's approval of exactly this request, as the space's write policy has it.",
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: [...LEASE_TAKERS],
    when: NO_OUTCOME_FOR_HEAD,
    // A denied approval fails it; the pass still records and releases.
    optional: true,
    // A second attempt asks a second approval.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: { ...REPOSITORY, ...NUMBER, headSha: out('read-pr', 'data.headSha') },
    context: ctx('api.http.call'),
    inputTemplate: github('mergePullRequest', {
      owner: bind('owner'),
      repo: bind('repo'),
      pull_number: bind('number'),
      body: { merge_method: 'squash', sha: bind('headSha') },
    }),
  },

  {
    taskId: 'record-merge',
    name: 'Record how the merge ended',
    goal: 'Name how the merge ended — merged, refused by GitHub on the pinned head, or not made because the operator declined it — as the field the handoff records it under.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: ['merge'],
    // Only a merge that was asked for — answered, refused or denied — has an outcome to name.
    when: {
      allOf: [...NO_OUTCOME_FOR_HEAD.allOf, "tasks.merge.status != 'skipped'"],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: { merge: out('merge') },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { merge: bind('merge') },
      rules: MERGE_OUTCOME_RULES,
      otherwise: MERGE_OUTCOME_OTHERWISE,
    },
  },

  {
    taskId: 'remember-merge-outcome',
    name: "Record this head's merge outcome",
    goal: 'Record, before the lease is released, how the merge of this head ended and the commit it names, so no pass that holds the lease after this one asks to merge this head again.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: { expression: "tasks.record-merge.status == 'succeeded'", onMissingRef: SKIP },
    // The release waits for it; one that could not be written still lets the
    // lease go and the handoff record the outcome.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 3,
    inputBindings: {
      ...MERGE_OUTCOME_BINDINGS,
      outcome: out('record-merge', 'decision'),
      mergeCommit: out('merge', 'data.sha'),
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
          mergeCommit: bind('mergeCommit'),
          runId: bind('runId'),
        },
      },
    },
  },
];
