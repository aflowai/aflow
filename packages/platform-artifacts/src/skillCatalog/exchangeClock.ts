/**
 * The exchange clock as the trading skills read it, and the trading day a
 * Trading Reflection derives from it. The clock is the one source of the
 * day: a caller's prompt and a model's reasoning name no date.
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

/** The deriver the reflection's trading-day task names: `reflectionTradingDay`, registered by the runtime. */
export const REFLECTION_DAY_DERIVER = 'trading.reflection-day' as const;

/** How the reflection's trading day follows from the clock, for every contract and doc that names it. */
export const REFLECTION_DAY_RULE =
  "The trading day is the date of the exchange clock's timestamp, which is exchange-local. The run reflects on it only once its session has closed: the market is closed, and the clock's nextOpen falls on a later date. A Saturday or a Sunday has no session, so the run reads nothing and writes no entry";

const EXCHANGE_TIME = /^\d{4}-\d{2}-\d{2}T/;

const ReflectionClockSchema = z.object({
  timestamp: z.string().regex(EXCHANGE_TIME),
  isOpen: z.boolean(),
  nextOpen: z.string().regex(EXCHANGE_TIME),
});

const WEEKEND = new Map([
  [0, 'Sunday'],
  [6, 'Saturday'],
]);

export type ReflectionDayDerivation =
  { ok: true; value: { tradingDay: string } } | { ok: false; message: string };

const refuse = (message: string): ReflectionDayDerivation => ({
  ok: false,
  message: `${message} The reflection reads no day and writes no journal entry.`,
});

/**
 * The trading day a reflection reflects on, by `REFLECTION_DAY_RULE`. A clock
 * date whose session has not closed is refused, never moved to another day,
 * so a reflection never names a day the clock does not give.
 */
export function reflectionTradingDay(args: unknown): ReflectionDayDerivation {
  const parsed = ReflectionClockSchema.safeParse((args as { clock?: unknown } | null)?.clock);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return refuse(`The exchange clock does not parse (${detail}).`);
  }
  const { timestamp, isOpen, nextOpen } = parsed.data;
  const day = timestamp.slice(0, 10);
  const weekday = WEEKEND.get(new Date(`${day}T00:00:00Z`).getUTCDay());
  if (weekday !== undefined) {
    return refuse(`The exchange date ${day} is a ${weekday}, so no session closed on it.`);
  }
  if (isOpen) {
    return refuse(`The market is open on ${day}, so its session has not closed.`);
  }
  if (nextOpen.slice(0, 10) <= day) {
    return refuse(`The session of ${day} opens at ${nextOpen}, so it has not closed.`);
  }
  return { ok: true, value: { tradingDay: day } };
}
