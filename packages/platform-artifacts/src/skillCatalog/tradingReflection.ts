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
  CAMPAIGN_CONTRACT_INPUT,
  CAMPAIGN_CONTRACT_PROJECTION,
  campaignContractBindings,
} from './tradingCampaignRead.js';

/**
 * The after-close reflection on the harness (Plan 343 Part C). The Helmsman's
 * 16:45 schedule starts this run and supervises it. The trading day comes from
 * the exchange clock and calendar by rule, so no caller and no model names it.
 * The day's documents are read by code, through memory.store.collect, and
 * handed to the analyst as data. The analyst is the one model in the run: it
 * judges the day and writes its journal entry. The writes are operation tasks.
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

const dayText = (...rest: unknown[]) => ({ $concat: rest });

/**
 * The documents the analyst is handed, as memory.store.collect sources. The
 * cycle docs and the after_close snapshot are the day itself: a day with
 * neither has nothing to read. Every other source may come back empty or
 * missing, and the analyst judges with what arrived.
 */
export const REFLECTION_DAY_SOURCES = [
  {
    key: 'cycles',
    pathPrefix: dayText('/portfolio/theses/cycles/', bind('tradingDay')),
    limit: 12,
  },
  {
    key: 'snapshot',
    path: dayText('/portfolio/snapshots/', bind('tradingDay'), '-after_close.json'),
  },
  {
    key: 'approvedSet',
    path: dayText('/research/', bind('tradingDay'), '/approved-theses.json'),
  },
  {
    key: 'deskRuns',
    pathPrefix: dayText('/research/', bind('tradingDay'), '/desk-runs/'),
    limit: 24,
  },
  {
    key: 'resolutions',
    pathPrefix: '/portfolio/theses/resolved/',
    // A resolved doc's path names its thesis, not its day. A thesis resolved on
    // the day was written after the day began, so the bound keeps every one of
    // them and reads only the docs written since. UTC midnight falls before New
    // York's, so the bound never cuts a write of the day.
    updatedSince: dayText(bind('tradingDay'), 'T00:00:00Z'),
    where: { resolvedTradingDay: bind('tradingDay') },
    limit: 40,
  },
  {
    key: 'journal',
    pathPrefix: '/research/journal/',
    before: dayText('/research/journal/', bind('tradingDay')),
    order: 'desc' as const,
    limit: 5,
  },
];

export const REFLECTION_DAY_KEYS = REFLECTION_DAY_SOURCES.map((source) => source.key);

export const REFLECTION_ANALYST_TASK = `You are the analyst of a paper-trading desk. The trading day in \`tradingDay\` has closed. Write its journal entry: what the day did, what it taught, and what the desk should weigh next.

This checkout is the space's folder. Change no file in it. The run writes your entry to the journal itself, from your result.

The run has read the day from memory and hands it to you in \`day\`. Each document arrives as { path, docType, content }. A document memory could not give arrives as { path, missing: true, reason }.
- \`day.cycles\` — the day's cycle docs, one per slot that ran.
- \`day.snapshot\` — the day's after_close snapshot.
- \`day.approvedSet\` — the day's approved set: every candidate, what each lens found and the desk reviewer's vetoes.
- \`day.deskRuns\` — the record of each desk run of the day.
- \`day.resolutions\` — the theses resolved on the day.
- \`day.journal\` — the 5 latest journal entries before the day, latest first.
- \`day.missing\` — every path that arrived missing.
- \`day.incomplete\` — the keys of the lists above that hold more documents than the read could scan, so some may be absent.

Read also the journal and the strategy records in this folder, and \`campaign\`, the campaign contract. Its hypotheses, universe, horizon bounds and boundary rules are frozen for the window. Every field is null when no campaign is active. ${LEGACY_CAPS_RULE} Name a rule you think wrong, and change none.

Judge the day with what arrived. Where a document is missing, say so in the entry, and say what its absence leaves unknown.

Then write your result:
- \`headline\` — one sentence on the day.
- \`entry\` — the journal entry, in Markdown. Cover each slot's cycle and desk: what the desk proposed, which lenses rejected what, what the desk reviewer vetoed and why, and what opened. Cover each resolution against its written criteria and the lens findings its approved candidate carried. Cover what the day says about each hypothesis arm. Quote every number from the records. Never read daily P&L as a signal.
- \`followUps\` — what the next desk should weigh, one item each. An empty list is an answer.`;

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

/**
 * The day, read by code. A document that is absent or unreadable comes back
 * marked missing, and the read still succeeds, so only a store that cannot be
 * reached fails this task.
 */
const READ_DAY_TASK = {
  taskId: READ_DAY_TASK_ID,
  name: 'Read the day',
  goal: "Read the day's documents from memory, whole, by code: its cycle docs, after_close snapshot, approved set, desk runs, resolutions and the 5 latest journal entries before it. No model is asked. A document absent from memory, or unreadable, is marked missing, and the analyst judges with what arrived.",
  type: 'operation' as const,
  operation: 'memory.store.collect',
  dependsOn: [TRADING_DAY_TASK_ID, READ_JOURNAL_ENTRY_TASK_ID, READ_FOLDER_JOURNAL_ENTRY_TASK_ID],
  // Only a day neither journal holds is read, so the run never writes a second entry.
  when: {
    allOf: [
      `tasks.${READ_JOURNAL_ENTRY_TASK_ID}.output.absent == false`,
      `tasks.${READ_FOLDER_JOURNAL_ENTRY_TASK_ID}.output.absent == false`,
    ],
    onMissingRef: SKIP,
  },
  // A store that cannot be reached stops the reflection through the settlement, which names it.
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: TRADING_DAY },
  context: ctx('memory.store.collect'),
  inputTemplate: { sources: REFLECTION_DAY_SOURCES },
  outputProjection: {
    ...Object.fromEntries(
      REFLECTION_DAY_KEYS.map((key) => [key, { path: `docs.${key}`, onMissing: 'error' as const }]),
    ),
    missing: { path: 'missing', onMissing: 'error' as const },
    incomplete: { path: 'incomplete', onMissing: 'error' as const },
    cycleCount: { path: 'found.cycles', onMissing: 'error' as const },
    snapshotCount: { path: 'found.snapshot', onMissing: 'error' as const },
  },
};

/** The day's core documents: a day with no cycle doc and no snapshot has nothing to read. */
const DAY_READ = {
  anyOf: [
    `tasks.${READ_DAY_TASK_ID}.output.cycleCount > 0`,
    `tasks.${READ_DAY_TASK_ID}.output.snapshotCount > 0`,
  ],
  onMissingRef: SKIP,
};

const DAY_INPUTS = [...REFLECTION_DAY_KEYS, 'missing', 'incomplete'];

const ANALYST_TASK = {
  taskId: ANALYST_TASK_ID,
  name: 'Reflect on the day',
  goal: "Run the analyst on the harness over the folder. It is handed the day as data, judges it and writes the day's journal entry.",
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [TRADING_DAY_TASK_ID, READ_CAMPAIGN_TASK_ID, READ_DAY_TASK_ID],
  when: DAY_READ,
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: TRADING_DAY,
    harness: runInput('harness'),
    model: runInput('model'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
    ...Object.fromEntries(DAY_INPUTS.map((key) => [`day_${key}`, out(READ_DAY_TASK_ID, key)])),
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
      day: Object.fromEntries(DAY_INPUTS.map((key) => [key, bind(`day_${key}`)])),
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
  goal: 'Decide by rule whether the journal entry is written to memory and to the folder, or why not: the clock and calendar give no completed session, a journal already holds the day, a journal lookup failed, the memory store did not answer, memory holds no cycle doc and no snapshot for the day, the analyst returned no result, or the folder copy failed. No model is asked.',
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
    cycleCount: out(READ_DAY_TASK_ID, 'cycleCount'),
    snapshotCount: out(READ_DAY_TASK_ID, 'snapshotCount'),
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
      cycleCount: bind('cycleCount'),
      snapshotCount: bind('snapshotCount'),
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
        when: { expression: 'state.cycleCount == null' },
        decision: 'memory_unreachable',
        reason:
          "The memory store, or the payload store holding a document's body, did not answer the day's read, so the analyst did not run and no journal entry is written. The read-day task says why. A missing document does not cause this, because the read marks it missing and goes on.",
      },
      {
        when: { allOf: ['state.cycleCount == 0', 'state.snapshotCount == 0'] },
        decision: 'day_unread',
        reason:
          'Memory holds no cycle doc and no after_close snapshot for the day, so there is no day to read. The analyst did not run and no journal entry is written. Run the reflection after the day’s cycles have recorded.',
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
  version: 8,
  name: 'Trading Reflection',
  tagline: "An analyst on the harness writes the trading day's journal entry after the close.",
  description: `Fits the step after the after_close cycle of each trading day. The run reads the trading day from the exchange clock and calendar, so no caller names it. Code reads the day’s cycle docs, snapshot, approved set, desk runs, resolutions and recent journal entries from memory. An **analyst** on the machine’s coding agent is handed them as data, judges the day and writes its entry to the journal at \`${JOURNAL_MEMORY_PATH_TEMPLATE}\`, and at \`${JOURNAL_FOLDER_PATH_TEMPLATE}\` in the connected folder where the folder allows writes. The Strategy Desk reads the journal before the next slots. The Helmsman’s after-close schedule starts it and supervises it. The analysis is the harness’s.`,
  tags: ['alpaca', 'trading', 'paper', 'journal', 'reflection'],
  bundle: {
    workflow: {
      slug: TRADING_REFLECTION_SLUG,
      name: 'Trading Reflection',
      description:
        "After the close: the run derives the trading day from the exchange clock and calendar, a code read takes the day's cycle docs, snapshot, approved set, desk runs, resolutions and recent journal entries from memory, an analyst harness run is handed them as data and writes the day's journal entry, and the run writes it to the journal in memory and in the folder.",
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
          'written when the journal entry is written to memory and to the folder. already_reflected when the journal held the day before the run, which then writes nothing. no_session, journal_unread, memory_unreachable, day_unread, no_entry or folder_unwritten otherwise, and reflectionReason says why.',
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
      "Analysis goes to the harness, and supervision stays with the Helmsman. The analyst is a host.harness.run operation task over the folder. The day read is code: a memory.store.collect operation task reads the named documents whole and marks each one absent or unreadable as missing. No model copies a document. The journal writes and the settlement are operation tasks, decided by rule. The Helmsman's schedule starts the run and reads its outcome, and writes no reflection itself.",
  },
};
