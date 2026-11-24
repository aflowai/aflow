/**
 * Production-size fixtures for the Store bundles' skill tests: reads at the
 * sizes a live space gives, not the few bars a hand-computed case needs. A
 * read of thirty members over the regime's lookback is the 226 KB body that
 * the platform offloaded behind a dataRef. It is also the read a model was
 * once asked to copy 750 closes from. Hand-sized fixtures exercised neither
 * path, so both defects passed every test.
 */
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import { REHEARSAL_UNIVERSE } from '../rehearsal/plans.js';

/** The campaign contract's ceiling on the universe, and the size a production campaign runs. */
export const PRODUCTION_UNIVERSE: readonly string[] = REHEARSAL_UNIVERSE;

/** A daily bar as Alpaca's `get_v2_stocks_bars` answers it, every field present. */
export interface AlpacaDailyBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

/** The weekday sessions of the `calendarDays` days that end on `lastDay`, oldest first. */
export function weekdaySessions(lastDay: string, calendarDays: number): string[] {
  const sessions: string[] = [];
  const end = new Date(`${lastDay}T12:00:00Z`);
  for (let back = calendarDays - 1; back >= 0; back -= 1) {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - back);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      sessions.push(day.toISOString().slice(0, 10));
  }
  return sessions;
}

function seeded(symbol: string): () => number {
  let state = [...symbol].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 2_166_136_261);
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One symbol's bars over `sessions`: a seeded walk, so every run reads the same series. */
export function alpacaDailyBars(symbol: string, sessions: readonly string[]): AlpacaDailyBar[] {
  const next = seeded(symbol);
  let close = 40 + next() * 400;
  return sessions.map((day) => {
    const open = close * (1 + (next() - 0.5) * 0.01);
    close = close * (1 + (next() - 0.49) * 0.03);
    const high = Math.max(open, close) * (1 + next() * 0.01);
    const low = Math.min(open, close) * (1 - next() * 0.01);
    const volume = Math.round(2_000_000 + next() * 40_000_000);
    return {
      t: `${day}T05:00:00Z`,
      o: round2(open),
      h: round2(high),
      l: round2(low),
      c: round2(close),
      v: volume,
      n: Math.round(volume / 120),
      vw: round2((high + low + close) / 3),
    };
  });
}

/** A `get_v2_stocks_bars` answer for `symbols`, one page, as the cycle's reads ask for it. */
export function alpacaBarsBody(symbols: readonly string[], sessions: readonly string[]) {
  return {
    bars: Object.fromEntries(symbols.map((s) => [s, alpacaDailyBars(s, sessions)])),
    next_page_token: null,
  };
}

export const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * An `api.http.call` output, as the API executor hands it to the harness. A
 * body over the inline limit is offloaded behind `dataRef`, and `data` keeps
 * only a shape sample that no projection path can resolve on. `stored`
 * receives the body under its ref.
 */
export function apiCallOutput(
  body: unknown,
  ref: string,
  stored: Map<string, unknown>,
): Record<string, unknown> {
  const size = byteLength(body);
  if (size <= MAX_INLINE_PAYLOAD_BYTES) return { statusCode: 200, data: body };
  stored.set(ref, body);
  return {
    statusCode: 200,
    data: {
      _note: 'Shape sample only, not the response body.',
      _type: 'object',
      _keys: Object.keys(body as Record<string, unknown>),
    },
    dataRef: ref,
    truncated: true,
    originalSizeBytes: size,
  };
}

/** A payload store holding what `apiCallOutput` offloaded. */
export function payloadStoreOf(stored: Map<string, unknown>) {
  return {
    retrieve: (ref: string) =>
      stored.has(ref)
        ? Promise.resolve(stored.get(ref))
        : Promise.reject(new Error(`no payload at ${ref}`)),
  };
}
