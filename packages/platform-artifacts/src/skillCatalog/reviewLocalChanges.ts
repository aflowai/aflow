import type { SkillCatalogEntry } from '@aflow/schemas';
import {
  DECIDE_BROWSER_TASK_ID,
  decideBrowserTask,
  entryContract,
  readUiTask,
  reportPreviewUnavailableTask,
  RULE_BINDINGS,
  RULE_INPUTS,
  ruleBrief,
} from './localBrowserRule.js';
import { bind, runInput } from './localPrShepherdWiring.js';

const REVIEW_TASK = `Review the changes in a revision range of this repository and report what is wrong with them. This checkout is an isolated copy of the connected folder detached at the commit the range ends at — the commit this review judges — so every file on disk is that file as the range leaves it, and a check run here runs on the change. The range's base names only where the diff starts; it is never what is checked out. Only committed work is visible here.

The review request arrives as the inputs of this task: \`range\` is the revision range to review, \`focus\` is the lens to weight when it is present, and \`depth\` is \`brief\`, \`standard\` or \`deep\` — absent means \`standard\`.

How to review:

- Read the range with git and establish what each commit set out to do before judging how it did it. For a range \`<base>..<sha>\`, the commits are \`git log <base>..<sha>\`, and what they change is the three-dot diff, \`git diff <base>...<sha>\`, taken from where the range's two ends meet: a branch its base has moved past reads as what it adds, and the base's own later changes do not read as the branch undoing them. \`git show\` reads one commit.
- Read every changed file whole, then read what calls into it. A change is correct or incorrect in the context that uses it, and that context is in this checkout, as the range leaves it.
- Look for correctness errors, regressions in behaviour the range did not set out to change, security and data-exposure problems, missing or misleading tests, and drift between a contract and its implementation — a schema, an interface, a documented promise.
- Weight the lens in \`focus\` when one is given, and never let it narrow the search for blockers outside it.
- At \`brief\`, read a handful of things — the log, the diff, the one or two files a finding would rest on — and answer from what they show: one paragraph of summary, the verdict \`comment\` unless something is plainly a blocker, and only findings the reading already grounds. The run is budgeted in turns, so answer with what you have rather than opening a read you cannot finish.
- At \`deep\`, also run the checks this project defines over the touched files — its test command for the touched tests, its type check, its linter — and record each one as run, with its outcome and the reason for any skip.
- Ground every finding: name the file and the line, give the evidence that shows it, and keep what the code does separate from what it should do. A finding with no evidence in this checkout does not belong in the result.
- Prefer few sharp findings to many weak ones. A blocker is a defect that must not ship; a nit is a preference.

Write the summary as the deliverable: it names every finding inline — severity, \`file:line\`, one sentence of what is wrong — blockers first, and every check you ran with its outcome. Someone reading only the summary can act on it. The evidence behind each finding, and the fix it suggests, stay in \`findings\`.

Edit no file, stage nothing and commit nothing. The result is the whole deliverable.`;

/**
 * What the review's brief adds when the range touches the folder's `uiPaths`
 * and the rule gives the run a browser and the preview (Plan 320 D17, D20):
 * the preview serves the commit the checkout stands on, the range as it will
 * be pushed, so what the reviewer sees there is the change working or not.
 */
export const REVIEW_PREVIEW_PARAGRAPH = `The range changes this folder's UI, so this run has a browser and the folder's own preview is serving the commit this checkout stands on — the range as it will be pushed — at \`previewUrl\`, in this task's inputs:

- Open there the pages the range changes, and exercise what changed as a person using it would: navigate to it, click, type, submit, and look at the states the change adds. Take a screenshot of what you see at each step that bears on the verdict.
- Report what you saw in the summary, under its own heading, page by page: what you opened, what you did, and what it showed. What you saw is part of the verdict — a page that does not do what the range set out to do, or that the diff alone would not show is broken, is a finding like any other, at the severity its effect has, naming the file that renders it and what the page showed as its evidence.
- Take your screenshots with the browser, which keeps each one in the run's browser log. The verdict is what is read of the review, so say in it what each screenshot showed.
- Start or stop no server yourself: the preview is the executor's, and it stops when the run ends.`;

/**
 * What each severity means, most severe first: the review grades its findings
 * by it, and a publication deciding on them is asked with it.
 */
export const REVIEW_SEVERITIES = {
  blocker: 'must not ship.',
  major: 'wrong or unsafe in a case that will occur.',
  minor: 'a real defect with narrow effect.',
  nit: 'a preference.',
} as const;
export type ReviewSeverity = keyof typeof REVIEW_SEVERITIES;

/** Every severity with what it means, as one line. */
export const REVIEW_SEVERITY_ONTOLOGY = Object.entries(REVIEW_SEVERITIES)
  .map(([severity, meaning]) => `${severity}: ${meaning}`)
  .join(' ');

/** The most findings one review returns. */
export const REVIEW_FINDINGS_MAX = 50;

/** A finding as the review returns it: what a publication waiting on it records, and argues from. */
export const REVIEW_FINDING_SCHEMA = {
  type: 'object',
  required: ['severity', 'file', 'claim', 'evidence'],
  additionalProperties: false,
  properties: {
    severity: {
      type: 'string',
      enum: Object.keys(REVIEW_SEVERITIES),
      description: REVIEW_SEVERITY_ONTOLOGY,
    },
    file: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      description: 'Path relative to the repository root.',
    },
    line: {
      type: 'integer',
      minimum: 1,
      description: 'Line the finding is about, where it is about one.',
    },
    claim: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: 'What is wrong, stated so it can be argued with.',
    },
    evidence: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description:
        'What in this checkout shows it — the code, the caller, the test that does not cover it.',
    },
    suggestion: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description: 'What would settle it, where the review can say.',
    },
  },
};

const RESULT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'request_changes', 'comment'],
      description:
        'The call on the range as it stands. `request_changes` when a blocker or a major finding is present. `approve` when nothing of that weight is — a range with only minors and nits is approved, each of them listed in `findings`. `comment` only when the review could not judge the range from what it could read — a check the verdict turns on that it could not run, a file it could not read — and never as a way to attach remarks to a range that is otherwise clean: those are findings under `approve`. A publication waiting on this review pushes without asking on `approve` alone; `comment` makes it ask the operator, as `request_changes` does.',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 16000,
      description:
        'What the range does and what the review found, written so a person holding only this text can act on it: every finding named inline — its severity, its `file:line`, one sentence of what is wrong — blockers first, then every check that was run with its outcome. The evidence behind each finding and the fix it suggests stay in `findings`.',
    },
    findings: {
      type: 'array',
      maxItems: REVIEW_FINDINGS_MAX,
      description: 'Everything worth acting on, ordered by severity. Empty when nothing was found.',
      items: REVIEW_FINDING_SCHEMA,
    },
    checksRun: {
      type: 'array',
      maxItems: 20,
      description:
        "The project's own checks run over the touched files. Expected at `deep`; absent at `brief` and `standard`.",
      items: {
        type: 'object',
        required: ['command', 'outcome'],
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: 'The command as it was run.',
          },
          outcome: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
          detail: {
            type: 'string',
            minLength: 1,
            maxLength: 8000,
            description: 'What failed, or why it was skipped.',
          },
        },
      },
    },
  },
  // A verdict that contradicts its own findings is the one result the reader
  // cannot recover from, so the shape refuses it rather than the prose asking.
  allOf: [
    {
      if: {
        required: ['findings'],
        properties: {
          findings: {
            contains: {
              type: 'object',
              required: ['severity'],
              properties: { severity: { enum: ['blocker', 'major'] } },
            },
          },
        },
      },
      then: { properties: { verdict: { const: 'request_changes' } } },
    },
  ],
};

/**
 * What "a handful of tools" costs in harness turns. A rung asked for in prose
 * alone is read as a full review — the budget is what holds it — and this is
 * small enough that the answer arrives in a minute or two, large enough for the
 * log, the diff and the one file a finding rests on.
 */
export const BRIEF_MAX_TURNS = 8;

/** What the Helmsman needs once it has chosen the skill: carried as the skill's usage pitfalls. */
const REVIEW_PITFALLS: string[] = [
  `What it needs: the connected folder holding the repository, and the range to review as its two ends — \`at\`, the commit it ends at, and \`from\`, where it starts. Ask for whichever is missing — \`main..HEAD\` is \`from\` \`main\` and \`at\` \`HEAD\`, \`HEAD~3..HEAD\` is \`from\` \`HEAD~3\` and \`at\` \`HEAD\`, and a single commit is \`at\` alone. The range is made from the two, so the commit it ends at and the commit the review stands on are one value and cannot disagree. The review lists a range's commits as given and reads its diff from where the two ends meet, \`main...HEAD\`, so a branch \`main\` has moved past reads as what it adds and not as undoing what \`main\` took since. A focus is optional and worth asking for when the request names a worry: security, an API surface, the blast radius of a refactor.`,
  `Depth is a first-class choice, not something to ask the coding agent for in \`focus\`. \`brief\` is the smoke test — a first look, a check that the mechanics work: a handful of tool calls, one paragraph, and a verdict of \`comment\` unless something is plainly a blocker. An operator asking for something quick, a glance or a sanity check means \`brief\`, and it is budgeted in coding-agent turns (\`maxTurns\`: ${String(BRIEF_MAX_TURNS)}) so that it stays brief. \`standard\` reads the range with the repository around it. \`deep\` also runs the project's own checks over the touched files, and costs the most.`,
  `The browser is never asked for, in \`focus\` or anywhere else. Where the range touches the folder's \`uiPaths\` and the folder declares a preview, the review runs with a browser and that preview by rule, opens the pages the range changes, exercises what changed and reports what it saw as part of its verdict. Where the folder declares no preview, or the browser or its preview cannot be had, it reviews the range as a diff and \`uiNotSeen\` says why, with the command that settles it.`,
  `The review stands on the commit it judges. It runs over an isolated copy of the repository detached at \`at\`, so the files it reads whole and the checks it runs at \`deep\` are the change's own; the range's base names only where the diff starts. Only committed work is reviewed: anything still uncommitted in the working tree is invisible to it. When the request is about work in progress, say so and ask for it to be committed first — a branch is fine — then review the range those commits make.`,
  `With the result: report the verdict and the summary. The summary is the review — it names every finding with its severity and its file and line, blockers first, and the checks that ran — so it needs nothing added to it. The evidence behind each finding and the fix it suggests stay on the run, to be opened when someone wants them. Nothing was changed, so a finding is a proposal until someone acts on it: offer to commission the fix as its own piece of work, and never edit the files while reporting. Run the review again once a fix lands as a new commit, over the range that includes it — a verdict covers the commits it read and nothing later.`,
];

const REVIEW_RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description: 'The connected folder holding the repository to review.',
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'at',
    required: true,
    description:
      'The commit the range ends at — the one the review judges, and where its checkout stands: "HEAD" for "main..HEAD", "feature" for "main..feature", the sha for a single commit or for `<base>..<sha>`. It must be committed. The range is `<from>..<at>`, or `at` alone, so its tip is this value and nothing else.',
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  },
  {
    id: 'from',
    required: false,
    description:
      'Where the range starts: "main" for "main..HEAD", "HEAD~3" for "HEAD~3..HEAD", a sha for `<base>..<sha>`. Omit it to review the single commit `at`. The range `<from>..<at>` is read as its commits, `<from>..<at>`, and its diff from where the two ends meet, `<from>...<at>`, so a branch its base has moved past reads as what it adds. It names only where the diff starts: checked out, it would have the review read every file, and run every check, as it was before the change.',
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  },
  {
    id: 'focus',
    required: false,
    description:
      'The lens to weight — security, correctness, the API surface. Omit for a balanced review.',
    schema: { type: 'string', minLength: 1, maxLength: 2000 },
  },
  {
    id: 'depth',
    required: false,
    description:
      '"brief" (a handful of tool calls, one paragraph, a first look), "standard" (read the range with the repository around it) or "deep" (also run the project\'s checks over the touched files). Absent is "standard".',
    schema: { type: 'string', enum: ['brief', 'standard', 'deep'], default: 'standard' },
  },
  {
    id: 'maxTurns',
    required: false,
    // The rung and its budget arrive as two run inputs because a task
    // template substitutes whole nodes and cannot pick a value per rung:
    // nothing between the rung and the operation can turn `brief` into a
    // number. So the skill names the number and the caller carries it.
    description: `The harness turn budget that makes a brief review brief: ${String(BRIEF_MAX_TURNS)}, with depth "brief". Omit it at "standard" and "deep", which read the range through.`,
    schema: { type: 'integer', minimum: 1, maximum: BRIEF_MAX_TURNS },
  },
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent reviews, by the id the operator configured on the machine. Absent, the space's preferred coding agent, else the machine's default, each where installed; name one only to have a different agent review, such as a second opinion from another.",
    schema: { type: 'string', minLength: 1 },
  },
];

const REVIEW_TASKS = [
  readUiTask({
    name: "Read whether the range touches the folder's UI",
    goal: "Ask the machine holding the folder which files the range changes — read from where its two ends meet, as the review reads it — fall under the folder's `uiPaths`; whether the folder declares a preview; and whether the harness the review would get can be given a browser. A read that fails leaves the review without a browser.",
    inputBindings: { from: runInput('from'), at: runInput('at'), harness: runInput('harness') },
    // The entry task's contract is the skill's input surface: a run input
    // missing from it is refused at start, whichever task reads it.
    inputContract: entryContract(REVIEW_RUN_INPUTS),
    question: { from: bind('from'), at: bind('at'), harness: bind('harness') },
  }),
  {
    ...decideBrowserTask(
      "Decide, by rule over the folder's answer, whether the review takes `browser: { profile: 'ephemeral' }` and `preview: 'if_available'` and its brief the paragraph asking it to open and exercise what changed: where the range touches the folder's `uiPaths`, the folder declares a preview and the browser can be had. Where the preview is not declared or the browser cannot be had, the review goes on without one and says why in D21's words. Never by the depth, the focus or the Helmsman; no model is asked.",
      REVIEW_PREVIEW_PARAGRAPH,
    ),
    // A setup decision's line; absent wherever the review had the browser or needed none.
    promoteOutputs: [{ kind: 'output_path' as const, path: 'value.line', toState: 'uiNotSeen' }],
  },
  {
    taskId: 'review',
    name: 'Review the range',
    goal: 'Run the harness installed on the operator’s machine over an isolated checkout of the connected repository detached at the range’s tip, read the requested range with the whole repository around it, and return a verdict with grounded findings — where the range touches the folder’s UI and the rule gives the run the preview, after opening the pages it changes there and exercising what changed. Read-only: nothing is edited, staged or committed.',
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [DECIDE_BROWSER_TASK_ID],
    retryability: 'safe' as const,
    inputBindings: {
      bindingId: runInput('bindingId'),
      from: runInput('from'),
      at: runInput('at'),
      focus: runInput('focus'),
      depth: runInput('depth'),
      maxTurns: runInput('maxTurns'),
      harness: runInput('harness'),
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
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('harness'),
      base: bind('at'),
      // The rule adds the browser, the preview and the paragraph, and nothing
      // else: the depth, the focus and the budget are the caller's either way.
      task: ruleBrief(REVIEW_TASK),
      inputs: {
        // Built from `at`, so the range the review reads ends at the
        // commit its checkout stands on, whatever the caller passed.
        range: {
          $firstOf: [{ $concat: [bind('from'), '..', bind('at')] }, bind('at')],
        },
        focus: bind('focus'),
        depth: bind('depth'),
      },
      ...RULE_INPUTS,
      outputSchema: RESULT_SCHEMA,
      maxTurns: bind('maxTurns'),
      resultRetries: 2,
      // A review reads the whole range and everything around it; the
      // operation's default is sized for a single change.
      timeoutMs: 7_200_000,
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'result.verdict', toState: 'verdict' },
      { kind: 'output_path' as const, path: 'result.summary', toState: 'reviewSummary' },
      { kind: 'output_path' as const, path: 'result.findings', toState: 'findings' },
    ],
  },
  reportPreviewUnavailableTask('review'),
];

const REVIEW_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'review-local-changes',
  version: 12,
  name: 'Review Local Changes',
  tagline:
    "Review committed changes in a connected repository with the machine's own coding agent.",
  description: `Fits a request to review changes that already exist in a repository on the operator's machine — "review what I just did on this branch", "look over these commits before they go anywhere". It reads a range of commits and returns a verdict with findings, and it changes nothing. Reviewing an open pull request is a different skill (review-pull-request); making a change is not this skill at all.`,
  tags: ['coding', 'review', 'local', 'developer-tools'],
  bundle: {
    workflow: {
      slug: 'review-local-changes',
      name: 'Review Local Changes',
      description:
        "Review a revision range of a repository connected as a host folder: the operator's installed coding agent reads the range in an isolated checkout detached at the commit the range ends at and returns a verdict with grounded findings. Where the range touches the folder's UI and the folder declares a preview, the review also opens the changed pages in that preview, by rule. Read-only — no write, no publication.",
      usage: {
        whenToUse: [
          'Reviewing changes already committed in a repository connected as a folder — "review what I just did on this branch", "look over these commits before they go anywhere": a verdict with findings that name their file and line, and nothing changed',
          "A quick look or a sanity check over a range, at depth `brief`; the project's own checks over the touched files, at depth `deep`",
        ],
        whenNotToUse: [
          'An open pull request — that is review-pull-request',
          'Making or fixing a change — that is Commission Change',
          'A change about to be published from a folder whose push approval is `unless-unreviewed` — Publish Local Changes reviews everything its push would add itself, so no review needs starting beside it',
          'Uncommitted work — it is invisible to the review; ask for it to be committed, on a branch, first',
        ],
        next: [
          {
            skill: 'commission-change',
            when: 'A finding is to be fixed: commission it as its own piece of work, briefed from the findings, with `base` the branch the range ends on.',
          },
          {
            skill: 'publish-local-changes',
            when: 'The range is ready to land: publish it — under `unless-unreviewed` the publication runs this review again on what its push adds and follows the decision on its findings.',
          },
        ],
        pitfalls: REVIEW_PITFALLS,
      },
      goal: 'Return a structured verdict on a revision range — approve, request changes, or comment — with findings that name their file, line and evidence, and the outcome of the project’s own checks when the review ran them.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'range-reviewed',
          name: 'Range reviewed',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The requested revision range was read in a checkout of the connected repository, and a verdict with grounded findings (file, line, evidence) was returned without any file being changed.',
          },
        },
      ],
      runInputs: REVIEW_RUN_INPUTS,
      tasks: REVIEW_TASKS,
      stateVariables: [
        {
          variableId: 'verdict',
          name: 'Review verdict',
          description: 'The call on the range: approve | request_changes | comment.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'reviewSummary',
          name: 'Review summary',
          description:
            'The review as a person reads it: what the range does, every finding with its severity and its file and line, blockers first, and the checks that ran with their outcome.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'findings',
          name: 'Review findings',
          description:
            'Every finding as the review returned it — severity, file, line, claim, evidence and suggestion — for a run that acts on them one at a time, as a publication deciding on a fix round does.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'uiNotSeen',
          name: 'UI not seen in a browser',
          description:
            "Present where the range touches the folder's `uiPaths` and the review ran without a browser, saying why in one line: the folder declares no preview (with the `aflow folder <bindingId> preview` command that declares one), the harness or the run's grant could not take a browser, or the preview the rule gave the review could not be had when it started (its port held or in use, or it never answered — the line names which). Reported, never blocking.",
          required: false,
          sensitive: false,
          immutable: false,
          // The decision before the run writes it where the run has no browser, the
          // report after it only where the run was given one and could not have it.
          writers: 'alternatives' as const,
        },
      ],
      output: {
        primary: 'verdict',
        guidance:
          "The run carries the verdict and reviewSummary; the summary names every finding with its file and line, blockers first, the checks that ran and, where the range touched the folder's UI, what the review saw in its preview — reporting it is reporting the review. Nothing was changed: a fix is a separate commission, and the review is worth running again over the range that includes it. Report uiNotSeen, where present, as it stands.",
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'review-local-changes',
      name: 'Review Local Changes',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'range-reviewed',
            description:
              'A revision range of a repository connected as a host folder is reviewed in an isolated checkout, and a verdict with findings naming file, line and evidence is returned without any file being changed.',
          },
        ],
      },
      mode: 'process' as const,
      // Each review reads its own checkout and writes nothing, and a
      // publication waiting at its approval asks for one; a cap would queue
      // that review behind the others.
      concurrency: {
        maxParallelTasksPerRun: 4,
        maxConcurrentRuns: 'unlimited' as const,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: [
        'review my changes',
        'review this branch',
        'review these commits',
        'look over what i just committed',
        'review the local changes',
      ],
      activationHint:
        "Run to review committed changes in a repository connected as a folder — a range of commits read by the machine's own harness, returning a verdict with grounded findings. Read-only. Its usage says what it needs and what follows it.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "host.harness.run with an outputSchema of findings and a verdict: the description steers the Helmsman and the task prose instructs the harness. Read-only by construction — no task writes, pushes or publishes. The checkout is detached at the range's tip (at, the harness base) and the range is built as <from>..<at>, so its tip and the checkout cannot disagree; uncommitted work is invisible. The browser is added by rule (Plan 320 D17, D20), never by the depth, the focus or the Helmsman: host.binding.inspect says whether the range touches the folder's uiPaths, whether it declares a preview and whether the harness and grant can take a browser, and workflow.run.decide gives the run browser and preview ('if_available') where all of that holds, handed to the harness run as one value bound by path. The preview serves the range as it will be pushed, so what the reviewer sees is part of the verdict; where the browser or the preview cannot be had, uiNotSeen says why in D21's words.",
  },
};

export { REVIEW_LOCAL_CHANGES };
