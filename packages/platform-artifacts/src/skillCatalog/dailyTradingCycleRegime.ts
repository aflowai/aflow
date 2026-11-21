/**
 * The market regime a Daily Trading Cycle decides under. The gather-regime
 * task reads daily closes from the market-data binding: SPY, QQQ and IWM over
 * fifty sessions, and every universe member over twenty. It reports them with
 * the regime they give. Its contract recomputes every derived number from the
 * reported closes with the functions below and refuses any other value, so
 * the moving averages, the realized volatility, the breadth share and the
 * state are never numbers an agent picks. The campaign may cap each state's
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

const INDEX_STATS_SCHEMA = {
  type: 'object',
  required: ['close', 'sma20', 'sma50', 'aboveSma20', 'aboveSma50', 'realizedVolPct'],
  additionalProperties: false,
  properties: {
    close: { type: 'number', description: 'The last of its closes.' },
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
      description:
        'The completed session the closes end on. It is before tradingDay on every slot but after_close, which may end on tradingDay itself.',
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
  required: ['tradingDay', 'slot', 'indexCloses', 'memberCloses', 'marketRegime'],
  additionalProperties: false,
  properties: {
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
      properties: Object.fromEntries(
        REGIME_INDEXES.map((i) => [
          i,
          closesSchema(
            INDEX_LOOKBACK_SESSIONS,
            `${i}’s last ${String(INDEX_LOOKBACK_SESSIONS)} completed daily closes, oldest first, as the market-data feed returned them.`,
          ),
        ]),
      ),
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

const GatherViewSchema = z
  .object({
    tradingDay: z.string(),
    slot: z.string(),
    indexCloses: z.object({ SPY: ClosesSchema, QQQ: ClosesSchema, IWM: ClosesSchema }),
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
  })
  .passthrough();

function sameNumber(reported: unknown, expected: number, digits: number | null): boolean {
  if (typeof reported !== 'number') return false;
  const tolerance = digits === null ? 1e-9 : 10 ** -digits + 1e-9;
  return Math.abs(reported - expected) <= tolerance;
}

const NUMERIC_INDEX_FIELDS: ReadonlyArray<[keyof IndexStats, number | null]> = [
  ['close', null],
  ['sma20', 2],
  ['sma50', 2],
  ['realizedVolPct', 2],
];

/**
 * Every derived number of the gathered regime against the one its closes
 * give. Each refusal names the value to write, so a cycle converges on the
 * computed regime instead of looping.
 */
export function marketRegimeIssues(output: unknown): RegimeIssue[] {
  const view = GatherViewSchema.safeParse(output);
  if (!view.success) {
    return [{ path: [], message: 'The output does not carry the closes and the marketRegime.' }];
  }
  const { tradingDay, slot, indexCloses, memberCloses, marketRegime: reported } = view.data;
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

  if (reported.asOf > tradingDay || (slot !== 'after_close' && reported.asOf === tradingDay)) {
    at(
      ['asOf'],
      slot === 'after_close'
        ? `is ${reported.asOf}, after tradingDay ${tradingDay}. The closes end on a completed session.`
        : `is ${reported.asOf}, but the ${tradingDay} session is not complete on a ${slot} cycle. Use closes of completed sessions only, ending before ${tradingDay}.`,
    );
  }

  const expected = computeMarketRegime({ asOf: reported.asOf, indexCloses, memberCloses });
  for (const i of REGIME_INDEXES) {
    const got = reported.indexes[i] ?? {};
    const want = expected.indexes[i];
    for (const [field, digits] of NUMERIC_INDEX_FIELDS) {
      const value = want[field] as number;
      if (!sameNumber(got[field], value, digits)) {
        at(
          ['indexes', i, field],
          `is ${String(got[field])}, but ${i}’s closes give ${String(value)}. Set it to ${String(value)}.`,
        );
      }
    }
    for (const field of ['aboveSma20', 'aboveSma50'] as const) {
      if (got[field] !== want[field]) {
        at(
          ['indexes', i, field],
          `is ${String(got[field])}, but ${i}’s closes give ${String(want[field])}.`,
        );
      }
    }
  }
  if (!sameNumber(reported.realizedVolPct, expected.realizedVolPct, 2)) {
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
  if (!sameNumber(reported.breadth.share, breadth.share, 4)) {
    at(
      ['breadth', 'share'],
      `is ${String(reported.breadth.share)}, but ${String(breadth.above)} of ${String(breadth.total)} is ${String(breadth.share)}. Set it to ${String(breadth.share)}.`,
    );
  }
  if (reported.state !== expected.state) {
    at(
      ['state'],
      `is ${reported.state}, but the closes give ${expected.state}. The rule: ${REGIME_STATE_RULE}.`,
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
    'For each market-regime state you cap (risk_on, mixed, risk_off, stressed): a gross exposure cap (%) and the biases (long, short, neutral) a decision that opens theses may take. A state left out is held to the campaign-wide caps alone. Frozen for the campaign window.',
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
 * regimeCaps entry of that state. A decision that opens none passes this
 * rule, so its closes run whatever the regime. The caps are the campaign's
 * validated field. decide binds them as a campaign input, so a campaign
 * without them fails decide input resolution and never reaches this rule.
 */
export function regimeCapIssues(output: unknown, regimeCaps: RegimeCaps): RegimeIssue[] {
  const view = DecideRegimeViewSchema.safeParse(output);
  if (!view.success) {
    return [{ path: [], message: 'The output does not carry marketState, bias and theses.' }];
  }
  const { marketState, bias, projectedGrossExposurePct } = view.data;
  if (!regimeCapsApply(output) || marketState === REGIME_UNAVAILABLE) return [];
  const cap = regimeCaps[marketState];
  if (!cap) return [];
  const issues: RegimeIssue[] = [];
  if (bias !== null && !cap.biases.includes(bias)) {
    issues.push({
      path: ['bias'],
      message: `is ${bias}, but the campaign allows only ${cap.biases.join(', ')} in a ${marketState} regime. Drop the theses that make it ${bias}, or submit theses: [].`,
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

/** Campaign start: a regime cap above the campaign-wide one never binds. */
export function campaignRegimeCapIssues(config: unknown): RegimeIssue[] {
  const parsed = z
    .object({ maxGrossExposurePct: z.number(), regimeCaps: RegimeCapsSchema })
    .passthrough()
    .safeParse(config);
  if (!parsed.success) return [];
  const { maxGrossExposurePct, regimeCaps } = parsed.data;
  return REGIME_STATES.flatMap((state) => {
    const cap = regimeCaps[state];
    if (!cap || cap.maxGrossExposurePct <= maxGrossExposurePct) return [];
    return [
      {
        path: ['regimeCaps', state, 'maxGrossExposurePct'],
        message: `is ${String(cap.maxGrossExposurePct)}, over the campaign’s maxGrossExposurePct of ${String(maxGrossExposurePct)}, so it never binds. Lower it to ${String(maxGrossExposurePct)} or less.`,
      },
    ];
  });
}
