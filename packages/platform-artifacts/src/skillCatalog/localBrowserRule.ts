import {
  DECLARE_FOLDER_PREVIEW_ARGUMENTS,
  EPHEMERAL_BROWSER_PROFILE,
  HOST_HARNESS_PREVIEW_IF_AVAILABLE,
  type HostFolderBrowserUnavailable,
  NEEDS_SETUP_FINDING_KIND,
} from '@aflow/schemas';
import { bind, ctx, out, runInput, type SKIP } from './localPrShepherdWiring.js';

/**
 * The rule that gives Commission Change and Review Local Changes a browser and
 * the folder's preview (Plan 320 D20), and the lines that say so where it
 * cannot (D21). The folder's own declaration decides, read from the machine
 * holding it by `host.binding.inspect`: which files are its UI (`uiPaths`),
 * whether a person declared how it is shown, and whether the harness and the
 * run's grant can take a browser. Nothing here names any one project, and
 * nothing here is chosen by the Helmsman or asked for by a caller: neither
 * skill offers an input that adds a browser.
 */

export const READ_UI_TASK_ID = 'read-ui';
export const DECIDE_BROWSER_TASK_ID = 'decide-browser';

/** The decision that adds the browser and the preview. */
export const BROWSER_DECISION = 'browser';
/** The decision that runs without a browser and says why, in D21's words. */
export const NEEDS_SETUP_DECISION = 'needs_setup';
/** The decision that runs without one because nothing it starts from touches the UI. */
export const NO_BROWSER_DECISION = 'none';

/** The browser a harness run the rule holds for takes, beside its `preview`. */
export const RULE_BROWSER = { profile: EPHEMERAL_BROWSER_PROFILE } as const;
/**
 * The preview a harness run the rule holds for asks for: best-effort, so one
 * that cannot be had at run time — its port held, it never answers — leaves
 * the run without it and its browser and says so in `previewUnavailable`,
 * where a person's `preview: true` is refused (D21: none of these blocks).
 */
export const RULE_PREVIEW = HOST_HARNESS_PREVIEW_IF_AVAILABLE;

// --- What is said where the browser cannot be had (D21) ----------------------

export const UI_NOT_SEEN_BY_COMMISSION = 'UI change not seen in a browser by the commission';
export const UI_NOT_SEEN_NO_PREVIEW =
  'UI change not seen in a browser: the folder declares no preview';
export const UI_NOT_SEEN_NO_GRANT =
  "UI change not seen in a browser: this run's grant does not cover the browser (browser.page:write), so it ran without one. A person with access to the space's capability profile grants `browser.page` write to give it one.";
export const UI_NOT_SEEN_NO_BROWSER_SERVED =
  'UI change not seen in a browser: the machine holding the folder serves no browser, so the run had none.';
export const UI_NOT_SEEN_GRANT_NOT_JUDGED =
  "UI change not seen in a browser: no grant was judged for this run's read of the folder, so it ran without a browser rather than on one its grant may not cover.";
export const BROWSER_UNAVAILABLE_ON_HARNESS = 'browser unavailable on harness';
export const UI_NOT_SEEN_PREVIEW_UNAVAILABLE =
  "UI change not seen in a browser: the folder's preview could not be had when the run started, so it ran without the preview and its browser";

/** The exact command that declares the bound folder's preview, and where else it is declared. */
function declarePreviewParts() {
  return [
    'A person declares it once, on the machine: `aflow folder ',
    bind('bindingId'),
    ` ${DECLARE_FOLDER_PREVIEW_ARGUMENTS}\` — or as the folder's preview on the machine page.`,
  ];
}

/** The no-preview line with the exact command that settles it, over the bound folder. */
function noPreviewLine() {
  return { $concat: [`${UI_NOT_SEEN_NO_PREVIEW}. `, ...declarePreviewParts()] };
}

// --- The review's needs_setup finding (D21) ----------------------------------

/**
 * What a D21 case becomes in the review's `findings`: a finding of the rule's
 * own kind, `minor` and never a blocker, about the first UI file the range
 * changes (`uiFile`, bound from the folder's answer). `claim` is the case's
 * line; `suggestion`, where one command settles it, that command.
 */
export interface SetupFindingCase {
  readonly claim: unknown;
  readonly suggestion?: unknown;
}

export function needsSetupFinding(found: SetupFindingCase) {
  return {
    kind: NEEDS_SETUP_FINDING_KIND,
    severity: 'minor',
    file: bind('uiFile'),
    claim: found.claim,
    evidence: {
      $concat: [
        'The range changes `',
        bind('uiFile'),
        "`, which matches the folder's `uiPaths` as the machine holding it read them, and the review read the range as a diff, with no browser.",
      ],
    },
    ...(found.suggestion !== undefined ? { suggestion: found.suggestion } : {}),
  };
}

/** How a skill's D21 rules carry the case as a finding; absent, they carry only its line. */
type SetupFinding = (found: SetupFindingCase) => unknown;

/** The harness line, naming the harness where the machine could choose one. */
function harnessLine() {
  return {
    $firstOf: [
      {
        $concat: [
          `${BROWSER_UNAVAILABLE_ON_HARNESS} `,
          bind('uiHarness'),
          ': it takes no browser arguments on the machine, so the run had no browser. `aflow harness browser ',
          bind('uiHarness'),
          '` sets them.',
        ],
      },
      `${BROWSER_UNAVAILABLE_ON_HARNESS}: the machine has no harness the run could use, so the run had no browser.`,
    ],
  };
}

const UNAVAILABLE_LINES: ReadonlyArray<readonly [HostFolderBrowserUnavailable, () => unknown]> = [
  ['harness', harnessLine],
  ['grant', () => UI_NOT_SEEN_NO_GRANT],
  ['grant_not_judged', () => UI_NOT_SEEN_GRANT_NOT_JUDGED],
  ['executor', () => UI_NOT_SEEN_NO_BROWSER_SERVED],
];

/** The line for a run whose preview could not be had, naming what happened to it. */
function previewUnavailableLine() {
  // A rule's text is substituted whether or not it holds: where the run said
  // nothing, the line stands without what happened, and the rule does not hold.
  return {
    $firstOf: [
      { $concat: [`${UI_NOT_SEEN_PREVIEW_UNAVAILABLE}: `, bind('previewUnavailable')] },
      `${UI_NOT_SEEN_PREVIEW_UNAVAILABLE}.`,
    ],
  };
}

/** A D21 rule's value: its line, which a skill promotes, and the line as a finding where it asks for one. */
function setupValue(line: unknown, finding: SetupFinding | undefined, found?: SetupFindingCase) {
  return {
    line,
    ...(finding !== undefined ? { finding: finding(found ?? { claim: line }) } : {}),
  };
}

/**
 * The D21 rule over `state.previewUnavailable`, what the harness run said of
 * a preview the rule gave it and it could not have: first, since it is what
 * happened rather than what the folder's answer foresaw.
 */
export function previewUnavailableRule(decision: string, finding?: SetupFinding) {
  return {
    when: { expression: 'state.previewUnavailable != null' },
    decision,
    reason: previewUnavailableLine(),
    value: setupValue(previewUnavailableLine(), finding),
  };
}

/**
 * The D21 rules over `state.ui`, the folder's answer: no preview first, then
 * why a browser could not be had. Each names its line as its reason, and as
 * the value's `line`, which a skill promotes: present where one of these
 * decided, absent wherever none did. Given `finding`, the value carries the
 * case as the review's `needs_setup` finding beside it: the no-preview one
 * claims D21's words and suggests the command that declares the preview.
 */
export function setupRules(decision: string, finding?: SetupFinding) {
  return [
    {
      when: { expression: "state.ui.preview == 'not_declared'" },
      decision,
      reason: noPreviewLine(),
      value: setupValue(noPreviewLine(), finding, {
        claim: UI_NOT_SEEN_NO_PREVIEW,
        suggestion: { $concat: declarePreviewParts() },
      }),
    },
    ...UNAVAILABLE_LINES.map(([why, line]) => ({
      when: { expression: `state.ui.browser.unavailable == '${why}'` },
      decision,
      reason: line(),
      value: setupValue(line(), finding),
    })),
  ];
}

export const UI_UNREAD_REASON =
  "The folder's UI could not be read from its machine, so the run has no browser.";
export const UI_UNTOUCHED_REASON =
  "Nothing the run starts from touches the folder's `uiPaths`, so it has no browser.";
export const BROWSER_REASON =
  "What the run starts from touches the folder's `uiPaths` and the folder declares a preview: the run takes `browser: { profile: 'ephemeral' }` and `preview: 'if_available'`, so a preview that cannot be had at run time leaves the run without it and its browser rather than failing it.";

/**
 * The rules before a run: the browser where its UI is touched and everything
 * it needs can be had. Given `finding`, a setup decision's value carries its
 * case as a finding too.
 */
export function browserRules(finding?: SetupFinding) {
  return [
    {
      when: { expression: 'state.ui == null' },
      decision: NO_BROWSER_DECISION,
      reason: UI_UNREAD_REASON,
    },
    {
      when: { expression: 'state.ui.touched == false' },
      decision: NO_BROWSER_DECISION,
      reason: UI_UNTOUCHED_REASON,
    },
    ...setupRules(NEEDS_SETUP_DECISION, finding),
  ];
}

export const BROWSER_RULES = browserRules();

/**
 * The decision that adds the browser: its value is what the harness run takes
 * beside its own inputs — `browser`, `preview` and the paragraph its brief
 * gains — bound by path, so a run the rule does not hold for takes none of it.
 */
export function browserOtherwise(paragraph: string) {
  return {
    decision: BROWSER_DECISION,
    reason: BROWSER_REASON,
    value: { browser: RULE_BROWSER, preview: RULE_PREVIEW, paragraph: `\n\n${paragraph}` },
  };
}

/** What a harness task binds from the decision before it. */
export const RULE_BINDINGS = {
  ruleBrowser: out(DECIDE_BROWSER_TASK_ID, 'value.browser'),
  rulePreview: out(DECIDE_BROWSER_TASK_ID, 'value.preview'),
  previewParagraph: out(DECIDE_BROWSER_TASK_ID, 'value.paragraph'),
};

/** The brief, with the paragraph after it where the rule gave the run the preview. */
export function ruleBrief(brief: unknown) {
  return { $firstOf: [{ $concat: [brief, bind('previewParagraph')] }, brief] };
}

/** The harness run's `browser` and `preview`, present only where the rule added them. */
export const RULE_INPUTS = { browser: bind('ruleBrowser'), preview: bind('rulePreview') };

/**
 * The entry task's contract: every run input the skill declares, so a caller
 * passing one a later task reads is not refused at the start. Derived from
 * the run inputs rather than listed again.
 */
export function entryContract(
  runInputs: ReadonlyArray<{ readonly id: string; readonly schema: Record<string, unknown> }>,
) {
  return {
    bindings: Object.fromEntries(
      runInputs.map((input) => [
        input.id,
        { kind: 'run_input' as const, bindAs: input.id, path: input.id, schema: input.schema },
      ]),
    ),
  };
}

/**
 * Asks the machine holding the folder which of the files `question` names
 * touch its UI, and whether a harness run there could have a browser. A read
 * that fails leaves the run without a browser rather than failing it.
 */
export function readUiTask(args: {
  taskId?: string;
  name: string;
  goal: string;
  dependsOn?: string[];
  when?:
    | { expression: string; onMissingRef: typeof SKIP }
    | { allOf: string[]; onMissingRef: typeof SKIP };
  inputBindings: Record<string, unknown>;
  inputContract?: ReturnType<typeof entryContract>;
  question: Record<string, unknown>;
}) {
  return {
    taskId: args.taskId ?? READ_UI_TASK_ID,
    name: args.name,
    goal: args.goal,
    type: 'operation' as const,
    operation: 'host.binding.inspect',
    ...(args.dependsOn !== undefined ? { dependsOn: args.dependsOn } : {}),
    ...(args.when !== undefined ? { when: args.when } : {}),
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { bindingId: runInput('bindingId'), ...args.inputBindings },
    ...(args.inputContract !== undefined ? { inputContract: args.inputContract } : {}),
    context: ctx('host.binding.inspect'),
    inputTemplate: { bindingId: bind('bindingId'), ui: args.question },
    outputProjection: { ui: { path: 'ui', onMissing: 'null' as const } },
  };
}

/** A decision over the folder's answer `readTaskId` read. */
export function decideOverUiTask(args: {
  taskId: string;
  name: string;
  goal: string;
  readTaskId: string;
  /** The harness run whose `previewUnavailable` the rules read as `state.previewUnavailable`. */
  harnessTaskId?: string;
  when?: { expression: string; onMissingRef: typeof SKIP };
  rules: readonly unknown[];
  otherwise: { decision: string; reason: string; value?: unknown };
  /** Whether the rules carry a `needs_setup` finding, which names the first UI file. */
  findsSetup?: boolean;
}) {
  return {
    taskId: args.taskId,
    name: args.name,
    goal: args.goal,
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [args.readTaskId, ...(args.harnessTaskId !== undefined ? [args.harnessTaskId] : [])],
    ...(args.when !== undefined ? { when: args.when } : {}),
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      ui: out(args.readTaskId, 'ui'),
      uiHarness: out(args.readTaskId, 'ui.browser.harness'),
      // The first UI file, which a rule's needs_setup finding is about.
      ...(args.findsSetup === true ? { uiFile: out(args.readTaskId, 'ui.files[0]') } : {}),
      ...(args.harnessTaskId !== undefined
        ? { previewUnavailable: out(args.harnessTaskId, 'previewUnavailable') }
        : {}),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        ui: bind('ui'),
        ...(args.harnessTaskId !== undefined
          ? { previewUnavailable: bind('previewUnavailable') }
          : {}),
      },
      rules: args.rules,
      otherwise: args.otherwise,
    },
  };
}

/**
 * The decision before the run: whether it takes the browser and the preview.
 * Optional, as the read before it is: a decision that could not be made
 * leaves the run without a browser rather than without a run.
 */
export function decideBrowserTask(goal: string, paragraph: string, finding?: SetupFinding) {
  return {
    ...decideOverUiTask({
      taskId: DECIDE_BROWSER_TASK_ID,
      name: 'Decide whether the run takes a browser',
      goal,
      readTaskId: READ_UI_TASK_ID,
      rules: finding === undefined ? BROWSER_RULES : browserRules(finding),
      findsSetup: finding !== undefined,
      otherwise: browserOtherwise(paragraph),
    }),
    optional: true,
  };
}

export const PREVIEW_OPEN_TASK_ID = 'preview-open';
/** The decision after a run that changed files and had no preview open. */
export const NOT_OPEN_DECISION = 'not_open';

/**
 * After the harness run `harnessTaskId`: whether it changed anything, and
 * whether it had its preview open — the rule did not give it one, or gave it
 * one the run could not have. Read from the run's own result, where an absent
 * `previewUrl` reads as `null`, which a task's `when` over that result could
 * not: it skips on a field that is absent.
 */
export function previewOpenTask(harnessTaskId: string) {
  return {
    taskId: PREVIEW_OPEN_TASK_ID,
    name: 'Read whether the run had its preview open',
    goal: 'Decide from the run’s result whether it changed files without its preview open — the rule gave it none, or the preview could not be had when it started — so the files it changed are read again.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [harnessTaskId],
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      patchRef: out(harnessTaskId, 'patchRef'),
      previewUrl: out(harnessTaskId, 'previewUrl'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { patchRef: bind('patchRef'), previewUrl: bind('previewUrl') },
      rules: [
        {
          when: { expression: 'state.patchRef == null' },
          decision: 'unchanged',
          reason: 'The run changed nothing, so nothing is read again.',
        },
        {
          when: { expression: 'state.previewUrl == null' },
          decision: NOT_OPEN_DECISION,
          reason: 'The run changed files without its preview open, so they are read again.',
        },
      ],
      otherwise: { decision: 'open', reason: 'The run had its preview open.' },
    },
  };
}

/** Holds where the run changed files and had no preview open. */
export const NO_PREVIEW_OPEN = `tasks.${PREVIEW_OPEN_TASK_ID}.output.decision == '${NOT_OPEN_DECISION}'`;

export const REPORT_SETUP_TASK_ID = 'report-setup';

/**
 * After the review's harness run `harnessTaskId`: the review's `needs_setup`
 * finding (D21), where it ran without a browser over a range touching the
 * folder's UI — the case the decision before the run named, or, where the
 * rule gave the run the preview and it could not be had when it started, what
 * happened to it, whose line is promoted as `uiNotSeen` here. Runs only after
 * a review that finished, so one that did not reports no finding, and fails
 * nothing: optional, as the read is.
 */
export function reportSetupTask(harnessTaskId: string) {
  return {
    taskId: REPORT_SETUP_TASK_ID,
    name: 'Report the setup the review ran without',
    goal: "Where the review ran without a browser over a range touching the folder's UI — the folder declares no preview, the harness or the grant could not take a browser, or the preview the rule gave it could not be had when it started — add to its findings, in D21's words, one of their own kind, `needs_setup`, severity `minor` and never a blocker, naming what would give it one. It is reported, never a failure.",
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [READ_UI_TASK_ID, DECIDE_BROWSER_TASK_ID, harnessTaskId],
    when: {
      anyOf: [
        `tasks.${DECIDE_BROWSER_TASK_ID}.output.decision == '${NEEDS_SETUP_DECISION}'`,
        `tasks.${harnessTaskId}.output.previewUnavailable != null`,
      ],
      onMissingRef: 'skip' as const,
    },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      previewUnavailable: out(harnessTaskId, 'previewUnavailable'),
      decidedFinding: out(DECIDE_BROWSER_TASK_ID, 'value.finding'),
      uiFile: out(READ_UI_TASK_ID, 'ui.files[0]'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        previewUnavailable: bind('previewUnavailable'),
        decidedFinding: bind('decidedFinding'),
      },
      rules: [
        previewUnavailableRule(NEEDS_SETUP_DECISION, needsSetupFinding),
        {
          when: { expression: 'state.decidedFinding != null' },
          decision: NEEDS_SETUP_DECISION,
          reason: 'The review ran without a browser for the reason the decision before it named.',
          value: { finding: bind('decidedFinding') },
        },
      ],
      otherwise: {
        decision: NO_BROWSER_DECISION,
        reason: 'The review had its preview: nothing to report.',
      },
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'value.line', toState: 'uiNotSeen' },
      { kind: 'output_path' as const, path: 'value.finding', toState: 'findings' },
    ],
  };
}
