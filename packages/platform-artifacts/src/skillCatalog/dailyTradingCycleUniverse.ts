/**
 * The universe check a Daily Trading Cycle campaign starts behind. The
 * regime's breadth holds twenty sessions of every universe member from the
 * universe read, so a member the feed does not carry, or carries for fewer
 * sessions over the read's lookback, makes every cycle of the campaign decide
 * `unavailable` and open no thesis. Campaign start reads the same bars the
 * cycle reads and refuses such a universe, naming each member and its count,
 * so the operator learns it before the frozen window opens.
 */
import { MEMBER_LOOKBACK_SESSIONS, REGIME_READ_BINDING_ID } from './dailyTradingCycleRegime.js';

export const UNIVERSE_COVERAGE_CHECK_REF = 'trading.universe-coverage' as const;

/**
 * The calendar days of daily bars every regime read covers, and the universe
 * check reads. They hold the 50 completed sessions a 50-day average needs.
 */
export const REGIME_BARS_LOOKBACK_DAYS = 100;
export const REGIME_BARS_LOOKBACK_MS = REGIME_BARS_LOOKBACK_DAYS * 24 * 60 * 60_000;

/** The feed every regime read names, so the check reads what the cycle reads. */
export const REGIME_BARS_FEED = 'iex' as const;

/** A universe member the breadth math cannot hold, with the sessions the feed gave it. */
export interface UniverseCoverageGap {
  symbol: string;
  sessions: number;
}

/**
 * The members whose read holds fewer than the breadth's sessions completed
 * before `startDay`, in universe order. A member absent from `bars` has none.
 * A bar of `startDay` itself may still be forming, so it does not count.
 */
export function universeCoverageGaps(
  universe: readonly string[],
  bars: Readonly<Record<string, ReadonlyArray<{ t: string }>>>,
  startDay: string,
): UniverseCoverageGap[] {
  return universe.flatMap((symbol) => {
    const sessions = new Set(
      (bars[symbol] ?? []).map((bar) => bar.t.slice(0, 10)).filter((s) => s < startDay),
    ).size;
    return sessions < MEMBER_LOOKBACK_SESSIONS ? [{ symbol, sessions }] : [];
  });
}

/** The refusal campaign start answers with, naming each member and its count. */
export function universeCoverageRefusal(gaps: readonly UniverseCoverageGap[]): string {
  const named = gaps
    .map((g) =>
      g.sessions === 0
        ? `${g.symbol} has no bars`
        : `${g.symbol} has ${String(g.sessions)} sessions`,
    )
    .join(', ');
  return `the market-data binding ${REGIME_READ_BINDING_ID} gives too few ${REGIME_BARS_FEED.toUpperCase()} daily bars over the last ${String(REGIME_BARS_LOOKBACK_DAYS)} calendar days for ${String(gaps.length)} universe member(s): ${named}. The regime's breadth needs ${String(MEMBER_LOOKBACK_SESSIONS)} sessions of every member, so every cycle would decide unavailable and open no thesis. Drop these members from universe, or replace them with symbols the feed carries, then start the campaign again.`;
}
