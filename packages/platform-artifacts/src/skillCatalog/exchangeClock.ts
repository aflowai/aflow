/**
 * The exchange clock and calendar as the trading skills read them, and the
 * trading day a Trading Reflection derives from them. They are the one source
 * of the day: a caller's prompt and a model's reasoning name no date.
 */
import { z } from 'zod';

/** The Alpaca clock read: a task spreads it into an `api.http.call` operation task. */
export const EXCHANGE_CLOCK_READ = {
  operation: 'api.http.call',
  inputTemplate: {
    apiId: 'alpaca-account-read',
    endpointId: 'get_clock',
    response: { format: 'json' },
  },
  outputProjection: {
    timestamp: { path: 'data.timestamp', onMissing: 'error' as const },
    isOpen: { path: 'data.is_open', onMissing: 'error' as const },
    nextOpen: { path: 'data.next_open', onMissing: 'error' as const },
    nextClose: { path: 'data.next_close', onMissing: 'error' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['timestamp', 'isOpen', 'nextOpen', 'nextClose'],
      additionalProperties: false,
      properties: {
        timestamp: { type: 'string' },
        isOpen: { type: 'boolean' },
        nextOpen: { type: 'string' },
        nextClose: { type: 'string' },
      },
    },
  },
};

/**
 * The Alpaca calendar read: one entry per session in `[start, end]`, its open
 * and close exchange-local, so a weekend or a market holiday has no entry.
 */
export const EXCHANGE_CALENDAR_READ = {
  operation: 'api.http.call',
  inputTemplate: {
    apiId: 'alpaca-account-read',
    endpointId: 'get_calendar',
    params: { start: { $bind: 'start' }, end: { $bind: 'end' } },
    response: { format: 'json' },
  },
  outputProjection: { sessions: { path: 'data', onMissing: 'error' as const } },
  outputContract: {
    schema: {
      type: 'object',
      required: ['sessions'],
      additionalProperties: false,
      properties: {
        sessions: {
          type: 'array',
          maxItems: 31,
          items: {
            type: 'object',
            required: ['date', 'open', 'close'],
            additionalProperties: true,
            properties: {
              date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              open: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
              close: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
            },
          },
        },
      },
    },
  },
};

/** The deriver the reflection's calendar-window task names: `reflectionCalendarWindow`, registered by the runtime. */
export const REFLECTION_CALENDAR_WINDOW_DERIVER = 'trading.reflection-calendar-window' as const;

/** The deriver the reflection's trading-day task names: `reflectionTradingDay`, registered by the runtime. */
export const REFLECTION_DAY_DERIVER = 'trading.reflection-day' as const;

/** The deriver the Daily Trading Cycle's trading-day task names: `cycleTradingDay`, registered by the runtime. */
export const CYCLE_DAY_DERIVER = 'trading.cycle-day' as const;

/** The deriver the Daily Trading Cycle's calendar-window task names: `cycleCalendarWindow`, registered by the runtime. */
export const CYCLE_CALENDAR_WINDOW_DERIVER = 'trading.cycle-calendar-window' as const;

/** How the cycle's trading day follows from the clock and the calendar, for every contract and doc that names it. */
export const CYCLE_DAY_RULE =
  "On pre_market, open and intraday the trading day is the date part of the exchange clock's timestamp, which is exchange-local. On after_close it is the session the run closes: the latest session on the exchange calendar that has closed by the clock's timestamp, on or before its date. A delayed or retried after_close run that starts after midnight therefore still reports the session it closes. With no slot named, the slot is after_close when the market is closed and the next open falls on a later date";

/** How many dates before the clock's date the calendar read covers. */
export const REFLECTION_CALENDAR_LOOKBACK_DAYS = 7;

/** How the reflection's trading day follows from the clock and the calendar, for every contract and doc that names it. */
export const REFLECTION_DAY_RULE =
  "The trading day is the latest session on the exchange calendar that has closed by the exchange clock's timestamp, which is exchange-local. A reflection that fires after midnight, before the next open, on a weekend or on a market holiday therefore reads the session that closed last. The run refuses the day while the market is open or while the clock's own session has opened and not closed. A calendar read that holds no closed session also refuses it, so the run reads nothing and writes no entry";

const EXCHANGE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

const ClockSchema = z.object({ timestamp: z.string().regex(EXCHANGE_TIME) });

const CalendarSchema = z.object({
  start: z.string().regex(DATE),
  end: z.string().regex(DATE),
  sessions: z.array(
    z.object({
      date: z.string().regex(DATE),
      open: z.string().regex(TIME),
      close: z.string().regex(TIME),
    }),
  ),
});

type Calendar = z.infer<typeof CalendarSchema>;

const ReflectionDayArgsSchema = z.object({
  clock: ClockSchema.extend({ isOpen: z.boolean() }),
  calendar: CalendarSchema,
});

const CycleDayArgsSchema = z.object({
  clock: ClockSchema.extend({ isOpen: z.boolean(), nextOpen: z.string().regex(EXCHANGE_TIME) }),
  slot: z.string().optional(),
  calendar: CalendarSchema,
});

/** The latest session in `calendar` that has closed by `time` on `date`, both exchange-local. */
function latestClosedSession(calendar: Calendar, date: string, time: string): string | undefined {
  let latest: string | undefined;
  for (const session of calendar.sessions) {
    if (session.date < calendar.start) continue;
    const closed = session.date < date || (session.date === date && time >= session.close);
    if (closed && (latest === undefined || session.date > latest)) latest = session.date;
  }
  return latest;
}

export type ReflectionDerivation<T> = { ok: true; value: T } | { ok: false; message: string };
export type ReflectionDayDerivation = ReflectionDerivation<{ tradingDay: string }>;

const refuse = (message: string): { ok: false; message: string } => ({
  ok: false,
  message: `${message} The reflection reads no day and writes no journal entry.`,
});

const issuesOf = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');

/** The date `days` calendar days from `date`, both YYYY-MM-DD. */
function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The calendar dates the reflection reads: the clock's date and the
 * `REFLECTION_CALENDAR_LOOKBACK_DAYS` before it, so the read holds the
 * session a late reflection rolls back to across a weekend and a holiday.
 */
export function reflectionCalendarWindow(
  args: unknown,
): ReflectionDerivation<{ start: string; end: string }> {
  const parsed = ClockSchema.safeParse((args as { clock?: unknown } | null)?.clock);
  if (!parsed.success) {
    return refuse(`The exchange clock does not parse (${issuesOf(parsed.error)}).`);
  }
  return { ok: true, value: calendarWindowEndingOn(parsed.data.timestamp.slice(0, 10)) };
}

const calendarWindowEndingOn = (end: string): { start: string; end: string } => ({
  start: shiftDate(end, -REFLECTION_CALENDAR_LOOKBACK_DAYS),
  end,
});

const refuseCycle = (message: string): { ok: false; message: string } => ({
  ok: false,
  message: `${message} The cycle reads no day and does not run.`,
});

/**
 * The calendar dates a Daily Trading Cycle reads: the clock's date and the
 * `REFLECTION_CALENDAR_LOOKBACK_DAYS` before it, so an after_close run reaches
 * the session it closes across a weekend and a holiday.
 */
export function cycleCalendarWindow(
  args: unknown,
): ReflectionDerivation<{ start: string; end: string }> {
  const parsed = ClockSchema.safeParse((args as { clock?: unknown } | null)?.clock);
  if (!parsed.success) {
    return refuseCycle(`The exchange clock does not parse (${issuesOf(parsed.error)}).`);
  }
  return { ok: true, value: calendarWindowEndingOn(parsed.data.timestamp.slice(0, 10)) };
}

/**
 * The trading day a Daily Trading Cycle runs for, by `CYCLE_DAY_RULE`. Before
 * the close, the day is the clock's date, and resolve-theses decides whether
 * the slot has a session behind it. An after_close run takes the session it
 * closes, so one that starts after midnight does not skip that session.
 */
export function cycleTradingDay(args: unknown): ReflectionDayDerivation {
  const parsed = CycleDayArgsSchema.safeParse(args);
  if (!parsed.success) {
    return refuseCycle(
      `The exchange clock or calendar does not parse (${issuesOf(parsed.error)}).`,
    );
  }
  const { clock, slot, calendar } = parsed.data;
  const date = clock.timestamp.slice(0, 10);
  const afterClose =
    slot === 'after_close' ||
    (slot === undefined && !clock.isOpen && clock.nextOpen.slice(0, 10) > date);
  if (!afterClose) return { ok: true, value: { tradingDay: date } };
  if (date < calendar.start || date > calendar.end) {
    return refuseCycle(
      `The calendar read covers ${calendar.start} to ${calendar.end}, not ${date}.`,
    );
  }
  const time = clock.timestamp.slice(11, 16);
  const closed = latestClosedSession(calendar, date, time);
  if (closed === undefined) {
    return refuseCycle(
      `The exchange calendar holds no session from ${calendar.start} that has closed by ${time} on ${date}, so the after_close run has no session to close.`,
    );
  }
  return { ok: true, value: { tradingDay: closed } };
}

/**
 * The trading day a reflection reflects on, by `REFLECTION_DAY_RULE`. Only a
 * date the calendar holds a session for is returned, so a reflection never
 * journals a day that had no session. A session in progress is refused, never
 * moved to the one before it, so the reflection waits for its close.
 */
export function reflectionTradingDay(args: unknown): ReflectionDayDerivation {
  const parsed = ReflectionDayArgsSchema.safeParse(args);
  if (!parsed.success) {
    return refuse(`The exchange clock or calendar does not parse (${issuesOf(parsed.error)}).`);
  }
  const { clock, calendar } = parsed.data;
  const date = clock.timestamp.slice(0, 10);
  const time = clock.timestamp.slice(11, 16);
  if (clock.isOpen) {
    return refuse(`The market is open on ${date}, so its session has not closed.`);
  }
  if (date < calendar.start || date > calendar.end) {
    return refuse(`The calendar read covers ${calendar.start} to ${calendar.end}, not ${date}.`);
  }
  const today = calendar.sessions.find((s) => s.date === date);
  if (today !== undefined && time >= today.open && time < today.close) {
    return refuse(`The session of ${date} closes at ${today.close}, so it has not closed.`);
  }
  const latest = latestClosedSession(calendar, date, time);
  if (latest === undefined) {
    return refuse(
      `The exchange calendar holds no session from ${calendar.start} that has closed by ${time} on ${date}.`,
    );
  }
  return { ok: true, value: { tradingDay: latest } };
}
