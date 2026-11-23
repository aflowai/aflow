/**
 * The market regime a Daily Trading Cycle decides under. The read-index-bars
 * task reads the daily bars of SPY, QQQ and IWM through the market-data
 * binding, and read-universe-bars reads those of every universe member.
 * gather-regime computes the regime from those reads and the exchange clock
 * by rule, through `gatherMarketRegime`, and asks no model. Each index series
 * is the last fifty sessions of the read ending on the asOf the clock gives,
 * and each member series the last twenty sessions of that member up to asOf.
 * A session is completed once the clock shows its market close has passed.
 * The functions below compute every derived number from those closes, so the
 * moving averages, the realized volatility, the breadth share and the state
 * are never numbers an agent picks. The campaign may cap each state's
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
export const READ_UNIVERSE_BARS_TASK_ID = 'read-universe-bars';

/** The deriver gather-regime names: `gatherMarketRegime`, registered by the runtime. */
export const MARKET_REGIME_DERIVER = 'trading.market-regime' as const;
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
  // The vote compares the close with the average as reported, so a reader
  // recomputing it from the output agrees with the flag.
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
  // The state reads the volatility as reported, so a reader recomputing the
  // state from the output agrees with it.
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
  /** The next market close still to come, exchange-local. */
  nextClose: string;
}

/** When a session's bar is complete, for every contract and doc that names it. */
export const SESSION_COMPLETED_RULE =
  "A session is completed once its market close has passed: its date is before the date of the clock's nextClose. A session whose close has not passed has a forming bar";

/** How asOf follows from the clock and the sessions the read returned. */
export const AS_OF_RULE =
  'asOf is the latest completed session among the sessions the index read returned';

/**
 * Whether `session` (a bar timestamp or a date) has closed by the exchange
 * clock. The clock's next close is the first close still to come, so every
 * session dated before it has passed its own. The clock date's session is
 * completed once the market has closed for the day, whatever the slot.
 */
export function sessionCompleted(
  clock: Pick<ExchangeClock, 'nextClose'>,
  session: string,
): boolean {
  return session.slice(0, 10) < clock.nextClose.slice(0, 10);
}

/**
 * The latest completed session among `sessions` (bar timestamps or dates),
 * by the exchange clock. The read gives the sessions, so a holiday counts as
 * none.
 */
export function latestCompletedSession(
  clock: Pick<ExchangeClock, 'nextClose'>,
  sessions: readonly string[],
): string | null {
  const completed = sessions
    .map((s) => s.slice(0, 10))
    .filter((d) => sessionCompleted(clock, d))
    .sort();
  return completed[completed.length - 1] ?? null;
}

// ── The gather-regime derivation ───────────────────────────────────────────

const TRADING_DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** How an index series follows from the read, for every doc that names it. */
export const INDEX_SERIES_RULE = `Each index series is the last ${String(INDEX_LOOKBACK_SESSIONS)} sessions of that index in the read up to and including asOf, one close per session, oldest first. So a cycle that runs after the trading day's market close ends on the trading day, and one that runs before it ends on the session before. A read with fewer sessions gives no regime, and the cycle then decides ${REGIME_UNAVAILABLE}`;

/** How a member series follows from the universe read, for every doc that names it. */
export const MEMBER_SERIES_RULE = `Each member series is the last ${String(MEMBER_LOOKBACK_SESSIONS)} sessions of that member in the universe read up to and including asOf, one close per session, oldest first. It follows the member's own sessions in the read, not the index sessions. A member the read does not carry, or carries with fewer sessions, gives no regime, and the cycle then decides ${REGIME_UNAVAILABLE}`;

const INDEX_STATS_SCHEMA = {
  type: 'object',
  required: ['close', 'sma20', 'sma50', 'aboveSma20', 'aboveSma50', 'realizedVolPct'],
  additionalProperties: false,
  properties: {
    close: { type: 'number', description: 'The close of the last session of its series.' },
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
  description: `The regime the read closes give, computed by rule. ${REGIME_MATH_RULE}.`,
  properties: {
    asOf: {
      type: 'string',
      pattern: TRADING_DAY_PATTERN,
      description: `The completed session every index series ends on. ${AS_OF_RULE}. ${SESSION_COMPLETED_RULE}.`,
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
  required: ['tradingDay', 'slot', 'clock', 'marketRegime', 'read'],
  additionalProperties: false,
  properties: {
    tradingDay: {
      type: 'string',
      pattern: TRADING_DAY_PATTERN,
      description: 'This cycle’s trading day, as resolve-theses gave it.',
    },
    slot: { enum: [...CYCLE_SLOTS], description: 'This cycle’s slot, as resolve-theses gave it.' },
    clock: {
      type: 'object',
      required: ['timestamp', 'isOpen', 'nextOpen', 'nextClose'],
      additionalProperties: false,
      description: 'The exchange clock the regime was computed under, as ingest-clock read it.',
      properties: {
        timestamp: { type: 'string' },
        isOpen: { type: 'boolean' },
        nextOpen: { type: 'string' },
        nextClose: { type: 'string' },
      },
    },
    marketRegime: MARKET_REGIME_SCHEMA,
    read: {
      type: 'object',
      required: ['bindingId', 'asOf', 'count'],
      additionalProperties: false,
      description:
        'Where the index closes came from: the binding read, the session it is as of and the SPY bars it returned. The cycle doc records it.',
      properties: {
        bindingId: { const: REGIME_READ_BINDING_ID },
        asOf: { type: 'string', pattern: TRADING_DAY_PATTERN, description: 'marketRegime.asOf.' },
        count: { type: 'integer', minimum: 0, description: 'The SPY bars the index read holds.' },
      },
    },
  },
};

export interface GatheredRegime {
  tradingDay: string;
  slot: string;
  clock: ExchangeClock;
  marketRegime: MarketRegime;
  read: { bindingId: typeof REGIME_READ_BINDING_ID; asOf: string; count: number };
}

export type RegimeDerivation = { ok: true; value: GatheredRegime } | { ok: false; message: string };

const BarsSchema = z.array(
  z.object({ t: z.string().min(10), c: z.number().positive() }).passthrough(),
);

const GatherArgsSchema = z.object({
  tradingDay: z.string().regex(new RegExp(TRADING_DAY_PATTERN)),
  slot: z.enum(CYCLE_SLOTS),
  clock: z.object({
    timestamp: z.string(),
    isOpen: z.boolean(),
    nextOpen: z.string(),
    nextClose: z.string(),
  }),
  indexBars: z.object({ SPY: BarsSchema, QQQ: BarsSchema, IWM: BarsSchema }).passthrough(),
  memberBars: z.record(BarsSchema),
  universe: z.array(z.string().min(1)).min(1),
});

const sessionOf = (t: string) => t.slice(0, 10);

/**
 * The closes of the last `sessions` sessions of `bars` up to and including
 * `asOf`, oldest first, or null when the bars hold fewer. A session the read
 * returns twice counts once, with its last bar.
 */
function seriesUpTo(
  bars: ReadonlyArray<{ t: string; c: number }>,
  asOf: string,
  sessions: number,
): number[] | null {
  const closes = new Map(bars.map((b) => [sessionOf(b.t), b.c]));
  const days = [...closes.keys()].filter((s) => s <= asOf).sort();
  if (days.length < sessions) return null;
  return days.slice(-sessions).map((day) => closes.get(day)!);
}

const refuse = (message: string): RegimeDerivation => ({
  ok: false,
  message: `${message} The cycle decides ${REGIME_UNAVAILABLE}: it opens no new thesis, and its closes and record still run.`,
});

/**
 * The regime of one cycle, computed from the read-index-bars and
 * read-universe-bars outputs and the exchange clock. Every number comes from
 * `computeMarketRegime` over the read closes, so no model transcribes a close
 * or picks a number. A read that is absent, too short for its series, or
 * holding an index series that does not end on asOf gives no regime, and the
 * cycle decides unavailable.
 */
export function gatherMarketRegime(args: unknown): RegimeDerivation {
  const present = (args ?? {}) as Record<string, unknown>;
  if (present['indexBars'] === undefined) {
    return refuse(`${READ_INDEX_BARS_TASK_ID} produced no bars, so no index series can be read.`);
  }
  if (present['memberBars'] === undefined) {
    return refuse(
      `${READ_UNIVERSE_BARS_TASK_ID} produced no bars, so no member series can be read.`,
    );
  }
  const parsed = GatherArgsSchema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return refuse(`The regime's inputs do not parse (${detail}).`);
  }
  const { tradingDay, slot, clock, indexBars, memberBars, universe } = parsed.data;

  const asOf = latestCompletedSession(
    clock,
    indexBars.SPY.map((b) => b.t),
  );
  if (asOf === null) {
    return refuse(`The index read holds no SPY session the clock shows completed.`);
  }
  if (asOf > tradingDay) {
    return refuse(`The latest completed session ${asOf} is after tradingDay ${tradingDay}.`);
  }

  const indexCloses: Partial<Record<RegimeIndex, number[]>> = {};
  for (const index of REGIME_INDEXES) {
    if (!indexBars[index].some((b) => sessionOf(b.t) === asOf)) {
      return refuse(
        `The index read holds no ${index} session on ${asOf}, the session SPY ends on.`,
      );
    }
    const closes = seriesUpTo(indexBars[index], asOf, INDEX_LOOKBACK_SESSIONS);
    if (closes === null) {
      return refuse(
        `The index read holds fewer than ${String(INDEX_LOOKBACK_SESSIONS)} ${index} sessions up to ${asOf}.`,
      );
    }
    indexCloses[index] = closes;
  }

  const memberCloses: Array<{ symbol: string; closes: number[] }> = [];
  for (const symbol of new Set(universe)) {
    const bars = Object.prototype.hasOwnProperty.call(memberBars, symbol)
      ? memberBars[symbol]
      : undefined;
    if (bars === undefined) {
      return refuse(`The universe read carries no bars for ${symbol}.`);
    }
    const closes = seriesUpTo(bars, asOf, MEMBER_LOOKBACK_SESSIONS);
    if (closes === null) {
      return refuse(
        `The universe read holds fewer than ${String(MEMBER_LOOKBACK_SESSIONS)} ${symbol} sessions up to ${asOf}.`,
      );
    }
    memberCloses.push({ symbol, closes });
  }

  return {
    ok: true,
    value: {
      tradingDay,
      slot,
      clock,
      marketRegime: computeMarketRegime({
        asOf,
        indexCloses: indexCloses as Record<RegimeIndex, number[]>,
        memberCloses,
      }),
      read: { bindingId: REGIME_READ_BINDING_ID, asOf, count: indexBars.SPY.length },
    },
  };
}

export interface RegimeIssue {
  path: Array<string | number>;
  message: string;
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
 * validated field: campaign start refuses a campaign without parseable caps.
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
 * Campaign start: every campaign carries regimeCaps that parse, so decide can
 * read them on every cycle. A regime cap above the campaign-wide one never
 * binds, and a neutral bias without both directions beside it admits no
 * thesis.
 */
export function campaignRegimeCapIssues(config: unknown): RegimeIssue[] {
  const caps = RegimeCapsSchema.safeParse(
    config !== null && typeof config === 'object'
      ? (config as Record<string, unknown>)['regimeCaps']
      : undefined,
  );
  if (!caps.success) {
    return [
      {
        path: ['regimeCaps'],
        message:
          'is missing or does not parse. Every campaign carries regimeCaps: an object of the regime states it caps, each with maxGrossExposurePct and biases, or {} to cap none.',
      },
    ];
  }
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
