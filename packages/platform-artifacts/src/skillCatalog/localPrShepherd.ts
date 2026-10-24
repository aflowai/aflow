import {
  SHEPHERD_ATTEMPT_BUDGET_DEFAULT,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  SHEPHERD_RESPONSE_PRESETS,
  type SkillCatalogEntry,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { ABANDON_TASKS } from './localPrShepherdAbandon.js';
import { REMEDY_QUESTION, REMEDY_QUESTION_NAME } from './localPrShepherdDecisions.js';
import { HANDOFF_READ_TASKS, HANDOFF_WRITE_TASKS } from './localPrShepherdHandoff.js';
import { LEASE_READ_TASKS, leaseTask, RELEASE_TASK } from './localPrShepherdLease.js';
import { MERGE_READ_TASKS, MERGE_TASKS, REQUIRED_CHECKS_TASK } from './localPrShepherdMerge.js';
import {
  BASE_MOVED_BRIEF,
  BUMP_BRIEF,
  COMMISSIONS,
  commission,
  confident,
  FIX_BRIEF,
  firstOfCommissions,
  fromCommission,
  MERGE_BRIEF,
  REMEDY,
} from './localPrShepherdRemedies.js';
import {
  AIM_OTHERWISE,
  AIM_RULES,
  DECIDED_BASE_MOVED,
  DECIDED_OTHER_THAN_BASE_MOVED,
  MERGE_ROUND_AFTER_BASE_MOVED,
  REMEDY_TAKEN_OTHERWISE,
  REMEDY_TAKEN_RULES,
  SHEPHERD_OTHERWISE,
  SHEPHERD_RULES,
} from './localPrShepherdRules.js';
import {
  BASE_REF,
  bind,
  ctx,
  DECIDED_FIX,
  github,
  HEAD_REF,
  handoffBindings,
  handoffValue,
  LEASE_TAKERS,
  OURS,
  optionalPart,
  out,
  REPOSITORY,
  runInput,
  SKIP,
  text,
} from './localPrShepherdWiring.js';
import { LAST_TENDED, READ_TURN_TASK, REMEMBER_TURN_TASK } from './localPrShepherdTurn.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';

/**
 * Local PR Shepherd (Plan 321): one pass over the pull requests the loop
 * opened from a connected folder. It reads, decides by rules, and — for a red
 * check no rule holds back — commissions the fix on the branch and publishes
 * it through Local Publish. Every decision is read from data: the rules are
 * `workflow.run.decide`, and the one judgement no rule can make, which remedy
 * a log wants, is a routed decision whose abstention is the fix commission.
 */

const BINDING_ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
const PULL_NUMBER_SCHEMA = {
  type: 'string',
  pattern: '^[1-9][0-9]{0,9}$',
  description: 'The number of one pull request, as digits.',
};
const ATTEMPT_BUDGET_SCHEMA = { type: 'integer', minimum: 1, maximum: 10 };

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
  version: 14,
  name: 'Local PR Shepherd',
  tagline:
    "Tend the pull requests the loop opened: read their CI, fix and publish a red check through Local Publish, and merge a green one where the folder's merge posture allows — never approving or closing.",
  description: `One pass over the pull requests Local Publish opened from a connected folder. It reads the folder, the loop's open pull requests under its publish prefix, the head's check runs, its own handoff comment and the space's work in flight on the branch, and decides by rules — \`fix\`, \`merge\`, \`wait\`, \`abandon\` or \`leave\`, with the reason. A red check no rule holds back is fixed: the remedy question reads the failing jobs' logs and picks re-running the jobs, a fix commission, a dependency bump or a merge round, and anything it is not sure of is the fix commission. The fix is commissioned on the branch with its base merged in and published through Local Publish, which asks the operator exactly where it would when started by hand. Every pass leaves its record in the handoff comment.

**When it merges**: only where the folder's merge posture, \`mergePosture\` beside the push approval, is \`when-green\` — \`never\` is the default, and leaves every merge to the operator. Then a green pull request is merged by squash, pinned to the head it read, when every check the base branch requires — by its rulesets or its classic protection — passed on that head, the Local Code Review of the publication that pushed that head returned \`approve\` for it, and no person's standing review requests changes. Each condition that does not hold leaves it, saying which. The merge asks the operator's approval of exactly that request, as every merge does; a declined or refused merge of a head is not asked for again until a push moves it. One refusal is not of the head: GitHub answering 405 \`Base branch was modified\` because another pull request merged first, while the head, read again, is still the one pinned and green. That merge is sent once more in the same pass, and if GitHub refuses it again the pass hands back \`merge\` with nothing recorded against the head, so the next pass asks again.

**What it needs**: the connected folder, \`bindingId\`, connected with a publish prefix and an \`origin\` on GitHub, and the GitHub connection for the space. \`pullNumber\` aims a pass at one pull request, which must still be one the loop opened; without it a pass tends the one after the pull request the last such pass tended, so passes on a schedule take them in turn. \`attemptBudget\` is how many failures of one pull request it acts on before it stops — ${String(SHEPHERD_ATTEMPT_BUDGET_DEFAULT)} unless named.

**When it stops**: a pull request whose budget is spent and whose CI fails again is \`abandon\`: the handoff comment says why, and one Action Center item asks a person to take it — one per head, however many passes find it so. A push that moves the head is read again.

**On a schedule**: passes overlap safely. Two on one pull request meet at its branch's lease, and the second acts on nothing.

**What it never does**: approve or close a pull request, merge one where the posture is \`never\` or without the operator's approval, or push other than through Local Publish under the folder's push approval. A pull request a person opened, or one labelled \`${SHEPHERD_HANDS_OFF_LABEL}\`, is left untouched; a branch with a publication or a commission in flight, or whose pull request's plan node has any run in flight serving it, whoever started it, is \`wait\`; the same check run is acted on once, unless the base branch moved after its remedy — GitHub runs no check again for that, and a re-run would read the old base, so the base is merged in and published.

**With the result**: report the decision and its reason; for a fix, the publication's run — its pull request, and whether it pushed or is waiting at its approval; for a merge, whether it merged, waits at its approval, or was declined or refused.`,
  tags: ['coding', 'github', 'pull-requests', 'ci', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        "GitHub REST API — list and read the loop's pull requests, their check runs, reviews and comments, the base branch's required checks, a failing run's jobs and the end of a job's log, re-run failed jobs, write the handoff comment, and merge where the folder's posture allows.",
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
        'getBranchRules',
        'getBranch',
        'listPullRequestReviews',
        'mergePullRequest',
      ],
      authKind: 'bearer',
      setupNote:
        "Bind the GitHub connector for the space with a token that reads pull requests, checks, branches and Actions and writes comments — and merges pull requests, where a folder's merge posture is `when-green`. A job's log is served from a signed URL on Azure blob storage, which `getJobLogs` follows without the token; the binding allows no host but api.github.com.",
    },
  ],
  bundle: {
    workflow: {
      slug: 'local-pr-shepherd',
      name: 'Local PR Shepherd',
      description:
        "One pass over the loop's open pull requests from a connected folder: read the folder, the pull request, its checks, its handoff and the work in flight on its branch — and, where the folder merges, the base branch's required checks, the people's reviews and the publication's verdict; decide by rules; for a red check, take the lease, read the failing jobs' logs, ask which remedy they want, re-run the jobs or commission the fix on the branch and publish it through Local Publish; for a green one the posture allows, take the lease and merge it by squash on the operator's approval; release the lease and write the handoff.",
      goal: "Keep the loop's pull requests moving through CI without a hand: a red check is fixed and pushed through Local Publish under the folder's posture, acted on once — again only where the base moved after its remedy, by merging the base in — within a budget, and never where a person or other work holds the branch; a green one is merged only where the folder's merge posture allows and the operator approves — with every pass recorded on the pull request.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'pass-recorded',
          name: 'Pass decided and recorded',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The pass decided from what it read — fix, merge, wait, abandon or leave, with the reason — and acted only on fix or merge: a remedy went through Local Publish, a merge was by squash on the head read and on the operator's approval, nothing was approved or closed, the lease was released, and the handoff comment holds the record.",
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
            "Aims the pass at one pull request, by its number as digits. It is tended only where Local Publish opened it under the folder's prefix; absent, the pass tends such pull requests in turn — the one after the pull request the last unaimed pass tended.",
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
          goal: 'Read, from the machine holding the folder, the branch prefix its pushes are held to, its push approval and merge posture, and the GitHub repository its `origin` fetches from.',
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

        // A guard reads task outputs, never run inputs: whether the pass is
        // aimed reaches the list and the read through this task.
        {
          taskId: 'aim',
          name: 'Read whether the pass is aimed',
          goal: 'Decide whether this pass was aimed at one pull request by its number, which is then read directly, or tends the loop’s open pull requests in turn, which are then listed.',
          type: 'operation' as const,
          operation: 'workflow.run.decide',
          when: {
            allOf: [
              'tasks.read-folder.output.origin.owner != null',
              'tasks.read-folder.output.branchPolicy.branchPrefix != null',
            ],
            onMissingRef: SKIP,
          },
          retryability: 'safe' as const,
          inputBindings: { pullNumber: runInput('pullNumber') },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: { pullNumber: bind('pullNumber') },
            rules: AIM_RULES,
            otherwise: AIM_OTHERWISE,
          },
        },

        READ_TURN_TASK,

        {
          taskId: 'list-prs',
          name: "List the loop's open pull requests",
          goal: "With the pass aimed at none, list the repository's open pull requests and keep those Local Publish opened under the folder's prefix — its marker closes their body — the ones labelled hands-off last, each in turn: the one after the pull request the last such pass tended first.",
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: [READ_TURN_TASK.taskId],
          when: { expression: "tasks.aim.output.decision == 'discover'", onMissingRef: SKIP },
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            prefix: out('read-folder', 'branchPolicy.branchPrefix'),
            lastTended: LAST_TENDED,
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
              $concat: [
                `${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`,
                bind('prefix'),
                optionalPart(':', text('lastTended')),
              ],
            },
          ),
        },

        {
          taskId: 'read-pr',
          name: 'Read the pull request',
          goal: "Read the pull request the pass was aimed at, or else the first of those listed, as it stands now: its head, its base, its labels, whether it still carries the loop's marker on a branch under the prefix, and whether it merges into its base.",
          type: 'operation' as const,
          operation: 'api.http.call',
          // An aimed pull request is read by its number, wherever it would
          // sit in a list of the repository's open ones.
          when: {
            anyOf: ["tasks.aim.output.decision == 'aimed'", 'tasks.list-prs.output.data.count > 0'],
            onMissingRef: SKIP,
          },
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            prefix: out('read-folder', 'branchPolicy.branchPrefix'),
            aimed: runInput('pullNumber'),
            listed: out('list-prs', 'data.pullRequests[0].number'),
          },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'getPullRequest',
            {
              owner: bind('owner'),
              repo: bind('repo'),
              pull_number: { $firstOf: [bind('aimed'), bind('listed')] },
            },
            { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequest}:`, bind('prefix')] },
          ),
        },

        REMEMBER_TURN_TASK,

        ...MERGE_READ_TASKS,

        {
          taskId: 'read-pr-checks',
          name: "Read the head's check runs",
          goal: "Read the check runs on the pull request's head: whether CI fails, runs, passes or stopped, the failing check run a pass acts on, and — where the folder merges — whether each check the base branch requires passed on it.",
          type: 'operation' as const,
          operation: 'api.http.call',
          when: OURS,
          retryability: 'safe' as const,
          inputBindings: {
            ...REPOSITORY,
            sha: out('read-pr', 'data.headSha'),
            // Only a read that returned the branch carries the set; otherwise
            // the checks are read with none, and judge none.
            required: out(REQUIRED_CHECKS_TASK, 'data.encoded'),
          },
          context: ctx('api.http.call'),
          inputTemplate: github(
            'listCheckRuns',
            { owner: bind('owner'), repo: bind('repo'), ref: bind('sha'), per_page: 100 },
            {
              $firstOf: [
                { $concat: [`${SHEPHERD_RESPONSE_PRESETS.checkRuns}:`, bind('required')] },
                SHEPHERD_RESPONSE_PRESETS.checkRuns,
              ],
            },
          ),
        },

        {
          taskId: 'read-base',
          name: 'Read where the base branch stands',
          goal: "Where CI fails on the head, read the commit the pull request's base branch points at now: a failure acted on already is acted on again where the base has moved since the remedy, which GitHub runs no check again for.",
          type: 'operation' as const,
          operation: 'api.http.call',
          when: {
            allOf: [...OURS.allOf, "tasks.read-pr-checks.output.data.state == 'failing'"],
            onMissingRef: SKIP,
          },
          // A base that could not be read is a base not known to have moved.
          optional: true,
          retryability: 'safe' as const,
          inputBindings: { ...REPOSITORY, ...BASE_REF },
          context: ctx('api.http.call'),
          inputTemplate: github('getBranch', {
            owner: bind('owner'),
            repo: bind('repo'),
            branch: bind('baseRef'),
          }),
          outputProjection: {
            statusCode: { path: 'statusCode', onMissing: 'error' as const },
            sha: { path: 'data.commit.sha', onMissing: 'null' as const },
          },
        },

        ...HANDOFF_READ_TASKS,

        ...LEASE_READ_TASKS,

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

        // Plan 322 P2: the branch's work as the plan holds it — every run
        // serving the pull request's node, whatever its workflow or input. A
        // skill never reads the plan through plan.* (322 D3); the run ledger
        // joins it.
        {
          taskId: 'read-in-flight-node',
          name: "Read the work in flight on the pull request's plan node",
          goal: 'List the runs still in flight — running, or paused — serving the plan node the pull request is linked to, or any node under it, whatever their workflow and whoever started them.',
          type: 'operation' as const,
          operation: 'workflow.run.list',
          when: OURS,
          // A read that failed binds as absent, which the rules decide as
          // `wait`: the node's work is then unknown, not none.
          optional: true,
          retryability: 'safe' as const,
          inputBindings: { url: out('read-pr', 'data.url') },
          context: ctx('workflow.run.list'),
          inputTemplate: { servingNodeOfPullRequest: bind('url') },
        },

        {
          taskId: 'decide',
          name: 'Decide by rules',
          goal: 'Decide this pass — fix, merge, wait, abandon or leave, with the reason — by rules over what the reads returned, with no model: the first rule that holds decides, and fix where none does.',
          type: 'operation' as const,
          operation: 'workflow.run.decide',
          retryability: 'safe' as const,
          inputBindings: {
            folder: out('read-folder'),
            aim: out('aim'),
            candidates: out('list-prs'),
            pr: out('read-pr'),
            checks: out('read-pr-checks'),
            base: out('read-base'),
            pin: out('read-handoff-pin'),
            pinned: out('read-pr-handoff-pinned'),
            ...handoffBindings('handoff'),
            lease: out('read-in-flight-lease'),
            leaseOwner: out('read-lease-owner'),
            staleBefore: { kind: 'clock' as const, offsetMs: -SHEPHERD_LEASE_STALE_AFTER_MS },
            publications: out('read-in-flight-publications'),
            commissions: out('read-in-flight-commissions'),
            planNode: out('read-in-flight-node'),
            runId: { kind: 'run_id' as const },
            budget: runInput('attemptBudget'),
            requiredRules: out('read-required-rules', 'data'),
            requiredRulesStatus: out('read-required-rules', 'statusCode'),
            requiredProtection: out(REQUIRED_CHECKS_TASK, 'data'),
            requiredProtectionStatus: out(REQUIRED_CHECKS_TASK, 'statusCode'),
            reviews: out('read-pr-reviews', 'data'),
            reviewsStatus: out('read-pr-reviews', 'statusCode'),
            publicationReview: out('read-publication-review', 'taskOutput.output'),
          },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: {
              requiredRules: bind('requiredRules'),
              requiredRulesStatus: bind('requiredRulesStatus'),
              requiredProtection: bind('requiredProtection'),
              requiredProtectionStatus: bind('requiredProtectionStatus'),
              reviews: bind('reviews'),
              reviewsStatus: bind('reviewsStatus'),
              publicationReview: bind('publicationReview'),
              folder: bind('folder'),
              aim: bind('aim'),
              candidates: bind('candidates'),
              pr: bind('pr'),
              checks: bind('checks'),
              base: bind('base'),
              pin: bind('pin'),
              pinned: bind('pinned'),
              handoff: handoffValue('handoff'),
              lease: bind('lease'),
              leaseOwner: bind('leaseOwner'),
              staleBefore: bind('staleBefore'),
              publications: bind('publications'),
              commissions: bind('commissions'),
              planNode: bind('planNode'),
              runId: bind('runId'),
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
          // Where the base moved after the remedy, the rule names the remedy and nothing is asked.
          when: {
            allOf: [DECIDED_FIX.expression, DECIDED_OTHER_THAN_BASE_MOVED],
            onMissingRef: SKIP,
          },
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
          goal: 'Name the remedy taken — the one the routes took from the remedy question’s answer: re-run, fix, bump, merge round, or a wait on CI; or, where the base moved after the last remedy, the merge round — with the base it was taken against, for the handoff and its pin to record, so the next round is briefed with it.',
          type: 'operation' as const,
          operation: 'workflow.run.decide',
          when: DECIDED_FIX,
          dependsOn: ['classify-failure'],
          retryability: 'safe' as const,
          inputBindings: {
            answer: out('classify-failure', REMEDY),
            rule: out('decide', 'rule'),
            baseSha: out('read-base', 'sha'),
            ...handoffBindings('attempt', 'data.nextAttemptCount'),
          },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: {
              answer: bind('answer'),
              rule: bind('rule'),
              // Empty where the base was not read: the pin then records no
              // base known, which no later pass reads as a base that moved.
              baseSha: { $firstOf: [bind('baseSha'), ''] },
              attempt: handoffValue('attempt'),
            },
            rules: REMEDY_TAKEN_RULES,
            otherwise: REMEDY_TAKEN_OTHERWISE,
          },
          // The round this fix is, read back by the handoff: only a fix makes
          // this record, so only a fix counts as a failure acted on.
          outputProjection: {
            decision: { path: 'decision', onMissing: 'error' as const },
            reason: { path: 'reason', onMissing: 'error' as const },
            round: { fromInput: 'state' },
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
          ...commission(
            MERGE_ROUND_AFTER_BASE_MOVED,
            'Commission the merge round over the moved base',
            "Where the base branch moved after the remedy recorded for the failing check run, have the machine's coding agent merge the base into the pull request's branch, resolving only what conflicts, so its publication has CI run over the moved base — which no re-run of the failed jobs reads.",
            BASE_MOVED_BRIEF,
          ),
          when: { expression: DECIDED_BASE_MOVED, onMissingRef: SKIP },
        },

        {
          taskId: 'publish',
          name: 'Publish the fix through Local Publish',
          goal: "Publish the commission's change onto the pull request's branch through Local Publish and wait for it to end: its checks, its scan, its review, the decision on the review's findings and its approval as the folder's posture has them — it asks the operator exactly where it would when started by hand, and follows the decision.",
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
              // The pull request it publishes onto was opened by an earlier
              // publication, so a fix is a fix round under the rounds rule.
              round: 2,
            },
            wait: 'until_complete',
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'runId', toState: 'publicationRunId' },
          ],
        },

        ...MERGE_TASKS,

        RELEASE_TASK,

        ...HANDOFF_WRITE_TASKS,

        ...ABANDON_TASKS,
      ]),
      stateVariables: [
        {
          variableId: 'decision',
          name: 'Decision',
          description: 'What this pass decided: fix, merge, wait, abandon or leave.',
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
          'Report the decision and its reason. Where publicationRunId is set, the fix went through Local Publish: report its pull request and whether it pushed, waits at its approval, or kept the branch local on fix_before_merge — its afterReview and reviewRunId, from which the fix round is commissioned. On merge, report whether it merged, waits at the merge approval, which is the operator’s, or was declined or refused.',
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
              "A pass decides from what it read and acts only on fix, through Local Publish, or on merge, by squash on the head under the folder's merge posture and the operator's approval — never approving or closing — and leaves its record in the handoff comment.",
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
      'Plan 321 P1, P2, P2b. Typed reads — folder, turn, pull requests, checks, handoff, lease, in-flight runs, and under when-green the required checks, reviews and the head publication verdict — then workflow.run.decide: first rule that holds decides, else fix; a refused read is wait, more check runs than a page is leave, merge follows every wait. Fix and merge take the lease. Fix reads failing jobs and logs; the remedy question routes to re-run, fix, bump or merge round, unsure to fix, published through Local Publish. Merge is squash pinned to the head behind its write approval; a base-moved refusal is sent once more, then handed back. The lease is released after leased work. Abandon claims its head after the handoff, or takes over a claim whose pass ended unanswered, and raises one item only on its claim. The pin keeps the attempt state and each remedy base: a deleted handoff restarts nothing; a base moved since a remedy is merged in. No step approves or closes; only merge merges.',
  },
};

export { LOCAL_PR_SHEPHERD };
