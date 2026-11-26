import { registerRunDeriver } from '@aflow/schemas';
import {
  cycleTradingDay,
  deskTallyDerivation,
  gatherMarketRegime,
  reflectionCalendarWindow,
  reflectionTradingDay,
} from '@aflow/platform-artifacts';

/**
 * The Daily Trading Cycle's market regime, computed by gather-regime through
 * `workflow.run.derive` from the run's read-index-bars and read-universe-bars
 * outputs and the exchange clock. No model transcribes a close or picks a
 * number. The refs are spelled here, not read from the skill at load,
 * because suites that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_MARKET_REGIME_DERIVER = 'trading.market-regime' as const;

registerRunDeriver(TRADING_MARKET_REGIME_DERIVER, (args) => {
  const derived = gatherMarketRegime(args);
  return derived.ok ? { ok: true, value: { ...derived.value } } : derived;
});

/**
 * The Daily Trading Cycle's trading day, derived from the exchange clock its
 * ingest-clock task reads. resolve-theses's tradingDay is pinned to it, so no
 * model names the day.
 */
export const TRADING_CYCLE_DAY_DERIVER = 'trading.cycle-day' as const;

registerRunDeriver(TRADING_CYCLE_DAY_DERIVER, (args) => cycleTradingDay(args));

/**
 * The Trading Reflection's calendar window and trading day, derived from the
 * exchange clock its ingest-clock task reads and the calendar its
 * read-calendar task reads, so no caller and no model names the day.
 */
export const TRADING_REFLECTION_CALENDAR_WINDOW_DERIVER =
  'trading.reflection-calendar-window' as const;

registerRunDeriver(TRADING_REFLECTION_CALENDAR_WINDOW_DERIVER, (args) => {
  const derived = reflectionCalendarWindow(args);
  return derived.ok ? { ok: true, value: { ...derived.value } } : derived;
});

export const TRADING_REFLECTION_DAY_DERIVER = 'trading.reflection-day' as const;

registerRunDeriver(TRADING_REFLECTION_DAY_DERIVER, (args) => reflectionTradingDay(args));

/**
 * The Strategy Desk's tally over the day's approved set, which a cycle's
 * tally-set task derives before decide reads the approved candidates. The
 * tally is code, so no model folds the lens verdicts.
 */
export const TRADING_DESK_TALLY_DERIVER = 'trading.desk-tally' as const;

registerRunDeriver(TRADING_DESK_TALLY_DERIVER, (args) => {
  const derived = deskTallyDerivation(args);
  return derived.ok ? { ok: true, value: { ...derived.value } } : derived;
});
