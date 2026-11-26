/**
 * The after-close reflection on the harness (Plan 343 Part C), driven as the
 * scheduler drives it: the day read runs the executor's own selection over a
 * scripted memory, the analyst and the writes are answered by a script, and
 * every decision is the skill's own rule.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  collectMemoryDocumentsSync,
  HostFileGetInputSchema,
  HostFilePutInputSchema,
  HostHarnessRunInputSchema,
  MemoryCollectInputSchema,
  MemoryGetInputSchema,
  MemoryPutInputSchema,
  type MemoryCollectListing,
  type MemoryCollectRead,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { reflectionCalendarWindow, reflectionTradingDay } from '../skillCatalog/exchangeClock.js';
import {
  ANALYST_TASK_ID,
  CALENDAR_WINDOW_TASK_ID,
  INGEST_CLOCK_TASK_ID,
  READ_CALENDAR_TASK_ID,
  READ_DAY_TASK_ID,
  READ_FOLDER_JOURNAL_ENTRY_TASK_ID,
  READ_JOURNAL_ENTRY_TASK_ID,
  SETTLE_REFLECTION_TASK_ID,
  TRADING_DAY_TASK_ID,
  REFLECTION_ANALYST_TASK,
  REFLECTION_DAY_KEYS,
  TRADING_REFLECTION,
  TRADING_REFLECTION_SLUG,
  WRITE_FOLDER_JOURNAL_TASK_ID,
  WRITE_JOURNAL_TASK_ID,
} from '../skillCatalog/tradingReflection.js';
import { CAMPAIGN_CONTRACT_FIELDS } from '../skillCatalog/tradingCampaignRead.js';
import { failWith, runSkillTasks, type TaskAnswer } from '@aflow/cybernetic-runtime';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = TRADING_REFLECTION.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];
const TRADING_DAY = '2026-07-14';
const INPUTS = { bindingId: 'hb_desk' };

/** Alpaca's clock after the close of TRADING_DAY, a Tuesday, exchange-local. */
const AFTER_CLOSE_CLOCK = {
  timestamp: `${TRADING_DAY}T16:45:03.512-04:00`,
  is_open: false,
  next_open: '2026-07-15T09:30:00-04:00',
  next_close: '2026-07-15T16:00:00-04:00',
};

/** The clock at 16:45 on Saturday 2026-11-21. */
const SATURDAY_CLOCK = {
  timestamp: '2026-11-21T16:45:00.000-05:00',
  is_open: false,
  next_open: '2026-11-23T09:30:00-05:00',
  next_close: '2026-11-23T16:00:00-05:00',
};

/** The clock at 16:45 on Thursday 2026-11-26, Thanksgiving: a weekday with no session. */
const THANKSGIVING_CLOCK = {
  timestamp: '2026-11-26T16:45:00.000-05:00',
  is_open: false,
  next_open: '2026-11-27T09:30:00-05:00',
  next_close: '2026-11-27T13:00:00-05:00',
};

const HOLIDAYS = new Set(['2026-07-03', '2026-11-26']);
const HALF_DAYS = new Set(['2026-11-27']);

/** Alpaca's calendar over a read's window: every weekday but a holiday, as `/v2/calendar` answers it. */
function sessionsBetween(start: string, end: string) {
  const sessions = [];
  for (let at = new Date(`${start}T00:00:00Z`); ; at.setUTCDate(at.getUTCDate() + 1)) {
    const date = at.toISOString().slice(0, 10);
    if (date > end) break;
    const weekday = at.getUTCDay();
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) continue;
    sessions.push({
      date,
      open: '09:30',
      close: HALF_DAYS.has(date) ? '13:00' : '16:00',
      session_open: '0400',
      session_close: '2000',
      settlement_date: date,
    });
  }
  return sessions;
}

const calendarFor = (input: Record<string, unknown>) => {
  const params = input['params'] as { start: string; end: string };
  return sessionsBetween(params.start, params.end);
};

/** The trading day a clock at `timestamp` derives, read through both derivers. */
function dayAt(timestamp: string, isOpen = false) {
  const window = reflectionCalendarWindow({ clock: { timestamp } });
  if (!window.ok) return window;
  const sessions = sessionsBetween(window.value.start, window.value.end);
  return reflectionTradingDay({
    clock: { timestamp, isOpen },
    calendar: { ...window.value, sessions },
  });
}

type Memory = Record<string, unknown>;

/** Every document the reflection reads about one day, as the cycles and the desk write them. */
function dayDocs(day: string): Memory {
  return {
    [`/portfolio/theses/cycles/${day}-open.json`]: { tradingDay: day, slot: 'open', opened: [] },
    [`/portfolio/theses/cycles/${day}-after_close.json`]: {
      tradingDay: day,
      slot: 'after_close',
      resolved: [{ thesisId: 'aapl-1', outcome: 'falsified' }],
    },
    [`/portfolio/snapshots/${day}-after_close.json`]: { tradingDay: day, equity: 100_412.5 },
    [`/research/${day}/approved-theses.json`]: {
      tradingDay: day,
      candidates: [{ candidateId: 'c1', instrument: 'AAPL' }],
      lenses: { macro: [{ candidateId: 'c1', verdict: 'rejected', reason: 'Rates.' }] },
      vetoes: [{ candidateId: 'c1', reason: 'The macro lens rejected it.' }],
    },
    [`/research/${day}/desk-runs/run-1.json`]: { tradingDay: day, outcome: 'set_written' },
  };
}

/** The memory of a space a few weeks into a campaign: the day, the day before it, and a journal. */
const MEMORY: Memory = {
  ...dayDocs('2026-07-13'),
  ...dayDocs(TRADING_DAY),
  ...dayDocs('2026-11-20'),
  '/portfolio/theses/resolved/aapl-1.json': {
    thesisId: 'aapl-1',
    resolvedTradingDay: TRADING_DAY,
    outcome: 'falsified',
  },
  '/portfolio/theses/resolved/msft-0.json': {
    thesisId: 'msft-0',
    resolvedTradingDay: '2026-07-10',
    outcome: 'confirmed',
  },
  '/portfolio/theses/resolved/nvda-2.json': {
    thesisId: 'nvda-2',
    resolvedTradingDay: '2026-07-13',
    outcome: 'confirmed',
    closeOrder: { filledAvgPrice: 131.2 },
  },
  ...Object.fromEntries(
    ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-13'].map(
      (day) => [`/research/journal/${day}.md`, `# ${day}\n\nThe entry for ${day}.`],
    ),
  ),
};

/**
 * When each resolved thesis was last written. nvda-2 resolved the day before
 * and its close order was patched on the day. Every other document is old.
 */
const WRITTEN: Record<string, string> = {
  '/portfolio/theses/resolved/aapl-1.json': `${TRADING_DAY}T18:31:00Z`,
  '/portfolio/theses/resolved/msft-0.json': '2026-07-10T20:05:00Z',
  '/portfolio/theses/resolved/nvda-2.json': `${TRADING_DAY}T13:40:00Z`,
};
const OLD_WRITE = '2026-01-01T00:00:00Z';

const without = (memory: Memory, ...paths: string[]) =>
  Object.fromEntries(Object.entries(memory).filter(([path]) => !paths.includes(path)));

/** The memory store the executor reads, over a scripted memory. */
function memoryStore(
  memory: Memory,
  unreadable: ReadonlySet<string>,
  written: Record<string, string> = WRITTEN,
) {
  return {
    list: ({ prefix, before, updatedSince, order, max }: MemoryCollectListing) => {
      const paths = Object.keys(memory)
        .filter((path) => path.startsWith(prefix))
        .filter((path) => before === undefined || path < before)
        .filter(
          (path) =>
            updatedSince === undefined ||
            Date.parse(written[path] ?? OLD_WRITE) > Date.parse(updatedSince),
        )
        .sort();
      if (order === 'desc') paths.reverse();
      return paths.slice(0, max);
    },
    read: (path: string): MemoryCollectRead => {
      if (unreadable.has(path)) {
        return { ok: false, reason: 'MEMORY_PAYLOAD_EXPIRED: document content has expired.' };
      }
      if (!(path in memory)) return { ok: false, reason: 'No document at this path.' };
      const content = memory[path];
      return { ok: true, docType: typeof content === 'string' ? 'markdown' : 'json', content };
    },
  };
}

const ENTRY = `# ${TRADING_DAY}\n\nThe macro lens vetoed one candidate. One thesis falsified.`;

function reflect(
  overrides: Record<string, TaskAnswer> = {},
  memory: Memory = MEMORY,
  unreadable: ReadonlySet<string> = new Set(),
  written: Record<string, string> = WRITTEN,
) {
  return runSkillTasks(
    tasks,
    INPUTS,
    (taskId, input) => {
      if (taskId in overrides) return overrides[taskId]!;
      if (taskId === INGEST_CLOCK_TASK_ID) return { data: AFTER_CLOSE_CLOCK };
      if (taskId === READ_CALENDAR_TASK_ID) return { data: calendarFor(input) };
      if (taskId === 'read-campaign') {
        return { campaigns: [{ campaign: { config: { regimeName: 'momentum-1' } } }] };
      }
      // A first reflection of the day: neither journal holds an entry for it.
      if (taskId === READ_JOURNAL_ENTRY_TASK_ID) return { found: false };
      if (taskId === READ_FOLDER_JOURNAL_ENTRY_TASK_ID)
        return { path: input['path'], found: false };
      if (taskId === READ_DAY_TASK_ID) {
        return collectMemoryDocumentsSync(
          MemoryCollectInputSchema.parse(input),
          memoryStore(memory, unreadable, written),
        );
      }
      if (taskId === ANALYST_TASK_ID) {
        return {
          result: {
            tradingDay: TRADING_DAY,
            headline: 'A veto held, and a falsification taught.',
            entry: ENTRY,
            followUps: ['Weigh the macro veto rate against tomorrow’s resolutions.'],
          },
          harness: { id: 'claude' },
        };
      }
      return { path: input['path'] ?? null };
    },
    wf.stateVariables,
    { runId: 'run-reflect-0714' },
  );
}

describe('Trading Reflection', () => {
  it('ships in the alpaca-thesis-trading bundle', () => {
    expect(getSkillCatalogEntry(TRADING_REFLECTION_SLUG)).toEqual(TRADING_REFLECTION);
    expect(getSkillBundleEntry('alpaca-thesis-trading')!.skillCatalogIds).toContain(
      TRADING_REFLECTION_SLUG,
    );
  });

  it('reads every named document of the day by code, and marks the ones memory lacks', () => {
    const run = reflect();
    const read = tasks.find((t) => t.taskId === READ_DAY_TASK_ID)!;
    expect(read).toMatchObject({ type: 'operation', operation: 'memory.store.collect' });
    const input = MemoryCollectInputSchema.parse(run.inputs.get(READ_DAY_TASK_ID));
    expect(input.sources.map((s) => s.key)).toEqual(REFLECTION_DAY_KEYS);
    const day = run.outputs.get(READ_DAY_TASK_ID)!;
    const paths = (key: string) => (day[key] as Array<{ path: string }>).map((doc) => doc.path);
    // Only the day's own cycle docs, never the day before.
    expect(paths('cycles')).toEqual([
      `/portfolio/theses/cycles/${TRADING_DAY}-after_close.json`,
      `/portfolio/theses/cycles/${TRADING_DAY}-open.json`,
    ]);
    expect(day['snapshot']).toEqual({
      path: `/portfolio/snapshots/${TRADING_DAY}-after_close.json`,
      docType: 'json',
      content: MEMORY[`/portfolio/snapshots/${TRADING_DAY}-after_close.json`],
    });
    expect(day['approvedSet']).toMatchObject({
      path: `/research/${TRADING_DAY}/approved-theses.json`,
      content: { lenses: { macro: [{ verdict: 'rejected' }] } },
    });
    expect(paths('deskRuns')).toEqual([`/research/${TRADING_DAY}/desk-runs/run-1.json`]);
    // The resolutions resolved on the day, not every resolved thesis.
    expect(paths('resolutions')).toEqual(['/portfolio/theses/resolved/aapl-1.json']);
    // The 5 latest journal entries before the day, latest first.
    expect(paths('journal')).toEqual(
      ['2026-07-13', '2026-07-10', '2026-07-09', '2026-07-08', '2026-07-07'].map(
        (d) => `/research/journal/${d}.md`,
      ),
    );
    expect(day['missing']).toEqual([]);
    expect(day['incomplete']).toEqual([]);

    const gaps = reflect(
      {},
      without(
        MEMORY,
        `/research/${TRADING_DAY}/approved-theses.json`,
        `/portfolio/snapshots/${TRADING_DAY}-after_close.json`,
      ),
    );
    const sparse = gaps.outputs.get(READ_DAY_TASK_ID)!;
    expect(sparse['approvedSet']).toEqual({
      path: `/research/${TRADING_DAY}/approved-theses.json`,
      missing: true,
      reason: 'No document at this path.',
    });
    expect(sparse['snapshot']).toMatchObject({ missing: true });
    expect(sparse['missing']).toEqual([
      `/portfolio/snapshots/${TRADING_DAY}-after_close.json`,
      `/research/${TRADING_DAY}/approved-theses.json`,
    ]);
    expect(gaps.state['reflectionOutcome']).toBe('written');
  });

  it('hands the analyst the day as data, and writes the entry to the journal path the bundle defines', () => {
    const run = reflect();
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.task).toBe(REFLECTION_ANALYST_TASK);
    expect(call.bindingId).toBe('hb_desk');
    const read = run.outputs.get(READ_DAY_TASK_ID)!;
    expect(call.inputs).toMatchObject({
      tradingDay: TRADING_DAY,
      day: Object.fromEntries(
        [...REFLECTION_DAY_KEYS, 'missing', 'incomplete'].map((key) => [key, read[key]]),
      ),
    });
    // Each document arrives whole: its path and its content.
    const day = call.inputs!['day'] as Record<string, unknown>;
    expect((day['resolutions'] as unknown[])[0]).toEqual({
      path: '/portfolio/theses/resolved/aapl-1.json',
      docType: 'json',
      content: MEMORY['/portfolio/theses/resolved/aapl-1.json'],
    });
    expect((day['journal'] as unknown[])[0]).toEqual({
      path: '/research/journal/2026-07-13.md',
      docType: 'markdown',
      content: MEMORY['/research/journal/2026-07-13.md'],
    });
    // The prompt is handed the day: it reads nothing from memory itself.
    expect(REFLECTION_ANALYST_TASK).toContain('The run has read the day from memory');
    expect(REFLECTION_ANALYST_TASK).not.toMatch(/memory\.store|copy/i);
    const validate = ajv.compile(call.outputSchema!);
    expect(validate({ tradingDay: TRADING_DAY, headline: 'h', entry: 'e', followUps: [] })).toBe(
      true,
    );
    expect(validate({ tradingDay: '2026-07-13', headline: 'h', entry: 'e', followUps: [] })).toBe(
      false,
    );

    const journal = MemoryPutInputSchema.parse(run.inputs.get(WRITE_JOURNAL_TASK_ID));
    expect(journal.path).toBe(`/research/journal/${TRADING_DAY}.md`);
    expect(journal.content).toEqual({ inlineText: ENTRY });
    const folder = HostFilePutInputSchema.parse(run.inputs.get(WRITE_FOLDER_JOURNAL_TASK_ID));
    // The first reflection meets a folder with no journal/ directory.
    expect(folder).toMatchObject({
      path: `journal/${TRADING_DAY}.md`,
      content: ENTRY,
      createParents: true,
    });
    expect(run.state).toMatchObject({
      tradingDay: TRADING_DAY,
      reflectionOutcome: 'written',
      journalPath: `/research/journal/${TRADING_DAY}.md`,
      folderJournalPath: `journal/${TRADING_DAY}.md`,
      headline: 'A veto held, and a falsification taught.',
    });
    // The bundle defines the same path, and the desk reads it.
    const doc = getSkillBundleEntry('alpaca-thesis-trading')!.memorySeed[0]!.content;
    expect(doc).toContain('## Journal — `/research/journal/{tradingDay}.md`');
  });

  it('reads only the resolved theses written since the day began, never the whole ledger', () => {
    const run = reflect();
    const input = MemoryCollectInputSchema.parse(run.inputs.get(READ_DAY_TASK_ID));
    const resolutions = input.sources.find((s) => s.key === 'resolutions')!;
    expect(resolutions).toMatchObject({
      pathPrefix: '/portfolio/theses/resolved/',
      updatedSince: `${TRADING_DAY}T00:00:00Z`,
      where: { resolvedTradingDay: TRADING_DAY },
    });
    const store = memoryStore(MEMORY, new Set());
    const reads: string[] = [];
    collectMemoryDocumentsSync(
      { sources: [resolutions] },
      { list: store.list, read: (path) => (reads.push(path), store.read(path)) },
    );
    // nvda-2 was patched on the day, so it is read and its own day filters it out.
    expect(reads).toEqual([
      '/portfolio/theses/resolved/aapl-1.json',
      '/portfolio/theses/resolved/nvda-2.json',
    ]);
  });

  it('hands the analyst the lists the read could not scan whole', () => {
    // A day that rewrote more resolved docs than one read scans.
    const ledger = Array.from(
      { length: 1001 },
      (_, i) => `/portfolio/theses/resolved/t-${String(i).padStart(4, '0')}.json`,
    );
    const run = reflect(
      {},
      {
        ...MEMORY,
        ...Object.fromEntries(ledger.map((path) => [path, { resolvedTradingDay: '2026-07-13' }])),
      },
      new Set(),
      {
        ...WRITTEN,
        ...Object.fromEntries(ledger.map((path) => [path, `${TRADING_DAY}T14:00:00Z`])),
      },
    );
    const analyst = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    const day = analyst.inputs!['day'] as Record<string, unknown>;
    expect(day['incomplete']).toEqual(['resolutions']);
    expect(REFLECTION_ANALYST_TASK).toContain('`day.incomplete`');
    expect(run.state['reflectionOutcome']).toBe('written');
  });

  it('a journal doc that is missing or unreadable never fails the reflection', () => {
    const journalPaths = Object.keys(MEMORY).filter((p) => p.startsWith('/research/journal/'));
    const noJournal = reflect({}, without(MEMORY, ...journalPaths));
    expect(noJournal.outputs.get(READ_DAY_TASK_ID)!['journal']).toEqual([]);
    expect(noJournal.ran).toContain(ANALYST_TASK_ID);
    expect(noJournal.state['reflectionOutcome']).toBe('written');

    const expired = '/research/journal/2026-07-10.md';
    const unreadable = reflect({}, MEMORY, new Set([expired]));
    const analyst = HostHarnessRunInputSchema.parse(unreadable.inputs.get(ANALYST_TASK_ID));
    const day = analyst.inputs!['day'] as Record<string, unknown>;
    expect(day['journal']).toContainEqual({
      path: expired,
      missing: true,
      reason: expect.stringContaining('MEMORY_PAYLOAD_EXPIRED') as unknown as string,
    });
    expect(day['missing']).toEqual([expired]);
    expect(unreadable.state['reflectionOutcome']).toBe('written');
  });

  it('runs no model but the analyst: the day read is code, and the writes are operations', () => {
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual([ANALYST_TASK_ID]);
    // No Runner copies documents: the flow holds no agent task at all.
    expect(tasks.filter((t) => t.type === 'agent')).toEqual([]);
    for (const task of tasks.filter((t) => t.taskId !== ANALYST_TASK_ID)) {
      expect(task.type, task.taskId).toBe('operation');
      expect(task.operation, task.taskId).not.toMatch(/^(ai|host\.harness)\./);
    }
    expect(tasks.find((t) => t.taskId === READ_DAY_TASK_ID)!.goal).toContain('No model is asked');
  });

  it('the analyst reads only the fields the campaign contract declares', () => {
    const declared = Object.fromEntries(CAMPAIGN_CONTRACT_FIELDS.map((field) => [field, null]));
    const current = { ...declared, regimeName: 'momentum-1', universe: ['SPY', 'AAPL'] };
    const legacy = {
      ...current,
      maxThesesPerDay: 3,
      maxPositionSizePct: 8,
      maxGrossExposurePct: 60,
      regimeCaps: { stressed: 27 },
    };
    const run = reflect({
      'read-campaign': { campaigns: [{ campaign: { config: legacy } }] },
    });
    const analyst = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(analyst.inputs?.['campaign']).toEqual(current);
    expect(JSON.stringify(analyst.inputs)).not.toMatch(
      /maxThesesPerDay|maxPositionSizePct|maxGrossExposurePct|regimeCaps/,
    );
    // The day read binds the day alone.
    expect(Object.keys(tasks.find((t) => t.taskId === READ_DAY_TASK_ID)!.inputBindings!)).toEqual([
      'tradingDay',
    ]);
    // With no active campaign the analyst still runs, every declared field null.
    const none = reflect({ 'read-campaign': { campaigns: [] } });
    const bare = HostHarnessRunInputSchema.parse(none.inputs.get(ANALYST_TASK_ID));
    expect(bare.inputs?.['campaign']).toEqual(declared);
  });

  it('settles day_unread only where memory holds no cycle doc and no snapshot for the day', () => {
    const core = [
      `/portfolio/theses/cycles/${TRADING_DAY}-open.json`,
      `/portfolio/theses/cycles/${TRADING_DAY}-after_close.json`,
      `/portfolio/snapshots/${TRADING_DAY}-after_close.json`,
    ];
    const noDay = reflect({}, without(MEMORY, ...core));
    expect(noDay.statuses.get(READ_DAY_TASK_ID)).toBe('succeeded');
    expect(noDay.ran).not.toContain(ANALYST_TASK_ID);
    expect(noDay.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(noDay.state['reflectionOutcome']).toBe('day_unread');
    // Either core document alone is a day to read.
    for (const kept of [core[1]!, core[2]!]) {
      const run = reflect({}, without(MEMORY, ...core.filter((p) => p !== kept)));
      expect(run.ran, kept).toContain(ANALYST_TASK_ID);
      expect(run.state['reflectionOutcome'], kept).toBe('written');
    }
  });

  it('a memory store that does not answer settles memory_unreachable, never day_unread', () => {
    const run = reflect({ [READ_DAY_TASK_ID]: failWith('connection terminated') });
    expect(run.ran).not.toContain(ANALYST_TASK_ID);
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.state['reflectionOutcome']).toBe('memory_unreachable');
    expect(run.state['reflectionReason']).toContain('read-day');
    const noAnalyst = reflect({ [ANALYST_TASK_ID]: 'fail' });
    expect(noAnalyst.state['reflectionOutcome']).toBe('no_entry');
  });

  it('takes the trading day from the exchange clock, never from its caller', () => {
    expect(wf.runInputs!.map((input) => input.id)).not.toContain('tradingDay');
    expect(tasks[0]!.taskId).toBe(INGEST_CLOCK_TASK_ID);
    expect(tasks[0]!.inputContract?.bindings).not.toHaveProperty('tradingDay');
    for (const task of tasks) {
      for (const binding of Object.values(task.inputBindings ?? {})) {
        expect(binding).not.toEqual({ kind: 'run_input', path: 'tradingDay' });
      }
    }
    const run = reflect();
    expect(run.inputs.get(TRADING_DAY_TASK_ID)).toMatchObject({
      args: { clock: { timestamp: AFTER_CLOSE_CLOCK.timestamp } },
    });
    expect(run.state['tradingDay']).toBe(TRADING_DAY);
  });

  it('a Saturday clock reflects on the Friday session that closed last', () => {
    const run = reflect({ [INGEST_CLOCK_TASK_ID]: { data: SATURDAY_CLOCK } });
    expect(run.statuses.get(TRADING_DAY_TASK_ID)).toBe('succeeded');
    expect(run.inputs.get(WRITE_JOURNAL_TASK_ID)).toMatchObject({
      path: '/research/journal/2026-11-20.md',
    });
    expect(run.state).toMatchObject({ tradingDay: '2026-11-20', reflectionOutcome: 'written' });
  });

  it('a weekday market holiday meets the session before it, already reflected, and writes nothing', () => {
    // Wednesday's own run has written the 2026-11-25 entry to both journals.
    const run = reflect({
      [INGEST_CLOCK_TASK_ID]: { data: THANKSGIVING_CLOCK },
      [READ_JOURNAL_ENTRY_TASK_ID]: { stat: { path: '/research/journal/2026-11-25.md' } },
      [READ_FOLDER_JOURNAL_ENTRY_TASK_ID]: {
        path: 'journal/2026-11-25.md',
        revision: 'sha256:wednesday',
        encoding: 'utf8',
        content: '# 2026-11-25',
        sizeBytes: 12,
      },
    });
    expect(run.inputs.get(READ_CALENDAR_TASK_ID)).toMatchObject({
      endpointId: 'get_calendar',
      params: { start: '2026-11-19', end: '2026-11-26' },
    });
    expect(MemoryGetInputSchema.parse(run.inputs.get(READ_JOURNAL_ENTRY_TASK_ID))).toMatchObject({
      target: { path: '/research/journal/2026-11-25.md' },
      ifMissing: 'absent',
    });
    expect(
      HostFileGetInputSchema.parse(run.inputs.get(READ_FOLDER_JOURNAL_ENTRY_TASK_ID)),
    ).toMatchObject({ bindingId: 'hb_desk', path: 'journal/2026-11-25.md', ifMissing: 'absent' });
    expect(run.ran).not.toContain(READ_DAY_TASK_ID);
    expect(run.ran).not.toContain(ANALYST_TASK_ID);
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.statuses.get(WRITE_FOLDER_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.state).toMatchObject({
      tradingDay: '2026-11-25',
      reflectionOutcome: 'already_reflected',
    });
    expect(run.state['journalPath']).toBeUndefined();
    expect(run.state['folderJournalPath']).toBeUndefined();
  });

  it('an entry in either journal alone settles already_reflected, and the other journal is left', () => {
    for (const held of [
      { [READ_JOURNAL_ENTRY_TASK_ID]: { stat: { path: `/research/journal/${TRADING_DAY}.md` } } },
      {
        [READ_FOLDER_JOURNAL_ENTRY_TASK_ID]: {
          path: `journal/${TRADING_DAY}.md`,
          revision: 'sha256:earlier',
          encoding: 'utf8',
          content: ENTRY,
          sizeBytes: ENTRY.length,
        },
      },
    ]) {
      const run = reflect(held);
      expect(run.ran).not.toContain(ANALYST_TASK_ID);
      expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
      expect(run.statuses.get(WRITE_FOLDER_JOURNAL_TASK_ID)).toBe('skipped');
      expect(run.state['reflectionOutcome']).toBe('already_reflected');
    }
  });

  it('a journal lookup that fails reads no day, writes nothing, and settles journal_unread', () => {
    for (const taskId of [READ_JOURNAL_ENTRY_TASK_ID, READ_FOLDER_JOURNAL_ENTRY_TASK_ID]) {
      const run = reflect({ [taskId]: failWith('The lookup failed.') });
      expect(run.ran).not.toContain(READ_DAY_TASK_ID);
      expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
      expect(run.statuses.get(WRITE_FOLDER_JOURNAL_TASK_ID)).toBe('skipped');
      expect(run.state['reflectionOutcome']).toBe('journal_unread');
      expect(run.state['reflectionReason']).toContain(taskId);
    }
  });

  it('an open market reads no day and settles no_session', () => {
    const run = reflect({
      [INGEST_CLOCK_TASK_ID]: {
        data: {
          ...AFTER_CLOSE_CLOCK,
          timestamp: `${TRADING_DAY}T11:00:00.000-04:00`,
          is_open: true,
        },
      },
    });
    expect(run.statuses.get(TRADING_DAY_TASK_ID)).toBe('failed');
    expect(run.ran).not.toContain(READ_DAY_TASK_ID);
    expect(run.ran).not.toContain(ANALYST_TASK_ID);
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.state['reflectionOutcome']).toBe('no_session');
    expect(run.state['tradingDay']).toBeUndefined();
  });

  it('rolls back through the calendar window to the session that closed last', () => {
    for (const [timestamp, tradingDay] of [
      // Late on Saturday, after 09:30, and on Sunday: Friday's session.
      ['2026-11-21T10:00:00-05:00', '2026-11-20'],
      ['2026-11-22T16:45:00-05:00', '2026-11-20'],
      // Monday before the open: Friday's session.
      ['2026-11-23T08:00:00-05:00', '2026-11-20'],
      // Thanksgiving, and the morning after it: Wednesday's session.
      [THANKSGIVING_CLOCK.timestamp, '2026-11-25'],
      ['2026-11-27T08:00:00-05:00', '2026-11-25'],
      // Monday before the open after a Friday holiday: Thursday's session, four dates back.
      ['2026-07-03T16:45:00-04:00', '2026-07-02'],
      ['2026-07-06T08:00:00-04:00', '2026-07-02'],
    ] as const) {
      expect(dayAt(timestamp), timestamp).toEqual({ ok: true, value: { tradingDay } });
    }
    const empty = reflectionTradingDay({
      clock: { timestamp: '2026-11-23T08:00:00-05:00', isOpen: false },
      calendar: { start: '2026-11-16', end: '2026-11-23', sessions: [] },
    });
    expect(!empty.ok && empty.message).toContain(
      'holds no session from 2026-11-16 that has closed by 08:00 on 2026-11-23',
    );
  });

  it('derives the day only once its session has closed', () => {
    expect(dayAt('2026-11-23T16:45:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-23' },
    });
    expect(dayAt('2026-11-23T11:00:00-05:00', true).ok).toBe(false);
    const halted = dayAt('2026-11-23T15:00:00-05:00');
    expect(!halted.ok && halted.message).toContain('closes at 16:00');
    // A half day has closed at 13:00.
    expect(dayAt('2026-11-27T14:00:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-27' },
    });
    expect(reflectionTradingDay({ clock: { timestamp: 'now' } }).ok).toBe(false);
    expect(reflectionCalendarWindow({ clock: { timestamp: 'now' } }).ok).toBe(false);
  });

  it('a late reflection still reflects on the session that closed', () => {
    for (const timestamp of [
      '2026-11-23T23:59:00-05:00',
      '2026-11-24T00:30:00-05:00',
      '2026-11-24T09:29:00-05:00',
    ]) {
      expect(dayAt(timestamp), timestamp).toEqual({
        ok: true,
        value: { tradingDay: '2026-11-23' },
      });
    }
    // Friday's reflection, fired after midnight on Saturday.
    expect(dayAt('2026-11-21T00:30:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-20' },
    });
    const run = reflect({
      [INGEST_CLOCK_TASK_ID]: {
        data: { ...AFTER_CLOSE_CLOCK, timestamp: '2026-07-15T00:30:00.000-04:00' },
      },
    });
    expect(run.inputs.get(CALENDAR_WINDOW_TASK_ID)).toMatchObject({
      args: { clock: { timestamp: '2026-07-15T00:30:00.000-04:00' } },
    });
    expect(run.state).toMatchObject({ tradingDay: TRADING_DAY, reflectionOutcome: 'written' });
  });

  it('refuses a day the calendar read does not cover', () => {
    const derived = reflectionTradingDay({
      clock: { timestamp: '2026-11-23T16:45:00-05:00', isOpen: false },
      calendar: { start: '2026-11-10', end: '2026-11-17', sessions: [] },
    });
    expect(!derived.ok && derived.message).toContain('covers 2026-11-10 to 2026-11-17');
  });

  it('names the remedy for a stored account-read definition without the calendar endpoint', () => {
    const pitfalls = (wf.usage?.pitfalls ?? []).join('\n');
    expect(pitfalls).toContain(
      'stored alpaca-account-read definition declares no endpoint "get_calendar"',
    );
    expect(pitfalls).toContain('Store → Update, which rewrites that definition');
  });

  it('a folder copy that fails surfaces in the outcome, and never reads written', () => {
    const run = reflect({
      [WRITE_FOLDER_JOURNAL_TASK_ID]: failWith('The folder allows no writes.'),
    });
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('succeeded');
    expect(run.ran).toContain(SETTLE_REFLECTION_TASK_ID);
    expect(run.state).toMatchObject({
      reflectionOutcome: 'folder_unwritten',
      journalPath: `/research/journal/${TRADING_DAY}.md`,
    });
    expect(run.state['reflectionReason']).toContain('write-folder-journal');
    expect(run.state['folderJournalPath']).toBeUndefined();
  });

  it('the Helmsman schedule fires it and keeps only supervision', () => {
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    const hints = bundle.helmsmanHints.join('\n');
    expect(hints).toContain('45 16 * * 1-5');
    expect(hints).toContain('starts trading-reflection');
    expect(hints).toContain('write no reflection');
    expect(hints).toContain('starts trading-reflection with { bindingId } alone');
    expect(hints).not.toContain('{ bindingId, tradingDay }');
    expect(bundle.description).not.toContain('{ bindingId, tradingDay }');
    expect(hints).not.toContain('reflect on the day after the close');
    expect(bundle.description).toContain('the Helmsman writes no reflection itself');
  });
});
