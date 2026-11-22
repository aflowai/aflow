import type { SkillCatalogEntry } from '@aflow/schemas';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * The after-close reflection on the harness (Plan 343 Part C). The Helmsman's
 * 16:45 schedule starts this run and supervises it. The analysis is a harness
 * analyst run, which reads the day's cycle docs, desk records, lens records,
 * resolutions and journal, and writes the day's entry to the journal path the
 * bundle defines. The read is a Runner that only copies, because no operation
 * reads a directory of memory documents whole. The writes are operation tasks.
 */

export const TRADING_REFLECTION_SLUG = 'trading-reflection';

export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const READ_DAY_TASK_ID = 'read-day';
export const ANALYST_TASK_ID = 'analyst';
export const WRITE_JOURNAL_TASK_ID = 'write-journal';
export const WRITE_FOLDER_JOURNAL_TASK_ID = 'write-folder-journal';
export const SETTLE_REFLECTION_TASK_ID = 'settle';

/** The journal path the bundle defines: one entry per trading day, in memory and in the folder. */
export const JOURNAL_MEMORY_PATH_TEMPLATE = '/research/journal/{tradingDay}.md';
export const JOURNAL_FOLDER_PATH_TEMPLATE = 'journal/{tradingDay}.md';

const HARNESS_TIMEOUT_MS = 30 * 60_000;
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      "The connected folder holding the desk's journals and strategy records. The analyst works in a checkout of it, and the day's entry is also written into it where the folder allows writes.",
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'tradingDay',
    required: true,
    description:
      'The trading day to reflect on, YYYY-MM-DD in exchange time: the day whose after_close cycle has run.',
    schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent runs the analyst, by the id the operator configured on the machine. Absent, the space's preferred coding agent, else the machine's default.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'model',
    required: false,
    description:
      'The model the analyst runs, spelled as its coding agent names it. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
];

export const REFLECTION_READ_DAY_PROMPT = `Gather what the after-close analyst reads about one trading day. Copy facts from memory into your output. Form no view, and judge nothing.

Inputs (already in your task context):
- \`tradingDay\` — the day to read.
- \`campaign\` — the active Daily Trading Cycle campaign contract, or null.

Read:
- Cycle docs: every doc under \`/portfolio/theses/cycles/\` whose name starts with the trading day. Copy each doc whole.
- Desk records: every \`desk-*.json\` doc under \`/research/{tradingDay}/\`, and every doc under \`/research/{tradingDay}/desk-runs/\`. Copy each doc whole.
- Lens records: every doc under \`/research/{tradingDay}/lens-reviews/\`. Copy each doc's slotKey, round and lenses.
- Resolutions: every doc under \`/portfolio/theses/resolved/\` whose resolvedTradingDay is the trading day. Copy each doc whole.
- Snapshot: the after_close snapshot at \`/portfolio/snapshots/{tradingDay}-after_close.json\`, or null.
- Journal: the 5 most recent docs under \`/research/journal/\` before the trading day. Copy each doc's tradingDay, from its name, and its text.

Every item carries the memory \`path\` it was read from. Copy values as they stand. Never compute, round or summarise a number. Where a read fails or finds nothing, leave its list empty and say so in \`readNote\`.`;

export const REFLECTION_ANALYST_TASK = `You are the analyst of a paper-trading desk. The trading day in \`tradingDay\` has closed. Write its journal entry: what the day did, what it taught, and what the desk should weigh next.

This checkout is the space's folder. Change no file in it. The run writes your entry to the journal itself, from your result.

Read first:
- The journal and the strategy records in this folder, and \`day.journal\`, the recent entries memory holds.
- \`day\` — the day as memory holds it: its cycle docs, desk records, lens records, resolutions and after_close snapshot.
- \`campaign\` — the campaign contract. Its hypotheses, caps and boundary rules are frozen for the window. Name a rule you think wrong, and change none.

Then write your result:
- \`headline\` — one sentence on the day.
- \`entry\` — the journal entry, in Markdown. Cover each slot's cycle and desk: what the desk proposed, which lens vetoed or sent back what, and what opened. Cover each resolution against its written criteria and the lens verdicts it opened under. Cover what the day says about each hypothesis arm. Quote every number from the records. Never read daily P&L as a signal.
- \`followUps\` — what the next desk should weigh, one item each. An empty list is an answer.`;

const LEDGER_ITEM = {
  type: 'object',
  required: ['path'],
  additionalProperties: true,
  properties: { path: { type: 'string', minLength: 1 } },
};
const LIST = (maxItems: number) => ({ type: 'array', maxItems, items: LEDGER_ITEM });
const DAY_FIELDS = [
  'cycles',
  'deskRecords',
  'deskRuns',
  'lensReviews',
  'resolutions',
  'snapshot',
  'journal',
  'readNote',
] as const;

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign contract',
  goal: 'Read the active Daily Trading Cycle campaign, so the analyst reads the day against its hypotheses and boundary rules. A day with no active campaign is still reflected on.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: {
    config: { path: 'campaigns[0].campaign.config', onMissing: 'null' as const },
  },
};

const READ_DAY_TASK = {
  taskId: READ_DAY_TASK_ID,
  name: 'Read the day',
  goal: REFLECTION_READ_DAY_PROMPT,
  type: 'agent' as const,
  dependsOn: [READ_CAMPAIGN_TASK_ID],
  // A failed read stops the reflection through the settlement, which names it.
  optional: true,
  inputBindings: {
    tradingDay: runInput('tradingDay'),
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    // Reads only: the run writes the journal through its own operation tasks.
    capabilities: { operations: ['memory.store.query', 'memory.store.get'], integrations: [] },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: [...DAY_FIELDS],
      additionalProperties: false,
      properties: {
        cycles: LIST(12),
        deskRecords: LIST(12),
        deskRuns: LIST(24),
        lensReviews: LIST(36),
        resolutions: LIST(40),
        snapshot: { anyOf: [LEDGER_ITEM, { type: 'null' }] },
        journal: { type: 'array', maxItems: 5, items: LEDGER_ITEM },
        readNote: {
          ...PROSE(8000),
          description: 'What was read, and every read that failed or found nothing.',
        },
      },
    },
  },
};

const ANALYST_TASK = {
  taskId: ANALYST_TASK_ID,
  name: 'Reflect on the day',
  goal: "Run the analyst on the harness over the folder: read the day's cycle docs, desk records, lens records, resolutions and the journal, and write the day's journal entry.",
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [READ_CAMPAIGN_TASK_ID, READ_DAY_TASK_ID],
  when: { expression: `tasks.${READ_DAY_TASK_ID}.output.readNote != null`, onMissingRef: SKIP },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: runInput('tradingDay'),
    harness: runInput('harness'),
    model: runInput('model'),
    campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
    ...Object.fromEntries(
      DAY_FIELDS.map((field) => [`day_${field}`, out(READ_DAY_TASK_ID, field)]),
    ),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('harness'),
    model: bind('model'),
    task: REFLECTION_ANALYST_TASK,
    inputs: {
      tradingDay: bind('tradingDay'),
      campaign: bind('campaign'),
      day: Object.fromEntries(DAY_FIELDS.map((field) => [field, bind(`day_${field}`)])),
    },
    outputSchema: {
      type: 'object',
      required: ['tradingDay', 'headline', 'entry', 'followUps'],
      additionalProperties: false,
      properties: {
        tradingDay: { const: bind('tradingDay') },
        headline: PROSE(400),
        entry: { ...PROSE(60000), description: 'The journal entry, in Markdown.' },
        followUps: { type: 'array', maxItems: 10, items: PROSE(1000) },
      },
    },
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    headline: { path: 'result.headline', onMissing: 'error' as const },
    entry: { path: 'result.entry', onMissing: 'error' as const },
    followUps: { path: 'result.followUps', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'headline', toState: 'headline' }],
};

const HAS_ENTRY = {
  expression: `tasks.${ANALYST_TASK_ID}.output.entry != null`,
  onMissingRef: SKIP,
};

const WRITE_JOURNAL_TASK = {
  taskId: WRITE_JOURNAL_TASK_ID,
  name: 'Write the journal entry',
  goal: "Write the analyst's entry to the journal in memory, at the day's journal path. The desk reads it before the next slots.",
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [ANALYST_TASK_ID],
  when: HAS_ENTRY,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: runInput('tradingDay'), entry: out(ANALYST_TASK_ID, 'entry') },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: { $concat: ['/research/journal/', bind('tradingDay'), '.md'] },
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: { inlineText: bind('entry') },
    writeMode: 'upsert',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'journalPath' }],
};

const WRITE_FOLDER_JOURNAL_TASK = {
  taskId: WRITE_FOLDER_JOURNAL_TASK_ID,
  name: 'Write the journal entry to the folder',
  goal: "Write the analyst's entry into the folder's journal, at journal/{tradingDay}.md. A folder that allows no writes, or an entry already there, keeps the folder as it is.",
  type: 'operation' as const,
  operation: 'host.file.put',
  dependsOn: [ANALYST_TASK_ID],
  when: HAS_ENTRY,
  optional: true,
  // Create-only: a second attempt would meet the file the first wrote.
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: runInput('tradingDay'),
    entry: out(ANALYST_TASK_ID, 'entry'),
  },
  context: ctx('host.file.put'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    path: { $concat: ['journal/', bind('tradingDay'), '.md'] },
    content: bind('entry'),
  },
};

const SETTLE_TASK = {
  taskId: SETTLE_REFLECTION_TASK_ID,
  name: 'Settle the reflection',
  goal: 'Decide by rule whether the journal entry is written, or why not: the day could not be read, or the analyst returned no result. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_DAY_TASK_ID, ANALYST_TASK_ID, WRITE_JOURNAL_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    readNote: out(READ_DAY_TASK_ID, 'readNote'),
    journalPath: out(WRITE_JOURNAL_TASK_ID, 'path'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { readNote: bind('readNote'), journalPath: bind('journalPath') },
    rules: [
      {
        when: { expression: 'state.readNote == null' },
        decision: 'day_unread',
        reason:
          'The day could not be read from memory, so the analyst did not run and no journal entry is written.',
      },
      {
        when: { expression: 'state.journalPath == null' },
        decision: 'no_entry',
        reason:
          'The analyst returned no result, or its entry could not be written, so no journal entry is written. The analyst task says why.',
      },
    ],
    otherwise: {
      decision: 'written',
      reason: "The analyst's journal entry for the day is written to the journal.",
    },
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'reflectionOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'reflectionReason' },
  ],
};

export const TRADING_REFLECTION_TASKS = [
  READ_CAMPAIGN_TASK,
  READ_DAY_TASK,
  ANALYST_TASK,
  WRITE_JOURNAL_TASK,
  WRITE_FOLDER_JOURNAL_TASK,
  SETTLE_TASK,
];

const stateVariable = (variableId: string, name: string, description: string) => ({
  variableId,
  name,
  description,
  required: false,
  sensitive: false,
  immutable: false,
});

export const TRADING_REFLECTION: SkillCatalogEntry = {
  catalogId: TRADING_REFLECTION_SLUG,
  version: 1,
  name: 'Trading Reflection',
  tagline: "An analyst on the harness writes the trading day's journal entry after the close.",
  description: `Fits the step after the after_close cycle of each trading day. An **analyst** on the machine’s coding agent reads the day’s cycle docs, desk records, lens records and resolutions, and the journal, and writes the day’s entry to the journal at \`${JOURNAL_MEMORY_PATH_TEMPLATE}\`, and at \`${JOURNAL_FOLDER_PATH_TEMPLATE}\` in the connected folder where the folder allows writes. The Strategy Desk reads the journal before the next slots. The Helmsman’s after-close schedule starts it and supervises it. The analysis is the harness’s.`,
  tags: ['alpaca', 'trading', 'paper', 'journal', 'reflection'],
  bundle: {
    workflow: {
      slug: TRADING_REFLECTION_SLUG,
      name: 'Trading Reflection',
      description:
        "After the close: a Runner copies the day's cycle docs, desk records, lens records, resolutions and recent journal entries from memory, an analyst harness run writes the day's journal entry, and the run writes it to the journal in memory and in the folder.",
      usage: {
        whenToUse: [
          "Reflecting on a trading day after its after_close cycle has run: the analyst writes the day's journal entry, which the next desk reads",
          'The after-close supervision schedule, at about 16:45 New York time, with { bindingId, tradingDay }',
        ],
        whenNotToUse: [
          'Resolving or recording a cycle — that is the Daily Trading Cycle',
          'Proposing or reviewing theses — that is the Strategy Desk',
        ],
        next: [
          {
            skill: 'strategy-desk',
            when: 'The next trading day: the desk reads the journal entry before it proposes.',
          },
        ],
        pitfalls: [
          "What it needs: the connected folder holding the journals and strategy records, and the trading day. Run it after the day's after_close cycle, so the day's records are complete.",
          'Never write the reflection yourself. Start this run, read reflectionOutcome and reflectionReason, and report them.',
          'The entry lands at /research/journal/{tradingDay}.md in memory, and at journal/{tradingDay}.md in the folder where the folder allows writes and no entry is there yet.',
        ],
      },
      goal: "Return the day's journal entry, written to the journal path, or the reason none was written.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'reflection-settled',
          name: 'Reflection settled',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The analyst wrote the day's journal entry to the journal, or the run recorded why it wrote none.",
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: TRADING_REFLECTION_TASKS,
      stateVariables: [
        stateVariable(
          'reflectionOutcome',
          'Reflection outcome',
          'written when the journal entry is written. day_unread or no_entry otherwise, and reflectionReason says why.',
        ),
        stateVariable(
          'reflectionReason',
          'Reflection reason',
          'Why the reflection ended as it did.',
        ),
        stateVariable(
          'journalPath',
          'Journal entry',
          'Where the journal entry was written in memory.',
        ),
        stateVariable('headline', 'Headline', "The analyst's one sentence on the day."),
      ],
      output: {
        primary: 'reflectionOutcome',
        guidance:
          'Report reflectionOutcome and reflectionReason, and the headline and journal path where the entry is written. Never write the reflection yourself.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: TRADING_REFLECTION_SLUG,
      name: 'Trading Reflection',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'reflected-on-the-harness',
            description:
              "Every trading day has a journal entry the analyst harness run wrote from the day's records, or a recorded reason it has none.",
          },
        ],
      },
      mode: 'process' as const,
      concurrency: {
        maxParallelTasksPerRun: 2,
        maxConcurrentRuns: 1,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: ['trading reflection', 'reflect on the trading day', 'write the journal'],
      activationHint:
        "Runs after the after_close cycle, from the Helmsman's after-close schedule, with inputs { bindingId, tradingDay }. It writes the day's journal entry. Its usage says what it needs.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Analysis goes to the harness, and supervision stays with the Helmsman. The analyst is a host.harness.run operation task over the folder. The day read is a Runner that only copies, because no operation reads a directory of memory documents whole. The journal writes and the settlement are operation tasks, decided by rule. The Helmsman's schedule starts the run and reads its outcome, and writes no reflection itself.",
  },
};
