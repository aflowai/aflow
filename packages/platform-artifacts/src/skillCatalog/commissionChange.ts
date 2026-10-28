import {
  HOST_BRANCH_NAME_MAX_LENGTH,
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_HARNESS_MAX_TURNS_DEFAULT,
  HOST_HARNESS_TASK_MAX_LENGTH,
  HOST_HARNESS_TIMEOUT_MAX_MS,
  HOST_HARNESS_TIMEOUT_MIN_MS,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  type SkillCatalogEntry,
} from '@aflow/schemas';
import {
  DECIDE_BROWSER_TASK_ID,
  decideBrowserTask,
  decideOverUiTask,
  entryContract,
  NEEDS_SETUP_DECISION,
  NO_PREVIEW_OPEN,
  readUiTask,
  RULE_BINDINGS,
  RULE_INPUTS,
  ruleBrief,
  setupRules,
  UI_NOT_SEEN_BY_COMMISSION,
} from './localBrowserRule.js';
import { bind, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * How long a commission runs when the brief names no time. A slice of the size
 * a brief commissions runs thirty to forty minutes, and the operation's own
 * default ended one before it finished; the ceiling a coding agent may run to
 * is the default here.
 */
const COMMISSION_TIMEOUT_DEFAULT_MS = HOST_HARNESS_TIMEOUT_MAX_MS;

/** The run's inputs together, and so the most the task text can carry beside the rest. */
const RUN_INPUTS_KB = MAX_PARENT_INPUTS_SERIALIZED_BYTES / 1024;

const MINUTES = 60_000;

/**
 * The one paragraph a commission's brief carries when the rule gives its run
 * the browser and the preview (Plan 320 D20) — always this text, after the
 * brief. The preview serves the commit the run started from, copied before the
 * coding agent began, so it shows the app as of the base and never the edits.
 */
export const COMMISSION_PREVIEW_PARAGRAPH =
  "This run has a browser, and the folder's own preview is serving at `previewUrl`, in this task's inputs. It serves the commit this checkout started from, copied before you began: the app as of its base, which your own edits are not part of and never will be while you work. Open it there before you change a page and look at how the app behaves as of its base where this brief touches it — what the page shows and does now, and what it should do instead — so the change is made against the app's real behaviour, not a guess at it. Do not expect your edits to appear there, and start or stop no server yourself: the preview is the executor's. Say in your result what you saw.";

/**
 * The longest brief a commission takes: the operation's own limit, less the
 * paragraph the rule may add after it, so a brief at its limit still reaches
 * the coding agent with the paragraph rather than being refused by the run.
 */
export const COMMISSION_BRIEF_MAX_LENGTH =
  HOST_HARNESS_TASK_MAX_LENGTH - `\n\n${COMMISSION_PREVIEW_PARAGRAPH}`.length;

/** What the commission's harness task does. */
const COMMISSION_TASK_GOAL =
  "Run the coding agent installed on the operator's machine over an isolated checkout of the connected repository at the brief's base, carry out the brief, and return the change as a stored patch. The connected folder's working tree is untouched, and nothing is committed or pushed.";

/**
 * The longest subject line a commit carries whole: under 72 characters, the
 * width git's own tools and a pull request's title show without cutting it.
 */
export const COMMIT_TITLE_MAX_CHARS = 71;

/**
 * What every commission reports, beside whatever its brief asks for: an
 * account of the change in the shape of a commit message, which a publication
 * commits it under when the caller passes none. The title holds one line and
 * the paragraph no blank line, so the message the two compose is always a
 * subject, a blank line and one paragraph.
 */
export const COMMISSION_RESULT_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: {
      type: 'object',
      required: ['title', 'paragraph'],
      additionalProperties: false,
      description:
        "What the patch changes, as its commit message says it: a publication that names this commission commits the change under this title, a blank line, then this paragraph. It covers everything the patch holds — a continued session's earlier turns included.",
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: COMMIT_TITLE_MAX_CHARS,
          pattern: '^\\S[^\\r\\n]*$',
          description: `One line of at most ${String(COMMIT_TITLE_MAX_CHARS)} characters saying what the change does, in the imperative — "Derive the commit message from the commission's summary". No trailing period.`,
        },
        paragraph: {
          type: 'string',
          minLength: 1,
          maxLength: 8_000,
          pattern: '^(?![\\s\\S]*\\S[ \\t]*\\r?\\n[ \\t]*\\r?\\n[ \\t]*\\S)[\\s\\S]*\\S[\\s\\S]*$',
          description:
            'One paragraph — no blank line inside it — saying what changed and why, as a reviewer reads it in the history: the behaviour before and after, and anything the change deliberately leaves alone.',
        },
      },
    },
  },
};

/** What the Helmsman needs once it has chosen the skill: carried as the skill's usage pitfalls. */
const COMMISSION_PITFALLS: string[] = [
  `What it needs: the connected folder and the brief — the task text, everything the coding agent needs and nothing it has to guess: the files and the lines where they are known, what is wrong and what right looks like, the tests to add, the checks to run and what its result reports. \`base\` is where the checkout starts: \`origin/main\` for new work, the branch's name for a fix appended to a branch — a fix round included, whose branch holds the earlier round's commit pushed or kept local — so the patch is made against the branch's head and never against the earlier commission's \`baseSha\`. A fix to a branch \`main\` has moved past also takes \`mergeFrom: origin/<base>\`, so the checkout merges it first and the agent resolves what conflicts. A further turn on the same work takes \`continueFrom\`, the \`sessionRef\` the earlier run reported, from the conversation that started that run: a session belongs to that conversation, and a commission from any other is refused it. \`harness\`, \`model\`, \`maxTurns\` and \`timeoutMs\` are optional. The browser is never asked for: where the brief names a file under the folder's \`uiPaths\`, or the branch it continues already changes one, and the folder declares a preview, the run takes a browser and the folder's preview by rule, and the brief gains one standard paragraph sending the coding agent to \`previewUrl\` — so name the files a UI change touches by path, and leave the dev-server URL out. Where the folder declares no preview, or the browser cannot be had, the run goes on without one and the result says so in \`uiNotSeen\`, with the command that settles it; a UI file the run changed without a preview is named there too. \`harness\` is named only to require a coding agent other than the space's preferred one; absent, the machine runs the space's preference, else its own default, each where installed, and the result says which ran. The budgets are sized for a slice already — ${String(COMMISSION_TIMEOUT_DEFAULT_MS / MINUTES)} minutes, and ${String(HOST_HARNESS_MAX_TURNS_DEFAULT)} turns on a coding agent that takes a turn budget — and are named only to change them.`,
  `Start it with \`wait: 'none'\`. A commission runs for tens of minutes. Started that way it returns the run id at once, the conversation stays free, and the commission's end wakes it with the result. Several commissions may run at once on one machine, each in its own checkout. The machine runs only so many coding agents at once — ${String(HOST_HARNESS_CONCURRENCY_DEFAULT)} unless its operator chose another number — and a commission past that waits for one to end rather than being refused; its time counts from when it starts.`,
  `For a plan node: a commission for work in the space's plan is started with \`planNodeId\`, beside its inputs rather than among them, naming the node the round serves — the node opened with \`plan.node.get\` before the brief was written. It then shows under that node in the attention block of the conversation that started it, and when it ends the node holds a link to it. Its publication takes the same \`planNodeId\`.`,
  `The checks a brief asks for are the folder's own — its test runner on the touched tests, its type check, its linter, its formatter, and the guards its own pre-publication check runs over the whole tree; in Aflow's repository those are \`node --import tsx scripts/large-files/cli.ts check\` and \`node --conditions=ts-source --import tsx scripts/context-budget/cli.ts check\`, the two \`scripts/verify-commit.mjs\` runs, the second under the \`ts-source\` condition it runs it with so it reads the checkout's own source. The brief has the coding agent run every one of them in the commission's checkout before it returns, fix what fails in the same session, and put their output in the result the brief asks for. Nothing else runs them before publication, where the folder's declared checks run again on the commit, and a failure found there costs that publication and a further round.`,
  `With the result: report what changed — its \`summary\`, \`filesChanged\` and whether the patch \`applies\` where it would be published. The coding agent writes the \`summary\` whatever the brief asks: a title line under 72 characters and one paragraph, the commit message the change is published under. A commission whose coding agent wrote no valid summary still returns its change, saying why in \`resultProblem\`; its publication then takes \`commitMessage\`. To publish, start Publish Local Changes with the commission's \`patchRef\`, \`baseSha\` and, where it merged, \`merge.from\`, as they stand, and its run id as \`commission\` — never the \`patch\` text, a copy for reading that is cut short on a large change. The publication commits under the \`summary\`; pass \`commitMessage\` only to say it otherwise. To ask for more on the same work, start another commission with \`continueFrom\` set to its \`sessionRef\`.`,
];

const COMMISSION_RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description: 'The connected folder holding the repository to change.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'task',
    required: true,
    description: `The brief, in prose, handed to the coding agent as it stands: what to build or fix, the files and lines where they are known, the tests to add, the folder's own checks and guards to run before it returns, and the result to report. It travels in the run's inputs, which are capped at ${String(RUN_INPUTS_KB)} KB together.`,
    schema: { type: 'string', minLength: 1, maxLength: COMMISSION_BRIEF_MAX_LENGTH },
  },
  {
    id: 'base',
    required: false,
    description:
      "Where the checkout starts — a branch, tag or commit. `origin/main` for new work, fetched first so it is `main` as of now; the branch's name for a fix appended to it, a fix round's included, pushed or kept local: the checkout starts at its head, and the patch appends to its commit. A commit the folder has not fetched yet, such as one just merged, is fetched with `origin`'s default branch. Absent, the checkout starts at the folder's last commit.",
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
      'The `sessionRef` an earlier commission reported, to add a turn to that work rather than start afresh: its checkout and everything the coding agent remembers of it are still there. A session belongs to the conversation that started the commission that made it: any commission that conversation starts can continue it, and one started from another conversation cannot.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent runs the brief, by the id the operator configured on the machine. Absent, the space's preferred coding agent, else the machine's default, each where installed; name one only to require a different one.",
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
    description: `The coding agent's turn budget. Every tool call is a turn, and a slice takes several hundred. Absent, ${String(HOST_HARNESS_MAX_TURNS_DEFAULT)} on a coding agent that takes a turn budget, and none on one that does not. Named, a coding agent that takes no budget runs without it, bounded by the time; name it only to raise it for larger work or to keep a small task small.`,
    schema: { type: 'integer', minimum: 1 },
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
];

/** The decision after a run without the preview: what it says of the UI files it changed. */
export const NOT_SEEN_DECISION = 'not_seen';

const COMMISSION_TASKS = [
  readUiTask({
    name: "Read whether the brief touches the folder's UI",
    goal: "Ask the machine holding the folder which files the brief names, and which the branch it continues already changes, fall under the folder's `uiPaths`; whether the folder declares a preview; and whether the harness the run would get can be given a browser. A read that fails leaves the run without a browser.",
    inputBindings: {
      task: runInput('task'),
      base: runInput('base'),
      harness: runInput('harness'),
    },
    // The entry task's contract is the skill's input surface: a run input
    // missing from it is refused at start, whichever task reads it.
    inputContract: entryContract(COMMISSION_RUN_INPUTS),
    question: { text: bind('task'), branch: bind('base'), harness: bind('harness') },
  }),
  decideBrowserTask(
    "Decide, by rule over the folder's answer, whether the run takes `browser: { profile: 'ephemeral' }` and `preview: true` and its brief the standard paragraph: where the brief or the branch touches the folder's `uiPaths`, the folder declares a preview and the browser can be had. Where the preview is not declared or the browser cannot be had, the run goes on without one. No model is asked.",
    COMMISSION_PREVIEW_PARAGRAPH,
  ),
  {
    taskId: 'commission',
    name: 'Make the change',
    goal: COMMISSION_TASK_GOAL,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [DECIDE_BROWSER_TASK_ID],
    // A retry would start a second coding agent over the same brief.
    retryability: 'unsafe' as const,
    inputBindings: {
      bindingId: runInput('bindingId'),
      task: runInput('task'),
      base: runInput('base'),
      mergeFrom: runInput('mergeFrom'),
      continueFrom: runInput('continueFrom'),
      harness: runInput('harness'),
      model: runInput('model'),
      maxTurns: runInput('maxTurns'),
      timeoutMs: runInput('timeoutMs'),
      ...RULE_BINDINGS,
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
    // A run input's `default` documents the value and is never applied, so
    // the time falls back here. The turn budget does not: only the
    // operation knows whether the machine's coding agent can take one.
    inputTemplate: {
      bindingId: bind('bindingId'),
      task: ruleBrief(bind('task')),
      base: bind('base'),
      mergeFrom: bind('mergeFrom'),
      continueFrom: bind('continueFrom'),
      harness: bind('harness'),
      model: bind('model'),
      maxTurns: bind('maxTurns'),
      timeoutMs: { $firstOf: [bind('timeoutMs'), COMMISSION_TIMEOUT_DEFAULT_MS] },
      ...RULE_INPUTS,
      outputSchema: COMMISSION_RESULT_SCHEMA,
      // The patch is the commission's product and the summary only
      // accompanies it: a run without a valid one still returns its
      // change, and its publication then asks for a `commitMessage`.
      resultRequired: false,
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'result.summary', toState: 'summary' },
      { kind: 'output_path' as const, path: 'patchRef', toState: 'patchRef' },
      { kind: 'output_path' as const, path: 'baseSha', toState: 'baseSha' },
      { kind: 'output_path' as const, path: 'merge', toState: 'merge' },
      { kind: 'output_path' as const, path: 'applies', toState: 'applies' },
      { kind: 'output_path' as const, path: 'filesChanged', toState: 'filesChanged' },
      { kind: 'output_path' as const, path: 'sessionRef', toState: 'sessionRef' },
      { kind: 'output_path' as const, path: 'continued', toState: 'continued' },
    ],
  },
  {
    ...readUiTask({
      taskId: 'check-ui',
      name: "Read which changed files are the folder's UI",
      goal: "Ask the machine holding the folder which files the run changed fall under the folder's `uiPaths`, for a run that had no preview open: the rule before the run reads the brief and the branch, and a change it could not foresee is named here instead of passing silently.",
      dependsOn: ['commission'],
      when: {
        allOf: [NO_PREVIEW_OPEN, 'tasks.commission.output.patchRef != null'],
        onMissingRef: SKIP,
      },
      inputBindings: { patchRef: out('commission', 'patchRef'), harness: runInput('harness') },
      question: { patchRef: bind('patchRef'), harness: bind('harness') },
    }),
    promoteOutputs: [{ kind: 'output_path' as const, path: 'ui.files', toState: 'uiFilesNotSeen' }],
  },
  {
    ...decideOverUiTask({
      taskId: 'report-ui',
      name: 'Say which UI change was not seen in a browser',
      goal: "Name, in D21's words, why the UI files the run changed were not seen in a browser: the folder declares no preview, with the command that declares it; the harness or the grant could not take a browser; or the rule did not foresee the change. It is reported, never a failure: the review of the range is what sees a UI change working.",
      readTaskId: 'check-ui',
      when: { expression: 'tasks.check-ui.output.ui.touched == true', onMissingRef: SKIP },
      rules: setupRules(NEEDS_SETUP_DECISION),
      otherwise: { decision: NOT_SEEN_DECISION, reason: UI_NOT_SEEN_BY_COMMISSION },
    }),
    promoteOutputs: [{ kind: 'output_path' as const, path: 'reason', toState: 'uiNotSeen' }],
  },
];

const COMMISSION_CHANGE: SkillCatalogEntry = {
  catalogId: 'commission-change',
  version: 12,
  name: 'Commission Change',
  tagline:
    "Have the machine's own coding agent make a change in a connected repository, and get the change back as a patch.",
  description: `Fits a request to make a change in a repository on the operator's machine — "build this slice", "fix these findings", "now fix the test that broke". A commission hands a brief to the coding agent installed on that machine, which works in an isolated checkout of the connected folder and leaves the folder itself untouched; what it changed comes back as a stored patch. Nothing is committed, pushed or published: publishing the patch is Publish Local Changes, and reviewing it once published is Review Local Changes.`,
  tags: ['coding', 'commission', 'local', 'developer-tools'],
  bundle: {
    workflow: {
      slug: 'commission-change',
      name: 'Commission Change',
      description:
        "Hand a brief to the coding agent installed on the operator's machine: it works in an isolated checkout of a repository connected as a host folder, starting at the base the brief names, and its change comes back as a stored patch with the base it was made against. Where the brief or its branch touches the folder's UI and the folder declares a preview, the run has a browser and that preview by rule. Nothing is committed, pushed or published.",
      usage: {
        whenToUse: [
          'Fixing a bug or making any change meant to land in a repository connected as a folder — "fix a bug in the repo", "build this slice", "fix these findings", "now fix the test that broke": the machine\'s coding agent carries out a brief in an isolated checkout and returns the change as a stored patch',
          "A fix round on a branch a publication pushed or kept local: `base` the branch's name, with the publication's `fixRound.commissionInputs` as they stand",
          'A further turn on the same work: `continueFrom` the `sessionRef` an earlier commission from this conversation reported',
        ],
        whenNotToUse: [
          "Committing, pushing or opening a pull request — that is Publish Local Changes, which takes this run's `patchRef`",
          'Reviewing committed work — that is Review Local Changes',
          'Only reading or answering a question about the folder, with nothing to land — host.harness.run with an `outputSchema`',
        ],
        next: [
          {
            skill: 'publish-local-changes',
            when: "Once the commission returns a patch: start it with this run's `patchRef`, `baseSha` and, where it merged, `merge.from`, as they stand, and this run id as `commission` — it commits under the commission's `summary`.",
          },
        ],
        pitfalls: COMMISSION_PITFALLS,
      },
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
      runInputs: COMMISSION_RUN_INPUTS,
      tasks: COMMISSION_TASKS,
      stateVariables: [
        {
          variableId: 'summary',
          name: 'Summary',
          description:
            'What the patch changes, as the coding agent wrote it: `title`, one line under 72 characters, and `paragraph`, one paragraph. A publication naming this run commits the change under them unless it is given a `commitMessage`.',
          required: false,
          sensitive: false,
          immutable: false,
        },
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
          variableId: 'uiNotSeen',
          name: 'UI not seen in a browser',
          description:
            "Present where the run changed a file under the folder's `uiPaths` without its preview open, saying why in one line: the folder declares no preview (with the `aflow folder <bindingId> preview` command that declares one), the harness or the run's grant could not take a browser, or the rule before the run did not foresee the change. Reported, never blocking: the review of the range is what sees a UI change working.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'uiFilesNotSeen',
          name: 'UI files not seen in a browser',
          description:
            "Each file the run changed under the folder's `uiPaths` without its preview open — empty where it changed none — which `uiNotSeen` is about. Absent where the run had the preview, or changed nothing.",
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'patchRef',
        guidance:
          'patchRef is the change. A publication takes patchRef, baseSha and merge.from as they stand — never the patch text — and this run id as commission, and commits under summary unless given a commitMessage. A further turn takes sessionRef as continueFrom. Report summary, filesChanged and applies; a conflict means the base moved under the change. Report uiNotSeen, where present, as it stands.',
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
      // what bounds them is the machine's limit on coding agents, not the skill.
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
        "Run to have the machine's own coding agent make a change in a repository connected as a folder, from a brief; the change returns as a stored patch. Its usage says how to brief and start it.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "host.harness.run with every input a brief names as a run input: the description steers the Helmsman and the brief instructs the coding agent. The outputSchema asks only for summary, not required, since the patch is the product. patchRef is promoted with baseSha, merge and summary so a publication commits it as it stands. The browser is never an input (Plan 320 D20): host.binding.inspect says whether the brief or branch touches the folder's uiPaths, whether it declares a preview and whether the harness and grant can take a browser, and workflow.run.decide adds browser and preview by rule; the decision hands the harness run its browser, preview and paragraph as one value, bound by path. The trigger is best-effort, so a run without the preview is read again after it ends and each UI file it changed is named in uiNotSeen in D21's words; nothing about the browser fails the commission. The time defaults in the template; the turn budget is the machine's.",
  },
};

export { COMMISSION_CHANGE };
