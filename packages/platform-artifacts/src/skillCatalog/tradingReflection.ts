import type { SkillCatalogEntry } from '@aflow/schemas';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { LEGACY_CAPS_RULE } from './dailyTradingCycleCampaign.js';
import {
  EXCHANGE_CALENDAR_READ,
  EXCHANGE_CLOCK_READ,
  REFLECTION_CALENDAR_LOOKBACK_DAYS,
  REFLECTION_CALENDAR_WINDOW_DERIVER,
  REFLECTION_DAY_DERIVER,
  REFLECTION_DAY_RULE,
} from './exchangeClock.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  CAMPAIGN_CONTRACT_FIELDS,
  CAMPAIGN_CONTRACT_INPUT,
  CAMPAIGN_CONTRACT_PROJECTION,
  campaignContractBindings,
} from './tradingCampaignRead.js';

/**
 * The after-close reflection on the harness (Plan 343 Part C). The Helmsman's
 * 16:45 schedule starts this run and supervises it. The analysis is a harness
 * analyst run, which reads the day's cycle docs, desk records, lens records,
 * resolutions and journal, and writes the day's entry to the journal path the
 * bundle defines. The trading day comes from the exchange clock and calendar
 * by rule, so no caller and no model names it. The read is a Runner that only
 * copies, because no operation reads a directory of memory documents whole.
 * The writes are operation tasks.
 */

export const TRADING_REFLECTION_SLUG = 'trading-reflection';

export const INGEST_CLOCK_TASK_ID = 'ingest-clock';
export const CALENDAR_WINDOW_TASK_ID = 'calendar-window';
export const READ_CALENDAR_TASK_ID = 'read-calendar';
export const TRADING_DAY_TASK_ID = 'trading-day';
export const READ_JOURNAL_ENTRY_TASK_ID = 'read-journal-entry';
export const READ_FOLDER_JOURNAL_ENTRY_TASK_ID = 'read-folder-journal-entry';
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
- \`campaign_{field}\` — each field the active Daily Trading Cycle campaign contract declares: ${CAMPAIGN_CONTRACT_FIELDS.join(', ')}. Each is null when no campaign is active.

Read:
- Cycle docs: every doc under \`/portfolio/theses/cycles/\` whose name starts with the trading day. Copy each doc whole.
- Desk records: the day's approved set at \`/research/{tradingDay}/approved-theses.json\`, which holds every candidate, what each lens said and the desk reviewer's vetoes. Copy it whole into \`deskRecords\`.
- Desk runs: every doc under \`/research/{tradingDay}/desk-runs/\`. Copy each doc whole.
- Lens findings: for each lens of that set, one item per finding with its path, the lens, the candidateId, the verdict and the reason, into \`lensReviews\`.
- Resolutions: every doc under \`/portfolio/theses/resolved/\` whose resolvedTradingDay is the trading day. Copy each doc whole.
- Snapshot: the after_close snapshot at \`/portfolio/snapshots/{tradingDay}-after_close.json\`, or null.
- Journal: the 5 most recent docs under \`/research/journal/\` before the trading day. Copy each doc's tradingDay, from its name, and its text.

Every item carries the memory \`path\` it was read from. Copy values as they stand. Never compute, round or summarise a number. Where a read fails or finds nothing, leave its list empty and say so in \`readNote\`.`;

export const REFLECTION_ANALYST_TASK = `You are the analyst of a paper-trading desk. The trading day in \`tradingDay\` has closed. Write its journal entry: what the day did, what it taught, and what the desk should weigh next.

This checkout is the space's folder. Change no file in it. The run writes your entry to the journal itself, from your result.

Read first:
- The journal and the strategy records in this folder, and \`day.journal\`, the recent entries memory holds.
- \`day\` — the day as memory holds it: its cycle docs, desk records, lens records, resolutions and after_close snapshot.
- \`campaign\` — the campaign contract. Its hypotheses, universe, horizon bounds and boundary rules are frozen for the window. Every field is null when no campaign is active. ${LEGACY_CAPS_RULE} Name a rule you think wrong, and change none.

Then write your result:
- \`headline\` — one sentence on the day.
- \`entry\` — the journal entry, in Markdown. Cover each slot's cycle and desk: what the desk proposed, which lenses rejected what, what the desk reviewer vetoed and why, and what opened. Cover each resolution against its written criteria and the lens findings its approved candidate carried. Cover what the day says about each hypothesis arm. Quote every number from the records. Never read daily P&L as a signal.
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

const INGEST_CLOCK_TASK = {
  taskId: INGEST_CLOCK_TASK_ID,
  name: 'Read the exchange clock',
  goal: 'Read the exchange clock. Its timestamp gives the trading day the run reflects on.',
  type: 'operation' as const,
  ...EXCHANGE_CLOCK_READ,
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
};

const CALENDAR_WINDOW_TASK = {
  taskId: CALENDAR_WINDOW_TASK_ID,
  name: 'Derive the calendar window',
  goal: `Derive the dates the calendar read covers from the exchange clock, by rule: the clock's date and the ${String(REFLECTION_CALENDAR_LOOKBACK_DAYS)} dates before it. No model is asked.`,
  type: 'operation' as const,
  operation: 'workflow.run.derive',
  dependsOn: [INGEST_CLOCK_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { clockTimestamp: out(INGEST_CLOCK_TASK_ID, 'timestamp') },
  inputTemplate: {
    deriver: REFLECTION_CALENDAR_WINDOW_DERIVER,
    args: { clock: { timestamp: bind('clockTimestamp') } },
  },
  outputProjection: {
    start: { path: 'value.start', onMissing: 'error' as const },
    end: { path: 'value.end', onMissing: 'error' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['start', 'end'],
      additionalProperties: false,
      properties: {
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    },
  },
};

const READ_CALENDAR_TASK = {
  taskId: READ_CALENDAR_TASK_ID,
  name: 'Read the exchange calendar',
  goal: 'Read the exchange calendar over the derived window. It holds one entry per session, so a weekend or a market holiday has none.',
  type: 'operation' as const,
  ...EXCHANGE_CALENDAR_READ,
  dependsOn: [CALENDAR_WINDOW_TASK_ID],
  retryability: 'safe' as const,
  inputBindings: {
    start: out(CALENDAR_WINDOW_TASK_ID, 'start'),
    end: out(CALENDAR_WINDOW_TASK_ID, 'end'),
  },
};

const TRADING_DAY_TASK = {
  taskId: TRADING_DAY_TASK_ID,
  name: 'Derive the trading day',
  goal: `Derive the trading day from the exchange clock and calendar, by rule. No model is asked. ${REFLECTION_DAY_RULE}. A clock and calendar that give no completed session fail this optional task, and the settlement names it.`,
  type: 'operation' as const,
  operation: 'workflow.run.derive',
  dependsOn: [INGEST_CLOCK_TASK_ID, CALENDAR_WINDOW_TASK_ID, READ_CALENDAR_TASK_ID],
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    clockTimestamp: out(INGEST_CLOCK_TASK_ID, 'timestamp'),
    marketIsOpen: out(INGEST_CLOCK_TASK_ID, 'isOpen'),
    calendarStart: out(CALENDAR_WINDOW_TASK_ID, 'start'),
    calendarEnd: out(CALENDAR_WINDOW_TASK_ID, 'end'),
    sessions: out(READ_CALENDAR_TASK_ID, 'sessions'),
  },
  inputTemplate: {
    deriver: REFLECTION_DAY_DERIVER,
    args: {
      clock: { timestamp: bind('clockTimestamp'), isOpen: bind('marketIsOpen') },
      calendar: {
        start: bind('calendarStart'),
        end: bind('calendarEnd'),
        sessions: bind('sessions'),
      },
    },
  },
  outputProjection: { tradingDay: { path: 'value.tradingDay', onMissing: 'error' as const } },
  outputContract: {
    schema: {
      type: 'object',
      required: ['tradingDay'],
      additionalProperties: false,
      properties: { tradingDay: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'tradingDay', toState: 'tradingDay' }],
};

/** The day every later task reads: the derived one, never a run input. */
const TRADING_DAY = out(TRADING_DAY_TASK_ID, 'tradingDay');

const HAS_DAY = {
  expression: `tasks.${TRADING_DAY_TASK_ID}.output.tradingDay != null`,
  onMissingRef: SKIP,
};

/**
 * Whether one journal holds an entry for the day. `absent` is the read's
 * `found`, which is false only where the read found no entry, and `entry`
 * names the entry the read found. A failed read leaves both null, so the
 * settlement tells a lookup that failed from an entry that is there.
 */
const ENTRY_LOOKUP_CONTRACT = {
  schema: {
    type: 'object',
    required: ['entry', 'absent'],
    additionalProperties: false,
    properties: {
      entry: { type: ['string', 'null'] },
      absent: { type: ['boolean', 'null'] },
    },
  },
};

const READ_JOURNAL_ENTRY_TASK = {
  taskId: READ_JOURNAL_ENTRY_TASK_ID,
  name: "Look up the day's journal entry in memory",
  goal: "Look up the day's journal entry in memory. A day the journal already holds is not reflected on again, so the run writes no second entry.",
  type: 'operation' as const,
  operation: 'memory.store.get',
  dependsOn: [TRADING_DAY_TASK_ID],
  when: HAS_DAY,
  // A failed lookup stops the reflection through the settlement, which names it.
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: TRADING_DAY },
  context: ctx('memory.store.get'),
  inputTemplate: {
    target: { path: { $concat: ['/research/journal/', bind('tradingDay'), '.md'] } },
    view: 'stat',
    ifMissing: 'absent',
  },
  outputProjection: {
    entry: { path: 'stat.path', onMissing: 'null' as const },
    absent: { path: 'found', onMissing: 'null' as const },
  },
  outputContract: ENTRY_LOOKUP_CONTRACT,
};

const READ_FOLDER_JOURNAL_ENTRY_TASK = {
  taskId: READ_FOLDER_JOURNAL_ENTRY_TASK_ID,
  name: "Look up the day's journal entry in the folder",
  goal: "Look up the day's journal entry in the folder, at journal/{tradingDay}.md. A day the folder's journal already holds is not reflected on again, so the run writes no second entry.",
  type: 'operation' as const,
  operation: 'host.file.get',
  dependsOn: [TRADING_DAY_TASK_ID],
  when: HAS_DAY,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { bindingId: runInput('bindingId'), tradingDay: TRADING_DAY },
  context: ctx('host.file.get'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    path: { $concat: ['journal/', bind('tradingDay'), '.md'] },
    ifMissing: 'absent',
  },
  outputProjection: {
    // Only a read that found the file carries a revision.
    entry: { path: 'revision', onMissing: 'null' as const },
    absent: { path: 'found', onMissing: 'null' as const },
  },
  outputContract: ENTRY_LOOKUP_CONTRACT,
};

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign contract',
  goal: 'Read the active Daily Trading Cycle campaign, so the analyst reads the day against its hypotheses and boundary rules. A day with no active campaign is still reflected on.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  dependsOn: [INGEST_CLOCK_TASK_ID],
  retryability: 'safe' as const,
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: CAMPAIGN_CONTRACT_PROJECTION,
};

const READ_DAY_TASK = {
  taskId: READ_DAY_TASK_ID,
  name: 'Read the day',
  goal: REFLECTION_READ_DAY_PROMPT,
  type: 'agent' as const,
  dependsOn: [
    TRADING_DAY_TASK_ID,
    READ_JOURNAL_ENTRY_TASK_ID,
    READ_FOLDER_JOURNAL_ENTRY_TASK_ID,
    READ_CAMPAIGN_TASK_ID,
  ],
  // Only a day neither journal holds is read, so the run never writes a second entry.
  when: {
    allOf: [
      `tasks.${READ_JOURNAL_ENTRY_TASK_ID}.output.absent == false`,
      `tasks.${READ_FOLDER_JOURNAL_ENTRY_TASK_ID}.output.absent == false`,
    ],
    onMissingRef: SKIP,
  },
  // A failed read stops the reflection through the settlement, which names it.
  optional: true,
  inputBindings: {
    tradingDay: TRADING_DAY,
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
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
  dependsOn: [TRADING_DAY_TASK_ID, READ_CAMPAIGN_TASK_ID, READ_DAY_TASK_ID],
  when: { expression: `tasks.${READ_DAY_TASK_ID}.output.readNote != null`, onMissingRef: SKIP },
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: TRADING_DAY,
    harness: runInput('harness'),
    model: runInput('model'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
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
      campaign: CAMPAIGN_CONTRACT_INPUT,
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
  dependsOn: [TRADING_DAY_TASK_ID, ANALYST_TASK_ID],
  when: HAS_ENTRY,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: TRADING_DAY, entry: out(ANALYST_TASK_ID, 'entry') },
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
  goal: "Write the analyst's entry into the folder's journal, at journal/{tradingDay}.md, creating the journal directory where the folder has none. A folder that allows no writes, or an entry already there, keeps the folder as it is, and the settlement names it.",
  type: 'operation' as const,
  operation: 'host.file.put',
  dependsOn: [TRADING_DAY_TASK_ID, ANALYST_TASK_ID],
  when: HAS_ENTRY,
  optional: true,
  // Create-only: a second attempt would meet the file the first wrote.
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: TRADING_DAY,
    entry: out(ANALYST_TASK_ID, 'entry'),
  },
  context: ctx('host.file.put'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    path: { $concat: ['journal/', bind('tradingDay'), '.md'] },
    content: bind('entry'),
    // A first reflection meets a folder with no journal/ directory yet.
    createParents: true,
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'folderJournalPath' }],
};

const SETTLE_TASK = {
  taskId: SETTLE_REFLECTION_TASK_ID,
  name: 'Settle the reflection',
  goal: 'Decide by rule whether the journal entry is written to memory and to the folder, or why not: the clock and calendar give no completed session, a journal already holds the day, a journal lookup failed, the day could not be read, the analyst returned no result, or the folder copy failed. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [
    TRADING_DAY_TASK_ID,
    READ_JOURNAL_ENTRY_TASK_ID,
    READ_FOLDER_JOURNAL_ENTRY_TASK_ID,
    READ_DAY_TASK_ID,
    ANALYST_TASK_ID,
    WRITE_JOURNAL_TASK_ID,
    WRITE_FOLDER_JOURNAL_TASK_ID,
  ],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    tradingDay: TRADING_DAY,
    memoryEntry: out(READ_JOURNAL_ENTRY_TASK_ID, 'entry'),
    memoryAbsent: out(READ_JOURNAL_ENTRY_TASK_ID, 'absent'),
    folderEntry: out(READ_FOLDER_JOURNAL_ENTRY_TASK_ID, 'entry'),
    folderAbsent: out(READ_FOLDER_JOURNAL_ENTRY_TASK_ID, 'absent'),
    readNote: out(READ_DAY_TASK_ID, 'readNote'),
    journalPath: out(WRITE_JOURNAL_TASK_ID, 'path'),
    folderJournalPath: out(WRITE_FOLDER_JOURNAL_TASK_ID, 'path'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      tradingDay: bind('tradingDay'),
      memoryEntry: bind('memoryEntry'),
      memoryAbsent: bind('memoryAbsent'),
      folderEntry: bind('folderEntry'),
      folderAbsent: bind('folderAbsent'),
      readNote: bind('readNote'),
      journalPath: bind('journalPath'),
      folderJournalPath: bind('folderJournalPath'),
    },
    rules: [
      {
        when: { expression: 'state.tradingDay == null' },
        decision: 'no_session',
        reason:
          'The exchange clock and calendar give no completed session to reflect on: the session is still open, or the calendar read holds no closed session. No day is read and no journal entry is written. The trading-day task says why.',
      },
      {
        when: { anyOf: ['state.memoryEntry != null', 'state.folderEntry != null'] },
        decision: 'already_reflected',
        reason:
          'The journal already holds an entry for the day, in memory or in the folder. The run writes no second entry and leaves both journals as they stand. A run after midnight, on a weekend or on a market holiday meets the session that closed last, which an earlier run has reflected on.',
      },
      {
        when: { anyOf: ['state.memoryAbsent == null', 'state.folderAbsent == null'] },
        decision: 'journal_unread',
        reason:
          "The day's journal entry could not be looked up in memory or in the folder, so the run cannot tell whether the day has an entry. No day is read and no journal entry is written. The read-journal-entry and read-folder-journal-entry tasks say why.",
      },
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
      {
        when: { expression: 'state.folderJournalPath == null' },
        decision: 'folder_unwritten',
        reason:
          "The journal entry is written to memory, but its copy to the folder failed. The folder may allow no writes, or may hold the day's entry already. The write-folder-journal task says why.",
      },
    ],
    otherwise: {
      decision: 'written',
      reason:
        "The analyst's journal entry for the day is written to the journal in memory and in the folder.",
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
  INGEST_CLOCK_TASK,
  CALENDAR_WINDOW_TASK,
  READ_CALENDAR_TASK,
  TRADING_DAY_TASK,
  READ_JOURNAL_ENTRY_TASK,
  READ_FOLDER_JOURNAL_ENTRY_TASK,
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
  version: 7,
  name: 'Trading Reflection',
  tagline: "An analyst on the harness writes the trading day's journal entry after the close.",
  description: `Fits the step after the after_close cycle of each trading day. The run reads the trading day from the exchange clock and calendar, so no caller names it. An **analyst** on the machine’s coding agent reads the day’s cycle docs, desk records, lens records and resolutions, and the journal, and writes the day’s entry to the journal at \`${JOURNAL_MEMORY_PATH_TEMPLATE}\`, and at \`${JOURNAL_FOLDER_PATH_TEMPLATE}\` in the connected folder where the folder allows writes. The Strategy Desk reads the journal before the next slots. The Helmsman’s after-close schedule starts it and supervises it. The analysis is the harness’s.`,
  tags: ['alpaca', 'trading', 'paper', 'journal', 'reflection'],
  bundle: {
    workflow: {
      slug: TRADING_REFLECTION_SLUG,
      name: 'Trading Reflection',
      description:
        "After the close: the run derives the trading day from the exchange clock and calendar, a Runner copies the day's cycle docs, desk records, lens records, resolutions and recent journal entries from memory, an analyst harness run writes the day's journal entry, and the run writes it to the journal in memory and in the folder.",
      usage: {
        whenToUse: [
          "Reflecting on a trading day after its after_close cycle has run: the analyst writes the day's journal entry, which the next desk reads",
          'The after-close supervision schedule, at about 16:45 New York time, with { bindingId }',
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
          "What it needs: the connected folder holding the journals and strategy records. Run it after the day's after_close cycle, so the day's records are complete.",
          'Pass no trading day. The run reads it from the exchange clock and calendar, and reports it in tradingDay. A run that fires after midnight, on a weekend or on a market holiday reflects on the session that closed last. A session the journal already holds, in memory or in the folder, settles already_reflected and writes nothing. An open session settles no_session.',
          `A ${READ_CALENDAR_TASK_ID} failure saying the stored ${EXCHANGE_CALENDAR_READ.inputTemplate.apiId} definition declares no endpoint "${EXCHANGE_CALENDAR_READ.inputTemplate.endpointId}" means the space installed the bundle before it read the exchange calendar. Tell the operator to update the bundle through Store → Update, which rewrites that definition. Installing the bundle again keeps the stored definition. Every run fails there until the update.`,
          'Never write the reflection yourself. Start this run, read reflectionOutcome and reflectionReason, and report them.',
          'The entry lands at /research/journal/{tradingDay}.md in memory, and at journal/{tradingDay}.md in the folder. A folder copy that fails settles folder_unwritten, and the memory entry still stands.',
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
          'written when the journal entry is written to memory and to the folder. already_reflected when the journal held the day before the run, which then writes nothing. no_session, journal_unread, day_unread, no_entry or folder_unwritten otherwise, and reflectionReason says why.',
        ),
        stateVariable(
          'tradingDay',
          'Trading day',
          'The trading day the run reflected on, derived from the exchange clock and calendar.',
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
        stateVariable(
          'folderJournalPath',
          'Folder journal entry',
          'Where the journal entry was written in the folder.',
        ),
        stateVariable('headline', 'Headline', "The analyst's one sentence on the day."),
      ],
      output: {
        primary: 'reflectionOutcome',
        guidance:
          'Report tradingDay, reflectionOutcome and reflectionReason, and the headline and journal paths where the entry is written. Never write the reflection yourself.',
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
        "Runs after the after_close cycle, from the Helmsman's after-close schedule, with inputs { bindingId }. It reads the trading day from the exchange clock and calendar and writes the day's journal entry. Its usage says what it needs.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Analysis goes to the harness, and supervision stays with the Helmsman. The analyst is a host.harness.run operation task over the folder. The day read is a Runner that only copies, because no operation reads a directory of memory documents whole. The journal writes and the settlement are operation tasks, decided by rule. The Helmsman's schedule starts the run and reads its outcome, and writes no reflection itself.",
  },
};
