import {
  SHEPHERD_ATTEMPT_BUDGET_DEFAULT,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  SHEPHERD_RESPONSE_PRESETS,
  type SkillCatalogEntry,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { REMEDY_QUESTION, REMEDY_QUESTION_NAME } from './localPrShepherdDecisions.js';
import { HANDOFF_READ_TASKS, HANDOFF_WRITE_TASKS } from './localPrShepherdHandoff.js';
import { LEASE_READ_TASKS, leaseTask, RELEASE_TASK } from './localPrShepherdLease.js';
import {
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
  out,
  REPOSITORY,
  runInput,
  SKIP,
} from './localPrShepherdWiring.js';
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

        RELEASE_TASK,

        ...HANDOFF_WRITE_TASKS,
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
