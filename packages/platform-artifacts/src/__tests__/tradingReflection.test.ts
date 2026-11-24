/**
 * The after-close reflection on the harness (Plan 343 Part C), driven as the
 * scheduler drives it: the day read, the analyst and the writes answered by a
 * script, every decision the skill's own rule.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  HostFilePutInputSchema,
  HostHarnessRunInputSchema,
  MemoryPutInputSchema,
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
  SETTLE_REFLECTION_TASK_ID,
  TRADING_DAY_TASK_ID,
  REFLECTION_ANALYST_TASK,
  TRADING_REFLECTION,
  TRADING_REFLECTION_SLUG,
  WRITE_FOLDER_JOURNAL_TASK_ID,
  WRITE_JOURNAL_TASK_ID,
} from '../skillCatalog/tradingReflection.js';
import { failWith, runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

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

const DAY = {
  cycles: [
    { path: `/portfolio/theses/cycles/${TRADING_DAY}-after_close.json`, slot: 'after_close' },
  ],
  deskRecords: [{ path: `/research/${TRADING_DAY}/desk-open.json`, outcome: 'set_written' }],
  deskRuns: [],
  lensReviews: [{ path: `/research/${TRADING_DAY}/lens-reviews/open-run-1-round-1.json` }],
  resolutions: [{ path: '/portfolio/theses/resolved/aapl-1.json', outcome: 'falsified' }],
  snapshot: null,
  journal: [],
  readNote: 'Read the day. No snapshot yet.',
};

const ENTRY = `# ${TRADING_DAY}\n\nThe macro lens vetoed one candidate. One thesis falsified.`;

function reflect(overrides: Record<string, TaskAnswer> = {}) {
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
      if (taskId === READ_DAY_TASK_ID) return DAY;
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

  it('the reflection harness run writes the journal entry to the journal path the bundle defines', () => {
    const run = reflect();
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.task).toBe(REFLECTION_ANALYST_TASK);
    expect(call.bindingId).toBe('hb_desk');
    // The analyst reads the day's cycle docs, desk records, lens records, resolutions and journal.
    expect(call.inputs).toMatchObject({ tradingDay: TRADING_DAY, day: DAY });
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

  it('runs the analysis on the harness alone: the Runner only reads, and the writes are operations', () => {
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual([ANALYST_TASK_ID]);
    const agents = tasks.filter((t) => t.type === 'agent');
    expect(agents.map((t) => t.taskId)).toEqual([READ_DAY_TASK_ID]);
    expect(agents[0]!.context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
    for (const taskId of [WRITE_JOURNAL_TASK_ID, WRITE_FOLDER_JOURNAL_TASK_ID]) {
      expect(tasks.find((t) => t.taskId === taskId)?.type).toBe('operation');
    }
  });

  it('a day it cannot read writes no entry, and says why', () => {
    const run = reflect({ [READ_DAY_TASK_ID]: 'fail' });
    expect(run.ran).not.toContain(ANALYST_TASK_ID);
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.state['reflectionOutcome']).toBe('day_unread');
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

  it('a weekday market holiday reflects on the session before it', () => {
    const run = reflect({ [INGEST_CLOCK_TASK_ID]: { data: THANKSGIVING_CLOCK } });
    expect(run.inputs.get(READ_CALENDAR_TASK_ID)).toMatchObject({
      endpointId: 'get_calendar',
      params: { start: '2026-11-19', end: '2026-11-26' },
    });
    expect(run.state).toMatchObject({ tradingDay: '2026-11-25', reflectionOutcome: 'written' });
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
    expect(bundle.description).toContain(
      'the Helmsman supervises the run and writes no reflection',
    );
  });
});
