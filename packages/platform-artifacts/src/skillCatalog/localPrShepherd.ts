import {
  MAX_FIRINGS_CAP,
  SHEPHERD_ATTEMPT_BUDGET_DEFAULT,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_SCHEDULE_CRON_DEFAULT,
  SKILL_STARTER_SCHEDULE_VARIABLE,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  SHEPHERD_RESPONSE_PRESETS,
  SHEPHERD_UNLISTED_PERSISTS_AFTER_MS,
  SCHEDULE_RENEWAL_WINDOW,
  type SkillCatalogEntry,
} from '@aflow/schemas';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { ABANDON_TASKS } from './localPrShepherdAbandon.js';
import { REMEDY_QUESTION, REMEDY_QUESTION_NAME } from './localPrShepherdDecisions.js';
import { HANDOFF_READ_TASKS, HANDOFF_WRITE_TASKS } from './localPrShepherdHandoff.js';
import { HAND_OVER_TASKS } from './localPrShepherdHandOver.js';
import { LEASE_READ_TASKS, leaseTask, RELEASE_TASK } from './localPrShepherdLease.js';
import { MERGE_READ_TASKS, MERGE_TASKS, REQUIRED_CHECKS_TASK } from './localPrShepherdMerge.js';
import {
  BASE_MOVED_BRIEF,
  BUMP_BRIEF,
  commission,
  confident,
  FIX_BRIEF,
  firstOfCommissions,
  fromCommission,
  MERGE_BRIEF,
  REMEDY,
  REGISTRY_HOSTS,
  REMEDY_CHANGE_JUDGE,
  REMEDY_CHANGE_TASK,
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
  GITHUB_READ_PROJECTION,
  HEAD_REF,
  handoffBindings,
  handoffValue,
  LEASE_TAKERS,
  OURS,
  optionalPart,
  out,
  outputFields,
  REPOSITORY,
  runInput,
  SKIP,
  text,
} from './localPrShepherdWiring.js';
import { RENEWAL_TASKS, SCHEDULE_ID_SCHEMA, SCHEDULE_INPUT } from './localPrShepherdRenewal.js';
import {
  LAST_TENDED,
  NOTE_UNLISTED_TASK,
  READ_TURN_TASK,
  REMEMBER_TURN_TASK,
} from './localPrShepherdTurn.js';
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

/**
 * What the rules read, field by field (`SHEPHERD_RULES`): the decision's state
 * holds those and nothing a read returned beside them — no response headers,
 * no pull request body, no list past its count, no run's tasks — so its size
 * is bounded by the rules, not by what GitHub or the ledger answered. A test
 * holds every `state.` path the rules read to one bound here.
 */
const DECIDE_STATE = {
  folder: outputFields('folder', 'read-folder', [
    'origin',
    'branchPolicy.branchPrefix',
    'branchPolicy.pushApproval',
    'branchPolicy.mergePosture',
  ]),
  aim: outputFields('aim', 'aim', ['decision']),
  candidates: outputFields('candidates', 'list-prs', ['statusCode', 'data.count']),
  turn: outputFields('turn', 'read-turn', ['dataJson.unlistedAtMs']),
  pr: outputFields('pr', 'read-pr', [
    'statusCode',
    'data.ours',
    'data.state',
    'data.handsOff',
    'data.draft',
    'data.headSha',
    'data.mergeable',
  ]),
  checks: outputFields('checks', 'read-pr-checks', [
    'statusCode',
    'data.state',
    'data.firstFailing.id',
    'data.required.state',
  ]),
  base: outputFields('base', 'read-base', ['sha']),
  pinned: outputFields('pinned', 'read-pr-handoff-pinned', ['statusCode']),
  lease: outputFields('lease', 'read-in-flight-lease', [
    'dataJson.runId',
    'dataJson.takenAtMs',
    'dataJson.decision',
  ]),
  leaseOwner: outputFields('leaseOwner', 'read-lease-owner', ['run.status']),
  publications: outputFields('publications', 'read-in-flight-publications', ['runs[0]']),
  commissions: outputFields('commissions', 'read-in-flight-commissions', ['runs[0]']),
  planNode: outputFields('planNode', 'read-in-flight-node', ['complete', 'runs[0]', 'runs[1]']),
  reviews: outputFields(
    'reviews',
    'read-pr-reviews',
    ['complete', 'changesRequestedBy[0]'],
    'data',
  ),
  publication: outputFields(
    'publication',
    'read-publication-review',
    ['overrideCheck', 'pushDecision'],
    'result.output',
  ),
  publicationReview: outputFields(
    'publicationReview',
    'read-publication-review',
    ['verdict', 'reviewed.at'],
    'taskOutput.output',
  ),
  publicationMerge: outputFields(
    'publicationMerge',
    'read-publication-merge',
    ['baseMerge.commit', 'baseMerge.branchCommit'],
    'taskOutput.output',
  ),
};

/** What the Helmsman needs once it has chosen the skill: carried as the skill's usage pitfalls. */
const SHEPHERD_PITFALLS: string[] = [
  `When it merges: only where the folder's merge posture, \`mergePosture\` beside the push approval, is \`when-green\` — \`never\` is the default, and leaves every merge to the operator. Then a green pull request is merged by squash, pinned to the head it read, when every check the base branch requires — by its rulesets or its classic protection — passed on that head, no person's standing review requests changes, and GitHub says the head merges into its base. The publication's review must approve the head, or its \`overrideCheck\` must be \`operator\`, recorded with \`pushDecision: ask\` at the push approval. Each condition that does not hold leaves it, saying which; a mergeability GitHub has not computed yet is read again next pass, never merged on. The merge asks the operator's approval of exactly that request, as every merge does; a declined or refused merge of a head is not asked for again until a push moves it. One refusal is not of the head: GitHub answering 405 \`Base branch was modified\` because another pull request merged first, while the head, read again, is still the one pinned and green. That merge is sent once more in the same pass, and if GitHub refuses it again the pass hands back \`merge\` with nothing recorded against the head, so the next pass asks again.`,
  `What it needs: the connected folder, \`bindingId\`, connected with a publish prefix and an \`origin\` on GitHub, and the GitHub connection for the space. \`pullNumber\` aims a pass at one pull request, which must still be one the loop opened; without it a pass tends the one after the pull request the last such pass tended, so passes on a schedule take them in turn. \`attemptBudget\` is how many failures of one pull request it acts on before it stops — ${String(SHEPHERD_ATTEMPT_BUDGET_DEFAULT)} unless named.`,
  `When it stops: a pull request whose budget is spent and whose CI fails again is \`abandon\`: the handoff comment says why, and one Action Center item asks a person to take it — one per head, however many passes find it so. A push that moves the head is read again.`,
  `What it hands to the agent: a pass that ends on a case its rules cannot act on — GitHub refused the merge for anything but a base that moved, the head does not merge into its base while CI has not failed on it and the shepherd would merge it, reviews or check runs past the one page a pass reads, or a repository whose open pull requests the connection has refused to list on every pass for ${String(SHEPHERD_UNLISTED_PERSISTS_AFTER_MS / 60_000)} minutes — starts a Helmsman conversation on it, carrying what the pass read, what it decided and why, and what the handoff records as tried, for the Helmsman to decide and act on with the skills it has. A read that failed once is read again by the next pass, and a draft, or a folder whose merge is the operator's, stays with them. A case is handed over once: a pull request's once per head and case, so a push that moves the head is a new case, and so is another case on the same head; a repository's once until a pass lists its pull requests again. A case on a branch a live Helmsman conversation drives is not handed over: a publication of the branch that conversation started makes it the branch's owner, and two publications on one branch refuse each other. The pass says so in \`handOverReason\`, and a pass after the owner has ended hands the case over.`,
  `On a pull request's event (Plan 339 D4): the Helmsman conversation that started the publication opening a pull request owns it. The platform wakes that conversation on each \`pull_request.changed\` of the pull request — checks green, merged, conflicting, changes requested — and the owner runs a pass aimed at it with \`pullNumber\`, which takes no turn. The pass merges a green head where the posture allows, and commissions the merge round on a conflict. Once it has merged, the owner closes the plan step and moves the folder where the folder's merge is not the operator's. An owner that has ended is forgotten, and the schedule's sweep tends its pull request.`,
  `On a schedule — the fallback sweep: passes overlap safely. Two on one pull request meet at its branch's lease, and the second acts on nothing. The schedule renews itself: a pass handed \`${SCHEDULE_INPUT}\` — the Local PR Shepherd agent hands it the schedule that started it — reads that schedule, and where it is active and within ${String(SCHEDULE_RENEWAL_WINDOW)} firings of its cap creates its successor, the same agent, cron, input and expiry, which takes over from it. A schedule has one successor however many passes find it due, one its owner paused is not renewed, and the chain ends at the schedule's expiry.`,
  `What it never does: approve or close a pull request, merge one where the posture is \`never\` or without the operator's approval, or push other than through Local Publish under the folder's push approval. A pull request a person opened, or one labelled \`${SHEPHERD_HANDS_OFF_LABEL}\`, is left untouched; a branch with a publication or a commission in flight, or whose pull request's plan node has any run in flight serving it, whoever started it, is \`wait\`; the same check run is acted on once, unless the base branch moved after its remedy — GitHub runs no check again for that, and a re-run would read the old base, so the base is merged in and published.`,
  `With the result: report the decision and its reason; for a fix, the publication's run — its pull request, and whether it pushed or is waiting at its approval; for a merge, whether it merged, waits at its approval, or was declined or refused.`,
  `A pass is one run of the skill over a folder: start the Local PR Shepherd agent, which starts one on each folder it was written with, or workflow.run.start local-pr-shepherd with one folder’s bindingId — and pullNumber to aim it at one pull request. Its decision and reason are in its result and in the handoff comment on the pull request.`,
  `To run it on a schedule: agent.schedule.create, action start_run, target { kind: 'custom-agent', agentId } of the Local PR Shepherd agent — catalog.tool.search with query 'local-pr-shepherd' and sources ['agent'] returns that target, and agent.manage.get { agentSlug: 'local-pr-shepherd' } reads it — cron '${SHEPHERD_SCHEDULE_CRON_DEFAULT}' unless the operator names another, and input { input: 'tend', config: { ${SKILL_STARTER_SCHEDULE_VARIABLE}: { $schedule: 'id' } } }, which hands each pass the schedule that started it. The schedule is a fallback sweep for the pull requests no conversation holds. A firing starts nothing while no loop pull request is open, or while each open one is held by its owner or by a waiter whose window closes before the next firing. A firing that starts tends the next pull request in turn, and firings that overlap meet at the branch's lease.`,
  `The shepherd’s schedule renews itself: it fires at most ${String(MAX_FIRINGS_CAP)} times, and a pass within ${String(SCHEDULE_RENEWAL_WINDOW)} firings of that creates its successor, which takes over. Create it once; it runs until its expiresAt (30 days unless set) or until the operator pauses it. A Local PR Shepherd agent written before this refuses the ${SKILL_STARTER_SCHEDULE_VARIABLE} config: delete it, then update the bundle from the Store to write it again.`,
  `The shepherd never approves or closes. A fix it publishes waits at Local Publish’s approval where the folder’s posture asks; a merge, only under the folder’s merge posture when-green (mergePosture in the machine block), waits at the merge’s own write approval. Both approvals are the operator’s, in the Action Center.`,
  `A space with the GitHub definition from an earlier Local Publish needs Local Publish updated from the Store for the endpoints the shepherd reads — the jobs of a run, the end of a job’s log, a branch and its rules, and the merge pinned to a head.`,
];

const LOCAL_PR_SHEPHERD: SkillCatalogEntry = {
  catalogId: 'local-pr-shepherd',
  version: 22,
  name: 'Local PR Shepherd',
  tagline:
    "Tend the pull requests the loop opened: read their CI, fix and publish a red check through Local Publish, and merge a green one where the folder's merge posture allows — never approving or closing.",
  description: `One pass over the pull requests Local Publish opened from a connected folder. It reads the folder, the loop's open pull requests under its publish prefix, the head's check runs, its own handoff comment and the space's work in flight on the branch, and decides by rules — \`fix\`, \`merge\`, \`wait\`, \`abandon\` or \`leave\`, with the reason. A red check no rule holds back is fixed: the remedy question reads the failing jobs' logs and picks re-running the jobs, a fix commission, a dependency bump or a merge round, and anything it is not sure of is the fix commission. The fix is commissioned on the branch with its base merged in and published through Local Publish, which asks the operator exactly where it would when started by hand. Every pass leaves its record in the handoff comment.`,
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
        "One pass over the loop's open pull requests from a connected folder: read the folder, the pull request, its checks, its handoff and the work in flight on its branch — and, where the folder merges, the base branch's required checks, the people's reviews and the publication's verdict; decide by rules; for a red check, take the lease, read the failing jobs' logs, ask which remedy they want, re-run the jobs or commission the fix on the branch and publish it through Local Publish; for a green one the posture allows, take the lease and merge it by squash on the operator's approval; hand a case its rules cannot act on to the Helmsman, once, with what the pass read; release the lease and write the handoff; and renew the schedule that started the pass before its firings run out.",
      usage: {
        whenToUse: [
          'Tending the pull requests Local Publish opened from a connected folder — "shepherd the pull requests", "fix the red CI on the loop\'s pull requests": it reads their CI, fixes a red check through Local Publish, and merges a green one where the folder\'s merge posture allows',
          "Keeping those pull requests moving without a hand: the owner of a pull request runs a pass aimed at it on each of its events, and the Local PR Shepherd agent's schedule sweeps the ones no conversation holds",
        ],
        whenNotToUse: [
          `A pull request a person opened, or one labelled \`${SHEPHERD_HANDS_OFF_LABEL}\` — it is left untouched`,
          'Approving or closing a pull request — it never does either',
          'A change not yet published — that is Commission Change, then Publish Local Changes',
        ],
        next: [
          {
            operation: 'agent.schedule.create',
            when: "To tend on a schedule: target { kind: 'custom-agent', agentId } of the Local PR Shepherd agent, which catalog.tool.search with sources ['agent'] finds by its slug local-pr-shepherd — its pitfalls give the cron and input.",
          },
        ],
        pitfalls: SHEPHERD_PITFALLS,
      },
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
        {
          id: SCHEDULE_INPUT,
          required: false,
          description:
            'The schedule that started the pass, handed on by the Local PR Shepherd agent: the pass renews it as its firings run out. Absent, the pass renews nothing.',
          schema: SCHEDULE_ID_SCHEMA,
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
              [SCHEDULE_INPUT]: {
                kind: 'run_input' as const,
                bindAs: SCHEDULE_INPUT,
                path: SCHEDULE_INPUT,
                schema: SCHEDULE_ID_SCHEMA,
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

        ...RENEWAL_TASKS,

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
          outputProjection: GITHUB_READ_PROJECTION,
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
          outputProjection: GITHUB_READ_PROJECTION,
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
          outputProjection: GITHUB_READ_PROJECTION,
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
            ...Object.fromEntries(
              Object.values(DECIDE_STATE).flatMap((view) => Object.entries(view.bindings)),
            ),
            // The pin is held whole: a read that failed leaves no pin, which
            // a rule tells from one that found none. It is the shepherd's own
            // small record.
            pin: out('read-handoff-pin'),
            ...handoffBindings('handoff'),
            staleBefore: { kind: 'clock' as const, offsetMs: -SHEPHERD_LEASE_STALE_AFTER_MS },
            unlistedBefore: {
              kind: 'clock' as const,
              offsetMs: -SHEPHERD_UNLISTED_PERSISTS_AFTER_MS,
            },
            runId: { kind: 'run_id' as const },
            budget: runInput('attemptBudget'),
            requiredRulesStatus: out('read-required-rules', 'statusCode'),
            requiredProtectionStatus: out(REQUIRED_CHECKS_TASK, 'statusCode'),
            reviewsStatus: out('read-pr-reviews', 'statusCode'),
          },
          context: ctx('workflow.run.decide'),
          inputTemplate: {
            state: {
              ...Object.fromEntries(
                Object.entries(DECIDE_STATE).map(([name, view]) => [name, view.value]),
              ),
              requiredRulesStatus: bind('requiredRulesStatus'),
              requiredProtectionStatus: bind('requiredProtectionStatus'),
              reviewsStatus: bind('reviewsStatus'),
              pin: bind('pin'),
              // The handoff record is the shepherd's own, a few short fields.
              handoff: handoffValue('handoff'),
              staleBefore: bind('staleBefore'),
              unlistedBefore: bind('unlistedBefore'),
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
          "Have the machine's coding agent bump the package a dependency audit flagged to its fixed version — through `resolutions` where it is transitive — on the pull request's branch with its base merged in. A run the boundary kept from the package registry fails, naming the host.",
          BUMP_BRIEF,
          REGISTRY_HOSTS,
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

        REMEDY_CHANGE_JUDGE,

        {
          taskId: 'publish',
          name: 'Publish the remedy through Local Publish',
          goal: "Publish the change of whichever remedy commission ran — the fix, the dependency bump, the merge round or the merge round over a moved base — onto the pull request's branch through Local Publish and wait for it to end: its checks, its scan, its review, the decision on the review's findings and its approval as the folder's posture has them — it asks the operator exactly where it would when started by hand, and follows the decision.",
          type: 'operation' as const,
          operation: 'workflow.run.start',
          dependsOn: [REMEDY_CHANGE_TASK],
          when: {
            expression: `tasks.${REMEDY_CHANGE_TASK}.output.decision == 'fix'`,
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

        NOTE_UNLISTED_TASK,

        ...HAND_OVER_TASKS,

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
          variableId: 'remedyDecision',
          name: 'Remedy outcome',
          description:
            'What came of the remedy commission that ran: fix where it left a change for Local Publish, wait where it failed or left nothing to publish — the pass then waited, whatever it decided.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'remedyReason',
          name: 'Remedy reason',
          description: 'Why, as the judgement of the remedy says it.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'publicationRunId',
          name: 'Publication',
          description:
            'The Local Publish run that published the remedy — fix, bump or merge round — where this pass made one.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'handOver',
          name: 'Hand-over judgement',
          description:
            'Where the pass ended on a case it hands over: hand_over where a new Helmsman conversation takes it, or defer where a live conversation drives the branch.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'handOverReason',
          name: 'Hand-over reason',
          description: 'Why, as the hand-over judgement says it.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'handOverScheduleId',
          name: 'Hand-over',
          description:
            'The schedule that starts the Helmsman conversation this pass handed its case to, where it handed one over.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'decision',
        guidance:
          'Report the decision and its reason; where remedyDecision is wait, the remedy published nothing and remedyReason says why. With publicationRunId, the remedy went through Local Publish: its pull request, and whether it pushed, waits at its approval, or kept the branch local on fix_before_merge (afterReview, reviewRunId). On merge: merged, waiting at the operator’s approval, declined or refused. With handOverScheduleId, the case went to the Helmsman. With handOver defer, handOverReason says why.',
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
        "Run one pass of the Local PR Shepherd over a connected folder's pull requests: it reads CI, decides by rules, and fixes a red check through Local Publish. Its usage says how to start and schedule it.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 321 P1, P2, P2b; Plan 315. Typed reads, projected to the fields the rules read, then workflow.run.decide: first rule that holds decides, else fix; merge follows every wait and needs GitHub to say the head merges. Fix and merge take the lease. Fix reads failing jobs and logs; the remedy question routes to re-run, fix, bump or merge round (unsure: fix), published via Local Publish. Merge is squash pinned to the head behind its write approval; a base-moved refusal is resent once, then handed back. Abandon raises one Action Center item per head. A case the rules cannot act on is claimed once per head and case (per turn, for a repository long unlisted) and handed to the Helmsman by a one-firing schedule; a failed read waits. The pin keeps attempt state and each remedy base. Nothing approves or closes; only merge merges. A scheduled pass renews its schedule near the cap.',
  },
};

export { LOCAL_PR_SHEPHERD };
