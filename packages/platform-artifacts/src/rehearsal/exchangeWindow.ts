import { REHEARSAL_EXCHANGE_WINDOW_RULES, type RehearsalExchangeWindow } from '@aflow/schemas';

/** One session of the exchange calendar, its open and close exchange-local. */
export interface ExchangeSession {
  date: string;
  open: string;
  close: string;
}

/** The exchange clock and calendar, as the bundle's own clock and calendar reads give them. */
export interface ExchangeReading {
  /** The clock's timestamp, exchange-local with its offset. */
  timestamp: string;
  isOpen: boolean;
  /** The calendar's sessions from the clock's date on. */
  sessions: ExchangeSession[];
}

export type ExchangeWindowVerdict =
  { open: true; date: string } | { open: false; detail: string; nextOpensAt: string | null };

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** The exchange-local date of a clock timestamp, or null when it names none. */
export function exchangeClockDate(timestamp: string): string | null {
  return STAMP.exec(timestamp)?.[1] ?? null;
}

const at = (date: string, time: string) => `${date}T${time}`;

/**
 * When a rehearsal started afresh would next find the window open, by the
 * calendar read. A fresh rehearsal takes its trading day from the clock, so
 * the rehearsal's own trading day plays no part.
 */
function nextOpening(
  window: RehearsalExchangeWindow,
  sessions: readonly ExchangeSession[],
  date: string,
  time: string,
): string | null {
  const next = [...sessions]
    .filter((s) => s.date >= date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  if (next === undefined) return null;
  if (next.date > date) return at(next.date, window === 'session_day' ? '00:00' : next.close);
  if (window === 'session_day') return at(date, time);
  return at(date, time < next.close ? next.close : time);
}

/**
 * Whether the exchange clock and calendar put `window` open, by
 * `REHEARSAL_EXCHANGE_WINDOW_RULES`. Nothing here reads the machine's clock:
 * the reading is what the bundle's own reads return. A closed window says
 * why and when it next opens.
 */
export function exchangeWindowVerdict(
  window: RehearsalExchangeWindow,
  reading: ExchangeReading,
  tradingDay: string | undefined,
): ExchangeWindowVerdict {
  const stamp = STAMP.exec(reading.timestamp);
  if (stamp === null) {
    return {
      open: false,
      detail: `The exchange clock's timestamp ${JSON.stringify(reading.timestamp)} names no exchange-local date and time, so window ${window} cannot be decided.`,
      nextOpensAt: null,
    };
  }
  const date = stamp[1]!;
  const time = stamp[2]!;
  const session = reading.sessions.find((s) => s.date === date);
  const closedBecause: string[] = [];
  if (session === undefined)
    closedBecause.push(`the exchange calendar holds no session on ${date}`);
  if (tradingDay !== undefined && tradingDay !== date) {
    closedBecause.push(
      `the exchange clock reads ${date}, and the rehearsal's trading day is ${tradingDay}`,
    );
  }
  if (window === 'session_closed' && session !== undefined) {
    if (reading.isOpen) closedBecause.push(`the market is open at ${time}`);
    else if (time < session.close) {
      closedBecause.push(
        `the session of ${date} closes at ${session.close}, and the clock reads ${time}`,
      );
    }
  }
  if (closedBecause.length === 0) return { open: true, date };
  const nextOpensAt = nextOpening(window, reading.sessions, date, time);
  return {
    open: false,
    detail: `Window ${window} is closed: ${closedBecause.join(', and ')}. It is open when ${REHEARSAL_EXCHANGE_WINDOW_RULES[window]}.${nextOpensAt === null ? ' The calendar read holds no session it next opens in.' : ` A rehearsal started at ${nextOpensAt} exchange time finds it open.`}`,
    nextOpensAt,
  };
}
