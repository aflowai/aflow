/**
 * What the cycle's regime reads cover. A universe member the feed holds too
 * few sessions of is left out of the breadth, so no campaign start check
 * stands behind it.
 */

/**
 * The calendar days of daily bars every regime read covers. They hold the 50
 * completed sessions a 50-day average needs.
 */
export const REGIME_BARS_LOOKBACK_DAYS = 100;
export const REGIME_BARS_LOOKBACK_MS = REGIME_BARS_LOOKBACK_DAYS * 24 * 60 * 60_000;

/** The feed every regime read names. */
export const REGIME_BARS_FEED = 'iex' as const;
