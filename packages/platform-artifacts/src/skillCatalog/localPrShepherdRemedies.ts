import {
  HOST_HARNESS_TIMEOUT_MAX_MS,
  PullRequestGapsSchema,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { REMEDY_QUESTION_NAME } from './localPrShepherdDecisions.js';
import { MERGE_ROUND_AFTER_BASE_MOVED } from './localPrShepherdRules.js';
import {
  bind,
  ctx,
  handoffBindings,
  handoffValue,
  LEASE_TAKERS,
  out,
  runInput,
} from './localPrShepherdWiring.js';

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
- Before you return, run the repository's own checks over what you touched — its tests on the touched files, its type check, its linter and formatter — and the guards its own check runs over the whole tree (in Aflow's repository, \`node --import tsx scripts/large-files/cli.ts check\` and \`node --conditions=ts-source --import tsx scripts/context-budget/cli.ts check\`). Fix what fails before you return, and report what they said.
- Start no process that outlives the work: no dev server, watcher or daemon.
- Write nothing under \`.aflow/\`.
- Report, as your result, the commit message for this round and any gaps.`;

export const FIX_BRIEF = `CI failed on this pull request's branch, and this checkout is that branch with its base merged in. Make CI pass.

The inputs name the pull request, the failing checks, the jobs that failed and the end of each failing job's log, and what earlier rounds on this pull request did. Read the logs first: the failure and its assertion are in them. Fix the cause in the change, not the test's expectation, unless the expectation is what the change was meant to alter. Where the merge of the base left conflicts, resolve them as part of the fix.

${STANDING_RULES}`;

export const BUMP_BRIEF = `A dependency audit failed on this pull request's branch: an advisory against a package the repository resolves, which arrived since the branch was last green. This checkout is that branch with its base merged in. Clear the advisory.

The inputs name the failing jobs and the end of each one's log, where the advisory, the package and the fixed version are. Bump the package to the first version the advisory names as fixed: a direct dependency in its manifest, a transitive one through the root \`resolutions\` field. Install so the lockfile records it, and change nothing else.

${STANDING_RULES}`;

export const MERGE_BRIEF = `This pull request's branch no longer merges cleanly into its base, and CI refused it or failed on it for that reason. This checkout is that branch with its base merged in, and git left what conflicted for you to resolve.

Resolve every conflict so both sides' intent stands, and nothing else: no fix to anything the merge did not touch. The inputs name the pull request and the failing checks.

${STANDING_RULES}`;

export const BASE_MOVED_BRIEF = `CI failed on this pull request's branch, the failure was acted on, and the base branch has moved since. GitHub does not run a pull request's checks again when its base moves, and a re-run of the failed jobs would run on the old base, so the base is merged in to have CI run on it. This checkout is that branch with its base merged in.

Where the merge left conflicts, resolve them so both sides' intent stands; where it left none, change nothing. Fix nothing the merge did not touch: whether the base already clears the failure is for CI to say. The inputs name the pull request, the failing checks and the end of each failing job's log.

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

export function commission(taskId: string, name: string, goal: string, brief: string) {
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

export const COMMISSIONS = [
  'fix',
  'bump-dependency',
  'merge-round',
  MERGE_ROUND_AFTER_BASE_MOVED,
] as const;

function commissionBinding(taskId: string, path: string): string {
  return `${taskId}_${path}`.replace(/[^A-Za-z0-9]/g, '_');
}

/** Each commission's value at `path`; at most one is present, since one route enables each. */
export function fromCommission(path: string) {
  return Object.fromEntries(
    COMMISSIONS.map((taskId) => [commissionBinding(taskId, path), out(taskId, path)]),
  );
}

export function firstOfCommissions(path: string) {
  return { $firstOf: COMMISSIONS.map((taskId) => bind(commissionBinding(taskId, path))) };
}

export const REMEDY = `answers.${REMEDY_QUESTION_NAME}`;

export function confident(option: string) {
  return {
    allOf: [`output.${REMEDY}.value == '${option}'`, `output.${REMEDY}.decided == true`],
  };
}
