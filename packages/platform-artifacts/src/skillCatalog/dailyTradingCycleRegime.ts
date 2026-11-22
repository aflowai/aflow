/**
 * The market regime a Daily Trading Cycle decides under. The read-index-bars
 * task reads the daily bars of SPY, QQQ and IWM through the market-data
 * binding, and gather-regime reports fifty closes of each from that read, with
 * twenty of every universe member and the regime they give. Its contract pins
 * each index close to its session in that read, and each index series to the
 * last fifty completed sessions ending on the asOf the clock gives.
 * It recomputes every derived number from the reported closes with the
 * functions below and refuses any other value, so the moving averages, the
 * realized volatility, the breadth share and the state are never numbers an
 * agent picks. The campaign may cap each state's
 * gross exposure and bias, and the decide contract holds a decision to the
 * caps of the state it was made under. A cycle whose regime could not be
 * gathered decides under the state `unavailable`. Its decide output contract
 * refuses any new thesis, while its closes, its record and its completion
 * run as on any other cycle.
 */
import { z } from 'zod';
import { CYCLE_SLOTS } from './dailyTradingCycleSlots.js';

export const REGIME_INDEXES = ['SPY', 'QQQ', 'IWM'] as const;
export type RegimeIndex = (typeof REGIME_INDEXES)[number];

export const REGIME_STATES = ['risk_on', 'mixed', 'risk_off', 'stressed'] as const;
export type RegimeState = (typeof REGIME_STATES)[number];

/** The state decide names when gather-regime produced no regime. */
export const REGIME_UNAVAILABLE = 'unavailable' as const;
export const DECIDE_MARKET_STATES = [...REGIME_STATES, REGIME_UNAVAILABLE] as const;

export const DECISION_BIASES = ['long', 'short', 'neutral'] as const;
export type DecisionBias = (typeof DECISION_BIASES)[number];

export const INDEX_LOOKBACK_SESSIONS = 50;
export const MEMBER_LOOKBACK_SESSIONS = 20;
const SHORT_AVERAGE_SESSIONS = 20;
const LONG_AVERAGE_SESSIONS = 50;
const VOLATILITY_SESSIONS = 20;
const SESSIONS_PER_YEAR = 252;

export const STRESSED_VOL_PCT = 30;
const RISK_ON_MIN_VOTES = 5;
const RISK_ON_MIN_BREADTH = 0.6;
const RISK_OFF_MAX_VOTES = 1;
const RISK_OFF_MAX_BREADTH = 0.4;

/**
 * The calendar source contract. A space binds one by adding an API definition
 * with this id and endpoint, which answers one date's calendar. The bundle
 * ships none, so the cycle runs without a calendar until one is bound.
 */
export const CALENDAR_SOURCE_API_ID = 'market-calendar';
export const CALENDAR_SOURCE_ENDPOINT_ID = 'get_day';

/**
 * The pre-market research note decide reads as evidence. A note over the cap
 * arrives cut at the cap with `truncated: true`. It is never dropped, and
 * never passed whole.
 */
export const PRE_MARKET_NOTE_PATH_TEMPLATE = '/research/{tradingDay}/pre-market.md';
export const PRE_MARKET_EVIDENCE_MAX_CHARS = 12_000;

/** The binding every regime close is read through. */
export const REGIME_READ_BINDING_ID = 'alpaca-market-data-default';
export const READ_INDEX_BARS_TASK_ID = 'read-index-bars';

export const MARKET_REGIME_VALIDATOR_REF = 'trading.market-regime' as const;
export const REGIME_CAPS_VALIDATOR_REF = 'trading.regime-caps' as const;
export const CAMPAIGN_REGIME_CAPS_RULE = 'trading.campaign-regime-caps' as const;

/** How the state follows from the numbers, for every contract and doc that names it. */
export const REGIME_STATE_RULE = `stressed when SPY's realized volatility, as rounded and reported, is ${String(STRESSED_VOL_PCT)}% or more. Otherwise count six trend votes: SPY, QQQ and IWM each above its 20-day average and above its 50-day average. risk_on takes ${String(RISK_ON_MIN_VOTES)} or more votes and a breadth share of ${String(RISK_ON_MIN_BREADTH)} or more. risk_off takes ${String(RISK_OFF_MAX_VOTES)} vote or fewer and a breadth share of ${String(RISK_OFF_MAX_BREADTH)} or less. Every other reading is mixed`;

/** How each number derives from the closes, oldest first. */
export const REGIME_MATH_RULE = `A 20-day or 50-day average is the mean of the last 20 or 50 closes, rounded to 2 decimals. An index is above its 20-day or 50-day average when its last close exceeds that average as rounded and reported. Realized volatility is the sample standard deviation of the last ${String(VOLATILITY_SESSIONS)} daily log returns, times the square root of ${String(SESSIONS_PER_YEAR)}, times 100, rounded to 2 decimals. A member is above its 20-day average when its last close exceeds the mean of its 20 closes. The breadth share is the members above it over all members, rounded to 4 decimals`;

// ── The arithmetic ─────────────────────────────────────────────────────────

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function lastN(closes: readonly number[], sessions: number): readonly number[] {
  return closes.slice(Math.max(0, closes.length - sessions));
}

/** The mean of the last `sessions` closes. */
export function movingAverage(closes: readonly number[], sessions: number): number {
  const window = lastN(closes, sessions);
  return window.reduce((sum, c) => sum + c, 0) / window.length;
}

/** Annualized realized volatility, in percent, of the last `sessions` daily log returns. */
export function realizedVolPct(
  closes: readonly number[],
  sessions: number = VOLATILITY_SESSIONS,
): number {
  const window = lastN(closes, sessions + 1);
  const returns = window.slice(1).map((c, i) => Math.log(c / window[i]!));
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(SESSIONS_PER_YEAR) * 100;
}

export interface IndexStats {
  close: number;
  sma20: number;
  sma50: number;
  aboveSma20: boolean;
  aboveSma50: boolean;
  realizedVolPct: number;
}

export interface RegimeBreadth {
  above: number;
  total: number;
  share: number;
}

export interface MarketRegime {
  asOf: string;
  state: RegimeState;
  indexes: Record<RegimeIndex, IndexStats>;
  realizedVolPct: number;
  breadth: RegimeBreadth;
}

export interface RegimeEvidence {
  /** The session the closes end on. */
  asOf: string;
  /** Each index's last 50 completed daily closes, oldest first. */
  indexCloses: Record<RegimeIndex, readonly number[]>;
  /** Each universe member's last 20 completed daily closes, oldest first. */
  memberCloses: ReadonlyArray<{ symbol: string; closes: readonly number[] }>;
}

function indexStats(closes: readonly number[]): IndexStats {
  const close = closes[closes.length - 1]!;
  // The vote compares the close with the average as reported, so an agent
  // recomputing it from the output agrees with this check.
  const sma20 = round(movingAverage(closes, SHORT_AVERAGE_SESSIONS), 2);
  const sma50 = round(movingAverage(closes, LONG_AVERAGE_SESSIONS), 2);
  return {
    close,
    sma20,
    sma50,
    aboveSma20: close > sma20,
    aboveSma50: close > sma50,
    realizedVolPct: round(realizedVolPct(closes), 2),
  };
}

export function classifyRegime(
  indexes: Record<RegimeIndex, Pick<IndexStats, 'aboveSma20' | 'aboveSma50'>>,
  breadthShare: number,
  marketVolPct: number,
): RegimeState {
  if (marketVolPct >= STRESSED_VOL_PCT) return 'stressed';
  const votes = REGIME_INDEXES.reduce(
    (sum, i) => sum + Number(indexes[i].aboveSma20) + Number(indexes[i].aboveSma50),
    0,
  );
  if (votes >= RISK_ON_MIN_VOTES && breadthShare >= RISK_ON_MIN_BREADTH) return 'risk_on';
  if (votes <= RISK_OFF_MAX_VOTES && breadthShare <= RISK_OFF_MAX_BREADTH) return 'risk_off';
  return 'mixed';
}

/** The regime the closes give. Every gate on the regime reads this one function. */
export function computeMarketRegime(evidence: RegimeEvidence): MarketRegime {
  const indexes = Object.fromEntries(
    REGIME_INDEXES.map((i) => [i, indexStats(evidence.indexCloses[i])]),
  ) as Record<RegimeIndex, IndexStats>;
  const total = evidence.memberCloses.length;
  const above = evidence.memberCloses.filter(
    (m) => m.closes[m.closes.length - 1]! > movingAverage(m.closes, SHORT_AVERAGE_SESSIONS),
  ).length;
  const share = total === 0 ? 0 : above / total;
  // The state reads the volatility as reported, so an agent recomputing the
  // state from the output agrees with this check.
  const marketVol = round(realizedVolPct(evidence.indexCloses.SPY), 2);
  return {
    asOf: evidence.asOf,
    state: classifyRegime(indexes, share, marketVol),
    indexes,
    realizedVolPct: marketVol,
    breadth: { above, total, share: round(share, 4) },
  };
}

export interface ExchangeClock {
  /** Exchange-local, so its date part is the exchange date. */
  timestamp: string;
  isOpen: boolean;
  nextOpen: string;
}

/** How asOf follows from the clock and the sessions the read returned. */
export const AS_OF_RULE =
  'asOf is the latest completed session: the latest date among the sessions the index read returned that is before the clock date, or the clock date itself when the market is closed and its next open falls on a later date';

/**
 * The latest completed session among `sessions` (bar timestamps or dates),
 * by the exchange clock: a session before the clock date has closed, and the
 * clock date's own has closed once the market is shut until a later date.
 * The read gives the sessions, so a holiday counts as none.
 */
export function latestCompletedSession(
  clock: ExchangeClock,
  sessions: readonly string[],
): string | null {
  const today = clock.timestamp.slice(0, 10);
  const todayClosed = !clock.isOpen && clock.nextOpen.slice(0, 10) > today;
  const completed = sessions
    .map((s) => s.slice(0, 10))
    .filter((d) => d < today || (d === today && todayClosed))
    .sort();
  return completed[completed.length - 1] ?? null;
}

// ── The gather-regime contract ─────────────────────────────────────────────

const TRADING_DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

function closesSchema(sessions: number, description: string) {
  return {
    type: 'array',
    minItems: sessions,
    maxItems: sessions,
    items: { type: 'number', exclusiveMinimum: 0 },
    description,
  };
}

/** How an index series follows from the read, for every contract and doc that names it. */
export const INDEX_SERIES_RULE = `Each index series is the last ${String(INDEX_LOOKBACK_SESSIONS)} completed sessions of that index in the read, ending on asOf: one bar per session, oldest first, as { t, c } exactly as read. It skips no session and repeats none. On a pre_market, open or intraday cycle no session on or after the trading day enters it, so the forming bar stays out`;

function seriesSchema(index: RegimeIndex) {
  return {
    type: 'array',
    minItems: INDEX_LOOKBACK_SESSIONS,
    maxItems: INDEX_LOOKBACK_SESSIONS,
    description: `${index}’s series. ${INDEX_SERIES_RULE}. The contract holds every bar to the read.`,
    items: {
      type: 'object',
      required: ['t', 'c'],
      additionalProperties: false,
      properties: {
        t: { type: 'string', minLength: 10, description: 'The bar’s `t`: its session.' },
        c: { type: 'number', exclusiveMinimum: 0, description: 'The bar’s `c`: its close.' },
      },
    },
  };
}

const INDEX_STATS_SCHEMA = {
  type: 'object',
  required: ['close', 'sma20', 'sma50', 'aboveSma20', 'aboveSma50', 'realizedVolPct'],
  additionalProperties: false,
  properties: {
    close: { type: 'number', description: 'The close of the last bar of its series.' },
    sma20: { type: 'number' },
    sma50: { type: 'number' },
    aboveSma20: { type: 'boolean' },
    aboveSma50: { type: 'boolean' },
    realizedVolPct: { type: 'number', minimum: 0 },
  },
};

/** The regime as gathered: what every later reader of the cycle sees. */
export const MARKET_REGIME_SCHEMA = {
  type: 'object',
  required: ['asOf', 'state', 'indexes', 'realizedVolPct', 'breadth'],
  additionalProperties: false,
  description: `The regime the closes give. ${REGIME_MATH_RULE}. The contract recomputes every number and refuses any other value.`,
  properties: {
    asOf: {
      type: 'string',
      pattern: TRADING_DAY_PATTERN,
      description: `The completed session every index series ends on. ${AS_OF_RULE}. The contract computes it from the clock and the read, and refuses any other date.`,
    },
    state: { enum: [...REGIME_STATES], description: `The regime state: ${REGIME_STATE_RULE}.` },
    indexes: {
      type: 'object',
      required: [...REGIME_INDEXES],
      additionalProperties: false,
      properties: Object.fromEntries(REGIME_INDEXES.map((i) => [i, INDEX_STATS_SCHEMA])),
    },
    realizedVolPct: { type: 'number', minimum: 0, description: 'SPY’s realized volatility.' },
    breadth: {
      type: 'object',
      required: ['above', 'total', 'share'],
      additionalProperties: false,
      properties: {
        above: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 0 },
        share: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  },
};

export const GATHER_REGIME_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['tradingDay', 'slot', 'clock', 'indexCloses', 'memberCloses', 'marketRegime', 'read'],
  additionalProperties: false,
  properties: {
    clock: {
      type: 'object',
      required: ['timestamp', 'isOpen', 'nextOpen'],
      additionalProperties: false,
      description:
        'The exchange clock, copied from `clockTimestamp`, `marketIsOpen` and `nextOpen`. It is pinned.',
      properties: {
        timestamp: { type: 'string' },
        isOpen: { type: 'boolean' },
        nextOpen: { type: 'string' },
      },
    },
    read: {
      type: 'object',
      required: ['bindingId', 'asOf', 'count'],
      additionalProperties: false,
      description:
        'Where the index closes came from: the binding read, the session it is as of and the SPY bars it returned. The cycle doc records it.',
      properties: {
        bindingId: { const: REGIME_READ_BINDING_ID },
        asOf: { type: 'string', pattern: TRADING_DAY_PATTERN, description: 'marketRegime.asOf.' },
        count: {
          type: 'integer',
          minimum: 0,
          description: 'The SPY bars `indexBars` holds. It is pinned to the read.',
        },
      },
    },
    tradingDay: {
      type: 'string',
      pattern: TRADING_DAY_PATTERN,
      description: 'This cycle’s trading day, copied from your input. It is pinned.',
    },
    slot: {
      enum: [...CYCLE_SLOTS],
      description: 'This cycle’s slot, copied from your input. It is pinned.',
    },
    indexCloses: {
      type: 'object',
      required: [...REGIME_INDEXES],
      additionalProperties: false,
      properties: Object.fromEntries(REGIME_INDEXES.map((i) => [i, seriesSchema(i)])),
    },
    memberCloses: {
      type: 'array',
      description:
        'One entry per universe member, each symbol once. The contract pins the set to the campaign universe.',
      items: {
        type: 'object',
        required: ['symbol', 'closes'],
        additionalProperties: false,
        properties: {
          symbol: { type: 'string' },
          closes: closesSchema(
            MEMBER_LOOKBACK_SESSIONS,
            `The member’s last ${String(MEMBER_LOOKBACK_SESSIONS)} completed daily closes, oldest first.`,
          ),
        },
      },
    },
    marketRegime: MARKET_REGIME_SCHEMA,
  },
};

/** Pins the gathered regime to its cycle and the campaign universe. */
export const GATHER_REGIME_PINS = [
  {
    bindingId: 'regime-trading-day-pin',
    from: 'resolve-theses',
    binding: 'value:$.tradingDay',
    target: '$.tradingDay.const',
  },
  {
    bindingId: 'regime-slot-pin',
    from: 'resolve-theses',
    binding: 'value:$.slot',
    target: '$.slot.const',
  },
  ...(
    [
      ['timestamp', 'timestamp'],
      ['isOpen', 'is-open'],
      ['nextOpen', 'next-open'],
    ] as const
  ).map(([field, id]) => ({
    bindingId: `regime-clock-${id}`,
    from: 'ingest-clock',
    binding: `value:$.${field}`,
    target: `$.clock.${field}.const`,
  })),
  ...(['minimum', 'maximum'] as const).map((leaf) => ({
    bindingId: `regime-read-count-${leaf}`,
    from: READ_INDEX_BARS_TASK_ID,
    binding: 'count:$.bars.SPY',
    target: `$.read.count.${leaf}`,
  })),
  ...REGIME_INDEXES.flatMap((i) =>
    (['t', 'c'] as const).map((field) => ({
      bindingId: `regime-index-${field === 't' ? 'sessions' : 'closes'}-${i.toLowerCase()}`,
      from: READ_INDEX_BARS_TASK_ID,
      binding: `enum:$.bars.${i}[*].${field}`,
      target: `$.indexCloses.${i}.items.${field}.enum`,
    })),
  ),
  {
    bindingId: 'regime-member-symbols',
    from: '$campaign',
    binding: 'enum:$.universe[*]',
    target: '$.memberCloses.items.symbol.enum',
  },
  {
    bindingId: 'regime-member-floor',
    from: '$campaign',
    binding: 'count:$.universe',
    target: '$.memberCloses.minItems',
  },
  {
    bindingId: 'regime-member-ceiling',
    from: '$campaign',
    binding: 'count:$.universe',
    target: '$.memberCloses.maxItems',
  },
];

export interface RegimeIssue {
  path: Array<string | number>;
  message: string;
}

const ClosesSchema = z.array(z.number()).min(1);
const BarsSchema = z.array(z.object({ t: z.string(), c: z.number() }).passthrough());
const SeriesSchema = BarsSchema.min(1);

/** What read-index-bars returned: the bars every index series is held to. */
const IndexReadSchema = z
  .object({ bars: z.object({ SPY: BarsSchema, QQQ: BarsSchema, IWM: BarsSchema }).passthrough() })
  .passthrough();

const GatherViewSchema = z
  .object({
    tradingDay: z.string(),
    slot: z.string(),
    clock: z.object({ timestamp: z.string(), isOpen: z.boolean(), nextOpen: z.string() }),
    indexCloses: z.object({ SPY: SeriesSchema, QQQ: SeriesSchema, IWM: SeriesSchema }),
    memberCloses: z.array(z.object({ symbol: z.string(), closes: ClosesSchema })),
    marketRegime: z
      .object({
        asOf: z.string(),
        state: z.string(),
        indexes: z.record(z.record(z.unknown())),
        realizedVolPct: z.number(),
        breadth: z.object({ above: z.number(), total: z.number(), share: z.number() }),
      })
      .passthrough(),
    read: z.object({ asOf: z.string() }).passthrough(),
  })
  .passthrough();

const NUMERIC_INDEX_FIELDS = ['close', 'sma20', 'sma50', 'realizedVolPct'] as const;

const sessionOf = (t: string) => t.slice(0, 10);

interface SeriesScope {
  index: RegimeIndex;
  asOf: string;
  tradingDay: string;
  slot: string;
}

/**
 * One index series against the read: each bar is the read's bar of its
 * session, the sessions ascend, and together they are exactly the last
 * fifty completed sessions of that index ending on asOf.
 */
function indexSeriesIssues(
  series: ReadonlyArray<{ t: string; c: number }>,
  readBars: ReadonlyArray<{ t: string; c: number }>,
  { index, asOf, tradingDay, slot }: SeriesScope,
): RegimeIssue[] {
  const issues: RegimeIssue[] = [];
  const at = (path: Array<string | number>, message: string) => {
    issues.push({ path: ['indexCloses', index, ...path], message });
  };
  const readClose = new Map(readBars.map((b) => [sessionOf(b.t), b.c]));
  series.forEach((bar, k) => {
    const session = sessionOf(bar.t);
    const close = readClose.get(session);
    if (close === undefined) {
      at([k, 't'], `is ${bar.t}, a session the read did not return for ${index}.`);
    } else if (bar.c !== close) {
      at(
        [k, 'c'],
        `is ${String(bar.c)}, but the read’s ${index} close for ${session} is ${String(close)}. Set it to ${String(close)}.`,
      );
    }
    if (session > tradingDay || (slot !== 'after_close' && session === tradingDay)) {
      at(
        [k, 't'],
        session === tradingDay
          ? `is the ${tradingDay} bar, which is still forming on this ${slot} cycle. Leave it out: the series ends on ${asOf}.`
          : `is ${session}, after tradingDay ${tradingDay}. The series ends on ${asOf}.`,
      );
    }
    const before = series[k - 1];
    if (before !== undefined && session <= sessionOf(before.t)) {
      at(
        [k, 't'],
        `is ${session}, not after ${sessionOf(before.t)}, the session of the bar before it. List each session once, oldest first.`,
      );
    }
  });
  const last = series[series.length - 1];
  if (last !== undefined && sessionOf(last.t) !== asOf) {
    at([], `ends on ${sessionOf(last.t)}, but asOf is ${asOf}. End it on ${asOf}.`);
  }
  if (issues.length > 0) return issues;

  const completed = [...readClose.keys()].filter((s) => s <= asOf).sort();
  if (completed.length < INDEX_LOOKBACK_SESSIONS) {
    at(
      [],
      `cannot hold ${String(INDEX_LOOKBACK_SESSIONS)} sessions: the read returned ${String(completed.length)} completed ${index} sessions up to ${asOf}. Do not submit. The cycle then decides ${REGIME_UNAVAILABLE}.`,
    );
    return issues;
  }
  const expected = completed.slice(-INDEX_LOOKBACK_SESSIONS);
  const reported = new Set(series.map((b) => sessionOf(b.t)));
  const skipped = expected.filter((s) => !reported.has(s));
  if (skipped.length > 0) {
    at(
      [],
      `skips ${skipped.join(', ')}. It holds the last ${String(INDEX_LOOKBACK_SESSIONS)} completed sessions of the read, ${expected[0]!} to ${asOf}, each once.`,
    );
  }
  return issues;
}

/**
 * Every number and the session of the gathered regime against what the read
 * and the clock give. Each index series is held bar for bar to `indexRead`,
 * the output of read-index-bars, so no close is the agent's pick. The
 * numbers must equal the ones its closes give exactly, and the flags and the
 * state follow from the numbers as reported, so an agent applying the stated
 * rule to its own output agrees with this check. Each refusal names the
 * value to write, so a cycle converges on the computed regime instead of
 * looping.
 */
export function marketRegimeIssues(output: unknown, indexRead: unknown): RegimeIssue[] {
  const view = GatherViewSchema.safeParse(output);
  if (!view.success) {
    return [
      {
        path: [],
        message:
          'The output does not carry the clock, the index series, the closes and the regime.',
      },
    ];
  }
  const readView = IndexReadSchema.safeParse(indexRead);
  if (!readView.success) {
    return [
      {
        path: ['indexCloses'],
        message: `The bars of ${READ_INDEX_BARS_TASK_ID} cannot be read for this run, so no index series can be held to them. Do not submit. The cycle then decides ${REGIME_UNAVAILABLE}.`,
      },
    ];
  }
  const readBars = readView.data.bars;
  const { tradingDay, slot, clock, indexCloses: series, memberCloses } = view.data;
  const { marketRegime: reported, read } = view.data;
  const issues: RegimeIssue[] = [];
  const at = (path: Array<string | number>, message: string) => {
    issues.push({ path: ['marketRegime', ...path], message });
  };

  const seen = new Set<string>();
  memberCloses.forEach((m, i) => {
    if (seen.has(m.symbol)) {
      issues.push({
        path: ['memberCloses', i, 'symbol'],
        message: `${m.symbol} appears twice. Give each universe member one entry.`,
      });
    }
    seen.add(m.symbol);
  });

  const asOf = latestCompletedSession(
    clock,
    readBars.SPY.map((b) => b.t),
  );
  if (asOf === null) {
    at(['asOf'], 'has no completed session behind it: the index read returned none.');
  } else if (reported.asOf !== asOf) {
    at(
      ['asOf'],
      `is ${reported.asOf}, but the clock and the sessions the read returned give ${asOf}. ${AS_OF_RULE}. Set it to ${asOf} and end every index series on it.`,
    );
  }
  if (reported.asOf > tradingDay || (slot !== 'after_close' && reported.asOf === tradingDay)) {
    at(
      ['asOf'],
      slot === 'after_close'
        ? `is ${reported.asOf}, after tradingDay ${tradingDay}. The closes end on a completed session.`
        : `is ${reported.asOf}, but the ${tradingDay} session is not complete on a ${slot} cycle. Use closes of completed sessions only, ending before ${tradingDay}.`,
    );
  }
  if (read.asOf !== reported.asOf) {
    issues.push({
      path: ['read', 'asOf'],
      message: `is ${read.asOf}, but marketRegime.asOf is ${reported.asOf}. Set it to ${reported.asOf}.`,
    });
  }

  for (const index of REGIME_INDEXES) {
    issues.push(
      ...indexSeriesIssues(series[index], readBars[index], {
        index,
        asOf: asOf ?? reported.asOf,
        tradingDay,
        slot,
      }),
    );
  }

  const indexCloses = Object.fromEntries(
    REGIME_INDEXES.map((i) => [i, series[i].map((b) => b.c)]),
  ) as Record<RegimeIndex, number[]>;
  const expected = computeMarketRegime({ asOf: reported.asOf, indexCloses, memberCloses });
  const votes: Partial<Record<RegimeIndex, Pick<IndexStats, 'aboveSma20' | 'aboveSma50'>>> = {};
  for (const i of REGIME_INDEXES) {
    const got = reported.indexes[i] ?? {};
    const want = expected.indexes[i];
    for (const field of NUMERIC_INDEX_FIELDS) {
      if (got[field] !== want[field]) {
        at(
          ['indexes', i, field],
          `is ${String(got[field])}, but ${i}’s closes give ${String(want[field])}. Set it to ${String(want[field])}.`,
        );
      }
    }
    const close = got['close'];
    const vote: Pick<IndexStats, 'aboveSma20' | 'aboveSma50'> = {
      aboveSma20: false,
      aboveSma50: false,
    };
    for (const [flag, average] of [
      ['aboveSma20', 'sma20'],
      ['aboveSma50', 'sma50'],
    ] as const) {
      const avg = got[average];
      if (typeof close !== 'number' || typeof avg !== 'number') continue;
      vote[flag] = close > avg;
      if (got[flag] !== vote[flag]) {
        at(
          ['indexes', i, flag],
          `is ${String(got[flag])}, but the close ${String(close)} against the ${average} ${String(avg)} you report gives ${String(vote[flag])}.`,
        );
      }
    }
    votes[i] = vote;
  }
  if (reported.realizedVolPct !== expected.realizedVolPct) {
    at(
      ['realizedVolPct'],
      `is ${String(reported.realizedVolPct)}, but SPY’s closes give ${String(expected.realizedVolPct)}. Set it to ${String(expected.realizedVolPct)}.`,
    );
  }
  const breadth = expected.breadth;
  if (reported.breadth.above !== breadth.above || reported.breadth.total !== breadth.total) {
    at(
      ['breadth'],
      `counts ${String(reported.breadth.above)} of ${String(reported.breadth.total)}, but the member closes give ${String(breadth.above)} of ${String(breadth.total)} above their 20-day average.`,
    );
  }
  if (reported.breadth.share !== breadth.share) {
    at(
      ['breadth', 'share'],
      `is ${String(reported.breadth.share)}, but ${String(breadth.above)} of ${String(breadth.total)} is ${String(breadth.share)}. Set it to ${String(breadth.share)}.`,
    );
  }
  const state = classifyRegime(
    votes as Record<RegimeIndex, Pick<IndexStats, 'aboveSma20' | 'aboveSma50'>>,
    reported.breadth.share,
    reported.realizedVolPct,
  );
  if (reported.state !== state) {
    at(
      ['state'],
      `is ${reported.state}, but the numbers you report give ${state}. The rule: ${REGIME_STATE_RULE}.`,
    );
  }
  return issues;
}

// ── Per-regime caps on the campaign ────────────────────────────────────────

const REGIME_CAP_SCHEMA = {
  type: 'object',
  required: ['maxGrossExposurePct', 'biases'],
  additionalProperties: false,
  properties: {
    maxGrossExposurePct: { type: 'number', minimum: 0, maximum: 200 },
    biases: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: [...DECISION_BIASES] },
    },
  },
};

/** The campaign field. A state it leaves out is held to the campaign-wide caps alone. */
export const REGIME_CAPS_FIELD = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(REGIME_STATES.map((s) => [s, REGIME_CAP_SCHEMA])),
  },
  mutable: false,
  label: 'Per-regime caps',
  description:
    'For each market-regime state you cap (risk_on, mixed, risk_off, stressed): a gross exposure cap (%) and the biases (long, short, neutral) a decision that opens theses may take. long and short name the directions its theses may hold. neutral lets one decision hold both, so it needs long and short listed beside it. A state left out is held to the campaign-wide caps alone. Frozen for the campaign window.',
};

const RegimeCapSchema = z.object({
  maxGrossExposurePct: z.number(),
  biases: z.array(z.enum(DECISION_BIASES)).min(1),
});

export const RegimeCapsSchema = z
  .object({
    risk_on: RegimeCapSchema.optional(),
    mixed: RegimeCapSchema.optional(),
    risk_off: RegimeCapSchema.optional(),
    stressed: RegimeCapSchema.optional(),
  } satisfies Record<RegimeState, z.ZodTypeAny>)
  .strict();
export type RegimeCaps = z.infer<typeof RegimeCapsSchema>;

// ── The decide contract's regime fields ────────────────────────────────────

export const DECIDE_REGIME_PROPERTIES = {
  marketState: {
    enum: [...DECIDE_MARKET_STATES],
    description: `The \`marketState\` of your input, copied. It is pinned. It is the gathered regime's state, which selects the regimeCaps entry this output is held to, or ${REGIME_UNAVAILABLE} when the regime could not be gathered. Under ${REGIME_UNAVAILABLE} no new thesis may open: theses is empty and bias is null. The cycle's closes still run.`,
  },
  bias: {
    enum: [...DECISION_BIASES, null],
    description:
      'The direction of the theses you open: long when every one is long, short when every one is short, neutral when they hold both directions. null when you open none. The campaign’s regimeCaps entry for marketState names the biases it allows.',
  },
};

/**
 * The pin reads the regime-state rule step, never gather-regime itself: a pin
 * on a failed producer fails its consumer, and gather-regime may fail.
 */
export const DECIDE_REGIME_PIN = {
  bindingId: 'decide-market-state-pin',
  from: 'regime-state',
  binding: 'value:$.decision',
  target: '$.marketState.const',
};

function directionsAll(direction: 'long' | 'short') {
  return {
    properties: {
      theses: { minItems: 1, items: { properties: { direction: { const: direction } } } },
    },
  };
}

function containsDirection(direction: 'long' | 'short') {
  return {
    properties: { theses: { contains: { properties: { direction: { const: direction } } } } },
  };
}

function whenBias(bias: DecisionBias | null, then: Record<string, unknown>) {
  return { if: { required: ['bias'], properties: { bias: { const: bias } } }, then };
}

const OPENS_NONE = { properties: { theses: { maxItems: 0 } } };

/**
 * The bias a decision names is the one its theses take, and a decision made
 * without a regime opens no thesis. Its closes come from resolve-theses, so
 * they run whatever the regime.
 */
export const DECIDE_REGIME_RULES = [
  whenBias('long', directionsAll('long')),
  whenBias('short', directionsAll('short')),
  whenBias('neutral', { allOf: [containsDirection('long'), containsDirection('short')] }),
  whenBias(null, OPENS_NONE),
  {
    if: { required: ['marketState'], properties: { marketState: { const: REGIME_UNAVAILABLE } } },
    then: OPENS_NONE,
  },
];

const DecideRegimeScopeSchema = z
  .object({ marketState: z.enum(DECIDE_MARKET_STATES), theses: z.array(z.unknown()) })
  .passthrough();

const DecideRegimeViewSchema = DecideRegimeScopeSchema.extend({
  bias: z.enum(DECISION_BIASES).nullable(),
  theses: z.array(z.object({ direction: z.enum(['long', 'short']) }).passthrough()),
  projectedGrossExposurePct: z.number(),
});

/**
 * Whether a decide output is held to a regimeCaps entry at all. One that opens
 * no thesis adds no exposure and takes no bias, so it needs no campaign read.
 * One made with the regime unavailable opens none, because its output schema
 * refuses any thesis. An output this cannot read is held, so the rule that
 * reads it names what it lacks.
 */
export function regimeCapsApply(output: unknown): boolean {
  const view = DecideRegimeScopeSchema.safeParse(output);
  if (!view.success) return true;
  return view.data.theses.length > 0 && view.data.marketState !== REGIME_UNAVAILABLE;
}

/**
 * A decision that opens theses under a gathered regime is held to the
 * regimeCaps entry of that state. The biases hold the theses' own
 * directions, so a mixed decision cannot pass a direction the state leaves
 * out under the neutral label. A decision that opens none passes this rule,
 * so its closes run whatever the regime. The caps are the campaign's
 * validated field. decide binds them as a campaign input, so a campaign
 * without them fails decide input resolution and never reaches this rule.
 */
export function regimeCapIssues(output: unknown, regimeCaps: RegimeCaps): RegimeIssue[] {
  const view = DecideRegimeViewSchema.safeParse(output);
  if (!view.success) {
    return [
      { path: [], message: 'The output does not carry marketState, bias and directed theses.' },
    ];
  }
  const { marketState, bias, theses, projectedGrossExposurePct } = view.data;
  if (!regimeCapsApply(output) || marketState === REGIME_UNAVAILABLE) return [];
  const cap = regimeCaps[marketState];
  if (!cap) return [];
  const issues: RegimeIssue[] = [];
  const allowed = cap.biases.join(', ');
  for (const direction of ['long', 'short'] as const) {
    if (cap.biases.includes(direction)) continue;
    const index = theses.findIndex((t) => t.direction === direction);
    if (index === -1) continue;
    issues.push({
      path: ['theses', index, 'direction'],
      message: `is ${direction}, but the campaign allows only ${allowed} in a ${marketState} regime, so no ${direction} thesis may open, whatever the bias. Drop every ${direction} thesis, or submit theses: [].`,
    });
  }
  // Each direction is listed, so only mixing them needs neutral too. The
  // decide schema ties the bias to the theses, so no other label can differ.
  const directions = new Set(theses.map((t) => t.direction));
  if (issues.length === 0 && directions.size > 1 && !cap.biases.includes('neutral')) {
    issues.push({
      path: ['bias'],
      message: `is ${String(bias)}: the theses hold both directions, but the campaign allows only ${allowed} in a ${marketState} regime, without neutral. Keep one direction, or submit theses: [].`,
    });
  }
  if (projectedGrossExposurePct > cap.maxGrossExposurePct) {
    issues.push({
      path: ['projectedGrossExposurePct'],
      message: `is ${String(projectedGrossExposurePct)}, over the ${String(cap.maxGrossExposurePct)}% the campaign allows in a ${marketState} regime. Size the theses down or drop some, so the projection stays at or under it.`,
    });
  }
  return issues;
}

/**
 * Campaign start: a regime cap above the campaign-wide one never binds, and
 * a neutral bias without both directions beside it admits no thesis.
 */
export function campaignRegimeCapIssues(config: unknown): RegimeIssue[] {
  const parsed = z
    .object({ maxGrossExposurePct: z.number(), regimeCaps: RegimeCapsSchema })
    .passthrough()
    .safeParse(config);
  if (!parsed.success) return [];
  const { maxGrossExposurePct, regimeCaps } = parsed.data;
  return REGIME_STATES.flatMap((state) => {
    const cap = regimeCaps[state];
    if (!cap) return [];
    const issues: RegimeIssue[] = [];
    if (cap.maxGrossExposurePct > maxGrossExposurePct) {
      issues.push({
        path: ['regimeCaps', state, 'maxGrossExposurePct'],
        message: `is ${String(cap.maxGrossExposurePct)}, over the campaign’s maxGrossExposurePct of ${String(maxGrossExposurePct)}, so it never binds. Lower it to ${String(maxGrossExposurePct)} or less.`,
      });
    }
    const missing = (['long', 'short'] as const).filter((d) => !cap.biases.includes(d));
    if (cap.biases.includes('neutral') && missing.length > 0) {
      issues.push({
        path: ['regimeCaps', state, 'biases'],
        message: `lists neutral without ${missing.join(' and ')}. A decision holds the directions of its theses, so neutral admits nothing the directions beside it do not. Add ${missing.join(' and ')}, or drop neutral.`,
      });
    }
    return issues;
  });
}
