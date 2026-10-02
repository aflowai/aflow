import type { SkillCatalogEntry } from '@aflow/schemas';

const REVIEW_TASK = `Review the changes in a revision range of this repository and report what is wrong with them. This checkout is an isolated copy of the connected folder at its last commit, so only committed work is visible here.

The review request arrives as the inputs of this task: \`range\` is the revision range to review, \`focus\` is the lens to weight when it is present, and \`depth\` is \`brief\`, \`standard\` or \`deep\` — absent means \`standard\`.

How to review:

- Read the range with git and establish what each commit set out to do before judging how it did it. For a range \`<base>..<sha>\`, the commits are \`git log <base>..<sha>\`, and what they change is the three-dot diff, \`git diff <base>...<sha>\`, taken from where the range's two ends meet: a branch its base has moved past reads as what it adds, and the base's own later changes do not read as the branch undoing them. \`git show\` reads one commit.
- Read every changed file whole, then read what calls into it. A change is correct or incorrect in the context that uses it, and that context is in this checkout.
- Look for correctness errors, regressions in behaviour the range did not set out to change, security and data-exposure problems, missing or misleading tests, and drift between a contract and its implementation — a schema, an interface, a documented promise.
- Weight the lens in \`focus\` when one is given, and never let it narrow the search for blockers outside it.
- At \`brief\`, read a handful of things — the log, the diff, the one or two files a finding would rest on — and answer from what they show: one paragraph of summary, the verdict \`comment\` unless something is plainly a blocker, and only findings the reading already grounds. The run is budgeted in turns, so answer with what you have rather than opening a read you cannot finish.
- At \`deep\`, also run the checks this project defines over the touched files — its test command for the touched tests, its type check, its linter — and record each one as run, with its outcome and the reason for any skip.
- Ground every finding: name the file and the line, give the evidence that shows it, and keep what the code does separate from what it should do. A finding with no evidence in this checkout does not belong in the result.
- Prefer few sharp findings to many weak ones. A blocker is a defect that must not ship; a nit is a preference.

Write the summary as the deliverable: it names every finding inline — severity, \`file:line\`, one sentence of what is wrong — blockers first, and every check you ran with its outcome. Someone reading only the summary can act on it. The evidence behind each finding, and the fix it suggests, stay in \`findings\`.

Edit no file, stage nothing and commit nothing. The result is the whole deliverable.`;

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
      maxItems: 50,
      description: 'Everything worth acting on, ordered by severity. Empty when nothing was found.',
      items: {
        type: 'object',
        required: ['severity', 'file', 'claim', 'evidence'],
        additionalProperties: false,
        properties: {
          severity: {
            type: 'string',
            enum: ['blocker', 'major', 'minor', 'nit'],
            description:
              'blocker: must not ship. major: wrong or unsafe in a case that will occur. minor: a real defect with narrow effect. nit: a preference.',
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
      },
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
const BRIEF_MAX_TURNS = 8;

const REVIEW_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'review-local-changes',
  version: 7,
  name: 'Review Local Changes',
  tagline:
    "Review committed changes in a connected repository with the machine's own coding agent.",
  description: `Fits a request to review changes that already exist in a repository on the operator's machine — "review what I just did on this branch", "look over these commits before they go anywhere". It reads a range of commits and returns a verdict with findings, and it changes nothing. Reviewing an open pull request is a different skill (review-pull-request); making a change is not this skill at all.

**What it needs**: the connected folder holding the repository, and the range to review. Ask for whichever is missing — a range reads as \`main..HEAD\`, \`HEAD~3..HEAD\`, or a single commit. The review lists a range's commits as given and reads its diff from where the two ends meet, \`main...HEAD\`, so a branch \`main\` has moved past reads as what it adds and not as undoing what \`main\` took since. A focus is optional and worth asking for when the request names a worry: security, an API surface, the blast radius of a refactor.

**Depth is a first-class choice, not something to ask the coding agent for in \`focus\`.** \`brief\` is the smoke test — a first look, a check that the mechanics work: a handful of tool calls, one paragraph, and a verdict of \`comment\` unless something is plainly a blocker. An operator asking for something quick, a glance or a sanity check means \`brief\`, and it is budgeted in coding-agent turns (\`maxTurns\`: ${String(BRIEF_MAX_TURNS)}) so that it stays brief. \`standard\` reads the range with the repository around it. \`deep\` also runs the project's own checks over the touched files, and costs the most.

**Only committed work is reviewed.** The review runs over an isolated copy of the repository at its last commit, so anything still uncommitted in the working tree is invisible to it. When the request is about work in progress, say so and ask for it to be committed first — a branch is fine — then review the range those commits make.

**With the result**: report the verdict and the summary. The summary is the review — it names every finding with its severity and its file and line, blockers first, and the checks that ran — so it needs nothing added to it. The evidence behind each finding and the fix it suggests stay on the run, to be opened when someone wants them. Nothing was changed, so a finding is a proposal until someone acts on it: offer to commission the fix as its own piece of work, and never edit the files while reporting. Run the review again once a fix lands as a new commit, over the range that includes it — a verdict covers the commits it read and nothing later.`,
  tags: ['coding', 'review', 'local', 'developer-tools'],
  bundle: {
    workflow: {
      slug: 'review-local-changes',
      name: 'Review Local Changes',
      description:
        "Review a revision range of a repository connected as a host folder: the operator's installed coding agent reads the range in an isolated checkout at the folder's last commit and returns a verdict with grounded findings. Read-only — one task, no write, no publication.",
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
      runInputs: [
        {
          id: 'bindingId',
          required: true,
          description: 'The connected folder holding the repository to review.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
        {
          id: 'range',
          required: true,
          description:
            'The revision range or ref to review — "main..HEAD", "HEAD~3..HEAD", a commit sha. It must be committed: the review reads the folder at its last commit. A range `<base>..<sha>` is read as its commits, `<base>..<sha>`, and its diff from where the two ends meet, `<base>...<sha>`, so a branch its base has moved past reads as what it adds.',
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
      ],
      tasks: [
        {
          taskId: 'review',
          name: 'Review the range',
          goal: 'Run the harness installed on the operator’s machine over an isolated checkout of the connected repository, read the requested range with the whole repository around it, and return a verdict with grounded findings. Read-only: nothing is edited, staged or committed.',
          type: 'operation' as const,
          operation: 'host.harness.run',
          retryability: 'safe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            range: { kind: 'run_input' as const, path: 'range' },
            focus: { kind: 'run_input' as const, path: 'focus' },
            depth: { kind: 'run_input' as const, path: 'depth' },
            maxTurns: { kind: 'run_input' as const, path: 'maxTurns' },
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
            bindingId: { $bind: 'bindingId' },
            task: REVIEW_TASK,
            inputs: {
              range: { $bind: 'range' },
              focus: { $bind: 'focus' },
              depth: { $bind: 'depth' },
            },
            outputSchema: RESULT_SCHEMA,
            maxTurns: { $bind: 'maxTurns' },
            resultRetries: 2,
            // A review reads the whole range and everything around it; the
            // operation's default is sized for a single change.
            timeoutMs: 7_200_000,
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'result.verdict', toState: 'verdict' },
            { kind: 'output_path' as const, path: 'result.summary', toState: 'reviewSummary' },
          ],
        },
      ],
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
      ],
      output: {
        primary: 'verdict',
        guidance:
          'The run carries the verdict and reviewSummary, and the summary already names every finding with its file and line, blockers first, and the checks that ran — reporting it is reporting the review. The evidence behind each finding stays on the task result, for whoever opens the run. Nothing was changed: a fix is a separate piece of work to commission, and the review is worth running again over the range that includes the fix once it is committed.',
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
        "Run to review committed changes in a repository connected as a folder — a range of commits read by the machine's own harness, returning a verdict with grounded findings. Read-only: it never edits, commits or publishes. Uncommitted work is invisible to it, and an open pull request belongs to review-pull-request.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'One operation task on host.harness.run with an outputSchema of findings and a verdict: the skill description steers the Helmsman (when it fits, what to ask for, what to do with the result) and the task prose instructs the harness (how to review). Read-only by construction — a single task with no write, no push and no second step — so a fix is a separate commission rather than something this skill can slip in. The repository arrives as a run input until folder roles land, and the review reads the connected folder at its last commit, which is why the description says uncommitted work is invisible.',
  },
};

export { REVIEW_LOCAL_CHANGES };
