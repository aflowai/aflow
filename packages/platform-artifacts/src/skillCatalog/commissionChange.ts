import {
  HOST_BRANCH_NAME_MAX_LENGTH,
  HOST_HARNESS_TASK_MAX_LENGTH,
  HOST_HARNESS_TIMEOUT_MAX_MS,
  HOST_HARNESS_TIMEOUT_MIN_MS,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  type SkillCatalogEntry,
} from '@aflow/schemas';

/**
 * How long a commission runs when the brief names no time. A slice of the size
 * a brief commissions runs thirty to forty minutes, and the operation's own
 * default ended one before it finished; the ceiling a coding agent may run to
 * is the default here.
 */
const COMMISSION_TIMEOUT_DEFAULT_MS = HOST_HARNESS_TIMEOUT_MAX_MS;

/**
 * The coding agent's turn budget when the brief names none. Every tool call is
 * a turn, and a slice of this size takes several hundred: a cap sized to a
 * guess ends the run while it is still reading.
 */
const COMMISSION_MAX_TURNS_DEFAULT = 600;

/** The run's inputs together, and so the most the task text can carry beside the rest. */
const RUN_INPUTS_KB = MAX_PARENT_INPUTS_SERIALIZED_BYTES / 1024;

const MINUTES = 60_000;

const COMMISSION_CHANGE: SkillCatalogEntry = {
  catalogId: 'commission-change',
  version: 1,
  name: 'Commission Change',
  tagline:
    "Have the machine's own coding agent make a change in a connected repository, and get the change back as a patch.",
  description: `Fits a request to make a change in a repository on the operator's machine — "build this slice", "fix these findings", "now fix the test that broke". A commission hands a brief to the coding agent installed on that machine, which works in an isolated checkout of the connected folder and leaves the folder itself untouched; what it changed comes back as a stored patch. Nothing is committed, pushed or published: publishing the patch is Publish Local Changes, and reviewing it once published is Review Local Changes.

**What it needs**: the connected folder and the brief — the task text, everything the coding agent needs and nothing it has to guess: the files and the lines where they are known, what is wrong and what right looks like, the tests to add, the checks to run and what its result reports. \`base\` is where the checkout starts: \`origin/main\` for new work, the branch's name for a fix appended to a branch with an open pull request. A fix to a branch \`main\` has moved past also takes \`mergeFrom: origin/<base>\`, so the checkout merges it first and the agent resolves what conflicts. A further turn on the same work takes \`continueFrom\`, the \`sessionRef\` the earlier run reported. \`model\`, \`maxTurns\` and \`timeoutMs\` are optional; the budgets are sized for a slice already (${String(COMMISSION_MAX_TURNS_DEFAULT)} turns, ${String(COMMISSION_TIMEOUT_DEFAULT_MS / MINUTES)} minutes) and are named only to change them.

**Start it with \`wait: 'none'\`.** A commission runs for tens of minutes. Started that way it returns the run id at once, the conversation stays free, and the commission's end wakes it with the result. Several commissions may run at once on one machine, each in its own checkout, within the machine's limit on coding agents running together.

**The checks a brief asks for are the folder's own** — its test runner on the touched tests, its type check, its linter, its formatter — run by the coding agent in the commission's checkout, with their output in the result the brief asks for. Nothing else runs them before publication, where the folder's declared checks run again on the commit.

**With the result**: report what changed — \`filesChanged\`, whether the patch \`applies\` where it would be published, and any branch or tag in \`refChanges\`. To publish, start Publish Local Changes with the commission's \`patchRef\`, \`baseSha\` and, where it merged, \`merge.from\`, as they stand — never the \`patch\` text, a copy for reading that is cut short on a large change. To ask for more on the same work, start another commission with \`continueFrom\` set to its \`sessionRef\`.`,
  tags: ['coding', 'commission', 'local', 'developer-tools'],
  bundle: {
    workflow: {
      slug: 'commission-change',
      name: 'Commission Change',
      description:
        "Hand a brief to the coding agent installed on the operator's machine: it works in an isolated checkout of a repository connected as a host folder, starting at the base the brief names, and its change comes back as a stored patch with the base it was made against. One task; nothing is committed, pushed or published.",
      goal: 'Return the change the brief asked for as a stored patch, with the base it was made against, the merge it carries, whether it applies, and the session a further turn continues.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'change-made',
          name: 'Change made',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The coding agent carried out the brief in an isolated checkout of the connected repository, and the change came back as a stored patch against the base it reported, with the connected folder's working tree untouched.",
          },
        },
      ],
      runInputs: [
        {
          id: 'bindingId',
          required: true,
          description: 'The connected folder holding the repository to change.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
        {
          id: 'task',
          required: true,
          description: `The brief, in prose, handed to the coding agent as it stands: what to build or fix, the files and lines where they are known, the tests to add, the folder's own checks to run, and the result to report. It travels in the run's inputs, which are capped at ${String(RUN_INPUTS_KB)} KB together.`,
          schema: { type: 'string', minLength: 1, maxLength: HOST_HARNESS_TASK_MAX_LENGTH },
        },
        {
          id: 'base',
          required: false,
          description:
            "Where the checkout starts — a branch, tag or commit. `origin/main` for new work, fetched first so it is `main` as of now; the branch's name for a fix appended to it. Absent, the checkout starts at the folder's last commit.",
          schema: { type: 'string', minLength: 1, maxLength: HOST_BRANCH_NAME_MAX_LENGTH },
        },
        {
          id: 'mergeFrom',
          required: false,
          description:
            "A branch on one of the folder's remotes, `origin/<base>`, merged into the checkout once it stands at `base` — for a fix to a branch its base has moved past. Only with `base`. The coding agent is told what conflicted and resolves it, and the result reports the merge in `merge`.",
          schema: { type: 'string', minLength: 1, maxLength: HOST_BRANCH_NAME_MAX_LENGTH },
        },
        {
          id: 'continueFrom',
          required: false,
          description:
            'The `sessionRef` an earlier commission reported, to add a turn to that work rather than start afresh: its checkout and everything the coding agent remembers of it are still there. Only the run that started a session can continue it.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          id: 'model',
          required: false,
          description:
            'The model the coding agent runs, spelled as that agent names it. Absent, the model the operator configured on the machine — the right answer unless the brief has a reason to pin one.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          id: 'maxTurns',
          required: false,
          description: `The coding agent's turn budget. Every tool call is a turn, and a slice takes several hundred; absent, ${String(COMMISSION_MAX_TURNS_DEFAULT)}. Name it only to raise it for larger work or to keep a small task small.`,
          schema: { type: 'integer', minimum: 1, default: COMMISSION_MAX_TURNS_DEFAULT },
        },
        {
          id: 'timeoutMs',
          required: false,
          description: `How long the coding agent may run before it is stopped, in milliseconds. Absent, ${String(COMMISSION_TIMEOUT_DEFAULT_MS / MINUTES)} minutes, the most it may run: a slice runs thirty to forty minutes, and a shorter limit has ended one before it finished.`,
          schema: {
            type: 'integer',
            minimum: HOST_HARNESS_TIMEOUT_MIN_MS,
            maximum: HOST_HARNESS_TIMEOUT_MAX_MS,
            default: COMMISSION_TIMEOUT_DEFAULT_MS,
          },
        },
      ],
      tasks: [
        {
          taskId: 'commission',
          name: 'Make the change',
          goal: "Run the coding agent installed on the operator's machine over an isolated checkout of the connected repository at the brief's base, carry out the brief, and return the change as a stored patch. The connected folder's working tree is untouched, and nothing is committed or pushed.",
          type: 'operation' as const,
          operation: 'host.harness.run',
          // A retry would start a second coding agent over the same brief.
          retryability: 'unsafe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            task: { kind: 'run_input' as const, path: 'task' },
            base: { kind: 'run_input' as const, path: 'base' },
            mergeFrom: { kind: 'run_input' as const, path: 'mergeFrom' },
            continueFrom: { kind: 'run_input' as const, path: 'continueFrom' },
            model: { kind: 'run_input' as const, path: 'model' },
            maxTurns: { kind: 'run_input' as const, path: 'maxTurns' },
            timeoutMs: { kind: 'run_input' as const, path: 'timeoutMs' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.harness.run'],
              integrations: [],
            },
          },
          // A run input's `default` documents the value and is never applied,
          // so each budget falls back here when the brief names none.
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            task: { $bind: 'task' },
            base: { $bind: 'base' },
            mergeFrom: { $bind: 'mergeFrom' },
            continueFrom: { $bind: 'continueFrom' },
            model: { $bind: 'model' },
            maxTurns: { $firstOf: [{ $bind: 'maxTurns' }, COMMISSION_MAX_TURNS_DEFAULT] },
            timeoutMs: { $firstOf: [{ $bind: 'timeoutMs' }, COMMISSION_TIMEOUT_DEFAULT_MS] },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'patchRef', toState: 'patchRef' },
            { kind: 'output_path' as const, path: 'baseSha', toState: 'baseSha' },
            { kind: 'output_path' as const, path: 'merge', toState: 'merge' },
            { kind: 'output_path' as const, path: 'applies', toState: 'applies' },
            { kind: 'output_path' as const, path: 'filesChanged', toState: 'filesChanged' },
            { kind: 'output_path' as const, path: 'sessionRef', toState: 'sessionRef' },
            { kind: 'output_path' as const, path: 'continued', toState: 'continued' },
            { kind: 'output_path' as const, path: 'refChanges', toState: 'refChanges' },
          ],
        },
      ],
      stateVariables: [
        {
          variableId: 'patchRef',
          name: 'Patch',
          description:
            'The whole diff of the change, stored by reference — what a publication takes. Absent when nothing changed beyond a merge, or nothing at all.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'baseSha',
          name: 'Base',
          description:
            'The commit the checkout started from, before any merge — the head of the branch a publication appends to.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'merge',
          name: 'Merge',
          description:
            'The merge `mergeFrom` made: `from`, the commit merged in, which a publication takes as `mergeFrom`, and the conflicts the coding agent resolved. Absent when nothing was merged.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'applies',
          name: 'Applies',
          description:
            'Whether the patch still fits where it would be published: clean, conflict or empty.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'filesChanged',
          name: 'Files changed',
          description: 'How many files the patch changes.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'sessionRef',
          name: 'Session',
          description:
            "What a further turn on the same work passes as `continueFrom`. Absent when the machine's coding agent cannot resume a session.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'continued',
          name: 'Continued',
          description: 'True when this run added a turn to an earlier commission.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'refChanges',
          name: 'Ref changes',
          description:
            'Every local branch and tag of the folder that moved while the commission ran, whoever moved it.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'patchRef',
        guidance:
          'patchRef is the change. A publication takes patchRef, baseSha and merge.from as they stand — never the patch text — and a further turn on the same work takes sessionRef as continueFrom. Report filesChanged and applies; a conflict means the base moved under the change. refChanges names any branch or tag that moved in the folder while it ran.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'commission-change',
      name: 'Commission Change',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'change-made',
            description:
              "The brief is carried out by the machine's coding agent in an isolated checkout of a repository connected as a host folder, and the change is returned as a stored patch against the base it reports, with the folder's working tree untouched.",
          },
        ],
      },
      mode: 'process' as const,
      // Each commission works in its own checkout, so none waits on another;
      // what bounds them is the machine, not the skill.
      concurrency: {
        maxParallelTasksPerRun: 1,
        maxConcurrentRuns: 'unlimited' as const,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: [
        'commission this change',
        'build this slice',
        'fix these findings',
        'have the coding agent make this change',
        'make this change in the repository',
      ],
      activationHint:
        "Run to have the machine's own coding agent make a change in a repository connected as a folder, from a brief: it works in an isolated checkout and returns the change as a stored patch. Start it with wait: 'none'. Nothing is committed or pushed — publishing the patch is Publish Local Changes.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "One operation task on host.harness.run with every input a brief names as a run input: the description steers the Helmsman (what a brief carries, wait: 'none', what to do with the result) and the brief itself instructs the coding agent. No outputSchema: what the brief asks the agent to report is the brief's, and the change is the operation's own patchRef, which the run promotes with baseSha and merge so a publication takes them as they stand. The budgets default in the template, because a run input's default is never applied.",
  },
};

export { COMMISSION_CHANGE };
