import {
  EPHEMERAL_BROWSER_PROFILE,
  HOST_HARNESS_PREVIEW_IF_AVAILABLE,
  type HostFolderBrowserUnavailable,
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

/** The command a person runs on the machine to declare a folder's preview, as the lines name it. */
export const DECLARE_PREVIEW_ARGUMENTS =
  'preview --command "<the command that serves it, with {port}>"';

/** The no-preview line with the exact command that settles it, over the bound folder. */
function noPreviewLine() {
  return {
    $concat: [
      `${UI_NOT_SEEN_NO_PREVIEW}. A person declares it once, on the machine: \`aflow folder `,
      bind('bindingId'),
      ` ${DECLARE_PREVIEW_ARGUMENTS}\` — or as the folder's preview on the machine page.`,
    ],
  };
}

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

/**
 * The D21 rule over `state.previewUnavailable`, what the harness run said of
 * a preview the rule gave it and it could not have: first, since it is what
 * happened rather than what the folder's answer foresaw.
 */
export function previewUnavailableRule(decision: string) {
  return {
    when: { expression: 'state.previewUnavailable != null' },
    decision,
    reason: previewUnavailableLine(),
    value: { line: previewUnavailableLine() },
  };
}

/**
 * The D21 rules over `state.ui`, the folder's answer: no preview first, then
 * why a browser could not be had. Each names its line as its reason, and as
 * the value's `line`, which a skill promotes: present where one of these
 * decided, absent wherever none did.
 */
export function setupRules(decision: string) {
  return [
    {
      when: { expression: "state.ui.preview == 'not_declared'" },
      decision,
      reason: noPreviewLine(),
      value: { line: noPreviewLine() },
    },
    ...UNAVAILABLE_LINES.map(([why, line]) => ({
      when: { expression: `state.ui.browser.unavailable == '${why}'` },
      decision,
      reason: line(),
      value: { line: line() },
    })),
  ];
}

export const UI_UNREAD_REASON =
  "The folder's UI could not be read from its machine, so the run has no browser.";
export const UI_UNTOUCHED_REASON =
  "Nothing the run starts from touches the folder's `uiPaths`, so it has no browser.";
export const BROWSER_REASON =
  "What the run starts from touches the folder's `uiPaths` and the folder declares a preview: the run takes `browser: { profile: 'ephemeral' }` and `preview: 'if_available'`, so a preview that cannot be had at run time leaves the run without it and its browser rather than failing it.";

/** The rules before a run: the browser where its UI is touched and everything it needs can be had. */
export const BROWSER_RULES = [
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
  ...setupRules(NEEDS_SETUP_DECISION),
];

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
export function decideBrowserTask(goal: string, paragraph: string) {
  return {
    ...decideOverUiTask({
      taskId: DECIDE_BROWSER_TASK_ID,
      name: 'Decide whether the run takes a browser',
      goal,
      readTaskId: READ_UI_TASK_ID,
      rules: BROWSER_RULES,
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

/**
 * After a harness run the rule gave the preview: where the run could not have
 * it, D21's line naming what happened, promoted as `uiNotSeen`. Runs only
 * where the run said so, and fails nothing: optional, as the read is.
 */
export function reportPreviewUnavailableTask(harnessTaskId: string) {
  return {
    taskId: 'report-preview',
    name: 'Say why the run had no preview',
    goal: "Where the run the rule gave the folder's preview could not have it when it started — its port held or in use, or it never answered — name, in D21's words, what happened to it: the run went on without the preview and its browser, and that is reported, never a failure.",
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [harnessTaskId],
    when: {
      expression: `tasks.${harnessTaskId}.output.previewUnavailable != null`,
      onMissingRef: 'skip' as const,
    },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { previewUnavailable: out(harnessTaskId, 'previewUnavailable') },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: { previewUnavailable: bind('previewUnavailable') },
      rules: [previewUnavailableRule(NEEDS_SETUP_DECISION)],
      otherwise: {
        decision: NO_BROWSER_DECISION,
        reason: 'The run had its preview: nothing to say.',
      },
    },
    promoteOutputs: [{ kind: 'output_path' as const, path: 'value.line', toState: 'uiNotSeen' }],
  };
}
