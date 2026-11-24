import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  decideByRules,
  failWith,
  deriveRequiredCapabilities,
  projectTaskOutput,
  runSkillTasks,
  type TaskAnswer,
  validateCampaignConfig,
} from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  getRunDeriver,
  lookupValidator,
  mergeDerivedPatches,
  substituteTemplateBinds,
  WorkflowRunDecideInputSchema,
  WorkflowRunDeriveInputSchema,
  type WorkflowTask,
  type WorkflowTaskOutputProjection,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  MARKET_REGIME_DERIVER,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
  REGIME_INDEXES,
  REGIME_READ_BINDING_ID,
  REGIME_UNAVAILABLE,
  computeMarketRegime,
  latestCompletedSession,
  realizedVolPct,
  type GatheredRegime,
  type MarketRegime,
  type RegimeEvidence,
  type RegimeIndex,
} from '../skillCatalog/dailyTradingCycleRegime.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const entry = getSkillCatalogEntry('daily-trading-cycle')!;
const wf = entry.bundle.workflow;
type Task = (typeof wf.tasks)[number];
const task = (id: string): Task => wf.tasks.find((t) => t.taskId === id)!;

const UNIVERSE = ['AAPL', 'MSFT', 'SPY'];
const CAMPAIGN = {
  regimeName: 'momentum-and-reversion-1',
  hypotheses: [
    {
      id: 'breakout',
      name: 'Volume breakouts',
      statement: 'Closes above the 20-day high on 1.5x volume follow through within 3 sessions.',
    },
  ],
  universe: UNIVERSE,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
};

const series = (length: number, at: (i: number) => number) =>
  Array.from({ length }, (_, i) => at(i));
const rising50 = series(50, (i) => 100 + i);
const falling50 = series(50, (i) => 200 - i);
const choppy50 = series(50, (i) => (i % 2 === 0 ? 100 : 102));

/** SPY rises, QQQ falls, IWM chops ±2% a day; two of three members sit above their average. */
const SEEDED: RegimeEvidence = {
  asOf: '2026-07-13',
  indexCloses: { SPY: rising50, QQQ: falling50, IWM: choppy50 },
  memberCloses: [
    { symbol: 'AAPL', closes: series(20, (i) => 1 + i) },
    { symbol: 'MSFT', closes: series(20, (i) => 40 - i) },
    { symbol: 'SPY', closes: rising50.slice(-20) },
  ],
};

/** The regime SEEDED's closes give, computed by hand. */
const SEEDED_REGIME: MarketRegime = {
  asOf: '2026-07-13',
  state: 'mixed',
  indexes: {
    SPY: {
      close: 149,
      sma20: 139.5,
      sma50: 124.5,
      aboveSma20: true,
      aboveSma50: true,
      realizedVolPct: 0.49,
    },
    QQQ: {
      close: 151,
      sma20: 160.5,
      sma50: 175.5,
      aboveSma20: false,
      aboveSma50: false,
      realizedVolPct: 0.36,
    },
    IWM: {
      close: 102,
      sma20: 101,
      sma50: 101,
      aboveSma20: true,
      aboveSma50: true,
      realizedVolPct: 32.25,
    },
  },
  // The stress rule reads SPY alone: IWM's 32% does not make the market stressed.
  realizedVolPct: 0.49,
  breadth: { above: 2, total: 3, share: 0.6667 },
};

/** The `count` weekdays up to and including `last`, oldest first. */
function weekdays(last: string, count: number): string[] {
  const days: string[] = [];
  for (
    let d = new Date(`${last}T12:00:00Z`);
    days.length < count;
    d.setUTCDate(d.getUTCDate() - 1)
  ) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.unshift(d.toISOString().slice(0, 10));
  }
  return days;
}

const barTime = (day: string) => `${day}T04:00:00Z`;

/** The exchange clock of a slot on `tradingDay`, the day after it a weekday. */
function clockAt(slot: string, tradingDay: string) {
  const next = new Date(`${tradingDay}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  const at = (day: string, time: string) => `${day}T${time}-04:00`;
  switch (slot) {
    case 'pre_market':
      return {
        timestamp: at(tradingDay, '08:47:00'),
        isOpen: false,
        nextOpen: at(tradingDay, '09:30:00'),
        nextClose: at(tradingDay, '16:00:00'),
      };
    case 'after_close':
      return {
        timestamp: at(tradingDay, '16:23:00'),
        isOpen: false,
        nextOpen: at(nextDay, '09:30:00'),
        nextClose: at(nextDay, '16:00:00'),
      };
    default:
      return {
        timestamp: at(tradingDay, '09:37:00'),
        isOpen: true,
        nextOpen: at(nextDay, '09:30:00'),
        nextClose: at(tradingDay, '16:00:00'),
      };
  }
}

/**
 * What read-index-bars returns on `tradingDay`: fifty sessions of the
 * evidence's closes ending on its asOf, and the forming bar of the trading
 * day itself where the session has opened after asOf.
 */
function indexRead(evidence: RegimeEvidence, slot = 'open', tradingDay = '2026-07-14') {
  const days = weekdays(evidence.asOf, 50);
  const forming = slot !== 'pre_market' && tradingDay > evidence.asOf;
  const bars = (closes: readonly number[]) => [
    ...days.map((day, i) => ({ t: barTime(day), c: closes[i]! })),
    ...(forming ? [{ t: barTime(tradingDay), c: closes[closes.length - 1]! }] : []),
  ];
  return {
    bars: Object.fromEntries(
      REGIME_INDEXES.map((i) => [i, bars(evidence.indexCloses[i])]),
    ) as Record<RegimeIndex, Array<{ t: string; c: number }>>,
    nextPageToken: null,
  };
}

/**
 * What read-universe-bars returns on `tradingDay`: twenty sessions of each
 * member's closes ending on the evidence's asOf, and the forming bar of the
 * trading day itself where the session has opened after asOf.
 */
function universeRead(evidence: RegimeEvidence, slot = 'open', tradingDay = '2026-07-14') {
  const days = weekdays(evidence.asOf, 20);
  const forming = slot !== 'pre_market' && tradingDay > evidence.asOf;
  return {
    bars: Object.fromEntries(
      evidence.memberCloses.map((m) => [
        m.symbol,
        [
          ...days.map((day, i) => ({ t: barTime(day), c: m.closes[i]! })),
          ...(forming ? [{ t: barTime(tradingDay), c: m.closes[m.closes.length - 1]! }] : []),
        ],
      ]),
    ) as Record<string, Array<{ t: string; c: number }>>,
    nextPageToken: null,
  };
}

/** What the regime's upstream tasks produce on one cycle, each read as its task projects it. */
function cycleOutputs(
  evidence: RegimeEvidence,
  slot = 'open',
  tradingDay = '2026-07-14',
  clock = clockAt(slot, tradingDay),
): Record<string, unknown> {
  return {
    'resolve-theses': { ...resolveOutput(slot), tradingDay },
    'ingest-clock': clock,
    'read-index-bars': indexRead(evidence, slot, tradingDay),
    'read-universe-bars': universeRead(evidence, slot, tradingDay),
  };
}

type Gathered = { ok: true; value: GatheredRegime } | { ok: false; message: string };

/**
 * gather-regime over `outputs`, as dispatch and the orchestrator run it: the
 * template resolved, the deriver it names run, and its value projected and
 * held to the task's contract. A producer missing from `outputs` failed as
 * optional, so what it would bind is absent.
 */
function gather(outputs: Record<string, unknown>, universe: unknown = CAMPAIGN.universe): Gathered {
  const t = task('gather-regime');
  const bound = resolveInputs(t, outputs);
  if (universe !== undefined) bound['universe'] = universe;
  const input = WorkflowRunDeriveInputSchema.parse(
    substituteTemplateBinds(
      t.inputTemplate as Record<string, unknown>,
      bound,
      new Set(Object.keys(t.inputBindings ?? {})),
    ),
  );
  const deriver = getRunDeriver(input.deriver);
  if (!deriver) throw new Error(`no run deriver ${input.deriver}`);
  const derived = deriver(input.args);
  if (!derived.ok) return derived;
  const projected = projectTaskOutput(
    t.outputProjection as WorkflowTaskOutputProjection,
    { deriver: input.deriver, value: derived.value },
    input,
  );
  if (!projected.ok) throw new Error(JSON.stringify(projected.failures));
  if (schemaRefuses(t.outputContract!.schema as Record<string, unknown>, projected.value)) {
    throw new Error('the gathered regime fails the gather-regime contract');
  }
  return { ok: true, value: projected.value as unknown as GatheredRegime };
}

/** The regime gather-regime computes on a cycle whose reads hold `evidence`. */
function gathered(
  evidence: RegimeEvidence,
  slot = 'open',
  tradingDay = '2026-07-14',
  clock = clockAt(slot, tradingDay),
): GatheredRegime {
  const result = gather(cycleOutputs(evidence, slot, tradingDay, clock));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Why gather-regime gives no regime over `outputs`. */
function refusal(outputs: Record<string, unknown>, universe: unknown = CAMPAIGN.universe): string {
  const result = gather(outputs, universe);
  if (result.ok) throw new Error('gather-regime computed a regime');
  return result.message;
}

function resolveOutput(slot: string) {
  return {
    tradingDay: '2026-07-14',
    slot,
    slotIndex: null,
    approvedOpenedToday: [],
    benchmarkClose: null,
  };
}

/** A test source standing for a producer task that failed. */
const FAILED = Symbol('failed');

/**
 * The task's static schema with every derivedFrom binding evaluated against
 * `sources`, and a binding on a FAILED source given its whenUpstreamFailed.
 */
function effectiveSchema(t: Task, sources: Record<string, unknown>): Record<string, unknown> {
  const patches = (t.outputContract?.derivedFrom ?? []).map((b) => {
    const m = /^(enum|value|count):(.+)$/.exec(b.binding)!;
    const source = sources[b.from];
    if (source === undefined) throw new Error(`no test source for binding ${b.bindingId}`);
    const path = compileRestrictedPath(m[2]!);
    const kind = m[1] as 'enum' | 'value' | 'count';
    if (source === FAILED) {
      if (!b.whenUpstreamFailed) throw new Error(`${b.bindingId} names no value for a failure`);
      const failedKind = kind === 'value' ? ('const' as const) : kind;
      return {
        bindingId: b.bindingId,
        target: b.target,
        kind: failedKind,
        ...b.whenUpstreamFailed,
      };
    }
    const value =
      kind === 'enum'
        ? evaluateEnum(source, path)
        : kind === 'value'
          ? evaluateValue(source, path)
          : evaluateCount(source, path);
    return {
      bindingId: b.bindingId,
      target: b.target,
      kind: kind === 'value' ? ('const' as const) : kind,
      value,
    };
  });
  return mergeDerivedPatches(t.outputContract!.schema as Record<string, unknown>, patches)
    .effectiveSchema;
}

const schemaRefuses = (schema: Record<string, unknown>, output: unknown) =>
  !ajv.compile(schema)(output);

function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path
    .split('.')
    .reduce<unknown>(
      (v, key) =>
        v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined,
      value,
    );
}

/**
 * A task's resolved inputs, as dispatch resolves them: a producer missing
 * from `outputs` failed as optional, so what it would bind is absent.
 */
function resolveInputs(t: Task, outputs: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [bindAs, binding] of Object.entries(t.inputBindings ?? {})) {
    if (binding.kind !== 'task_output' || !(binding.taskId in outputs)) continue;
    const value = readPath(outputs[binding.taskId], binding.path);
    if (value !== undefined) resolved[bindAs] = value;
  }
  return resolved;
}

function opInput(t: Task, outputs: Record<string, unknown>): Record<string, unknown> {
  return substituteTemplateBinds(
    t.inputTemplate as Record<string, unknown>,
    resolveInputs(t, outputs),
    new Set(Object.keys(t.inputBindings ?? {})),
  );
}

describe('daily-trading-cycle market regime', () => {
  it('computes the moving averages, realized volatility, breadth and state from seeded closes', () => {
    expect(computeMarketRegime(SEEDED)).toEqual(SEEDED_REGIME);
  });

  it('gives each state by its rule', () => {
    const rising = series(20, (i) => 1 + i);
    const falling = series(20, (i) => 40 - i);
    const members = (closes: number[]) => UNIVERSE.map((symbol) => ({ symbol, closes }));
    const state = (indexCloses: RegimeEvidence['indexCloses'], closes: number[]) =>
      computeMarketRegime({ asOf: '2026-07-13', indexCloses, memberCloses: members(closes) }).state;
    expect(state({ SPY: rising50, QQQ: rising50, IWM: rising50 }, rising)).toBe('risk_on');
    // Every trend vote but weak breadth is no risk_on.
    expect(state({ SPY: rising50, QQQ: rising50, IWM: rising50 }, falling)).toBe('mixed');
    expect(state({ SPY: falling50, QQQ: falling50, IWM: falling50 }, falling)).toBe('risk_off');
    expect(state({ SPY: choppy50, QQQ: rising50, IWM: rising50 }, rising)).toBe('stressed');
  });

  it('an index is above its average by the average it reports', () => {
    // The unrounded means sit just under the close (100.00601 and 100.006004),
    // and both round up past it to 100.01.
    const flat = [...series(49, () => 100.006), 100.0062];
    const evidence = { ...SEEDED, indexCloses: { ...SEEDED.indexCloses, IWM: flat } };
    const iwm = computeMarketRegime(evidence).indexes.IWM;
    expect(iwm).toMatchObject({ close: 100.0062, sma20: 100.01, sma50: 100.01 });
    // What a reader gets by comparing the close with the averages reported.
    expect(iwm.aboveSma20).toBe(iwm.close > iwm.sma20);
    expect(iwm.aboveSma50).toBe(iwm.close > iwm.sma50);
    expect(iwm.aboveSma20).toBe(false);
    expect(gathered(evidence).marketRegime.indexes.IWM).toEqual(iwm);
  });

  it('the state reads SPY’s volatility as it reports it', () => {
    // Alternating log returns of ±step have a mean of 0 over 20 returns, so the
    // unrounded volatility is 29.996 and it reports as 30.00.
    const step = 29.996 / (100 * Math.sqrt(252) * Math.sqrt(20 / 19));
    const spy = series(50, (i) => 100 * Math.exp(i % 2 === 0 ? 0 : step));
    expect(realizedVolPct(spy)).toBeGreaterThan(29.995);
    expect(realizedVolPct(spy)).toBeLessThan(30);
    const evidence = { ...SEEDED, indexCloses: { ...SEEDED.indexCloses, SPY: spy } };
    const regime = computeMarketRegime(evidence);
    expect(regime.realizedVolPct).toBe(30);
    // What a reader gets by applying the rule to the volatility reported.
    expect(regime.state).toBe('stressed');
    expect(gathered(evidence).marketRegime).toEqual(regime);
  });

  describe('gather-regime computes the regime by rule, and asks no model', () => {
    const t = task('gather-regime');

    it('is an operation task that runs the market-regime deriver over the reads and the clock', () => {
      expect(t.type).toBe('operation');
      expect(t.operation).toBe('workflow.run.derive');
      expect(t.optional).toBe(true);
      expect(t).not.toHaveProperty('context');
      expect(t.outputContract).not.toHaveProperty('derivedFrom');
      expect(t.outputContract).not.toHaveProperty('validatorRefs');
      expect(t.inputTemplate).toMatchObject({ deriver: MARKET_REGIME_DERIVER });
      expect(getRunDeriver(MARKET_REGIME_DERIVER)).not.toBeNull();
      expect(t.dependsOn).toEqual(
        expect.arrayContaining(['read-index-bars', 'read-universe-bars']),
      );
      expect(t.inputBindings).toMatchObject({
        tradingDay: { kind: 'task_output', taskId: 'resolve-theses', path: 'tradingDay' },
        slot: { kind: 'task_output', taskId: 'resolve-theses', path: 'slot' },
        clockTimestamp: { kind: 'task_output', taskId: 'ingest-clock', path: 'timestamp' },
        marketIsOpen: { kind: 'task_output', taskId: 'ingest-clock', path: 'isOpen' },
        nextOpen: { kind: 'task_output', taskId: 'ingest-clock', path: 'nextOpen' },
        nextClose: { kind: 'task_output', taskId: 'ingest-clock', path: 'nextClose' },
        indexBars: { kind: 'task_output', taskId: 'read-index-bars', path: 'bars' },
        memberBars: { kind: 'task_output', taskId: 'read-universe-bars', path: 'bars' },
        universe: { kind: 'campaign_input', path: 'universe' },
      });
    });

    it('gives the regime the read closes give, with its cycle, clock and read provenance', () => {
      expect(gathered(SEEDED)).toEqual({
        tradingDay: '2026-07-14',
        slot: 'open',
        clock: clockAt('open', '2026-07-14'),
        marketRegime: SEEDED_REGIME,
        read: { bindingId: REGIME_READ_BINDING_ID, asOf: '2026-07-13', count: 51 },
        thinMembers: [],
      });
    });

    it('carries no close: the output is the regime alone, whatever the universe holds', () => {
      const output = gathered(SEEDED);
      expect(Object.keys(output).sort()).toEqual([
        'clock',
        'marketRegime',
        'read',
        'slot',
        'thinMembers',
        'tradingDay',
      ]);
      // Thirty members cost the output nothing: the reads stay in the input.
      const members = Array.from({ length: 30 }, (_, i) => ({
        symbol: `M${String(i)}`,
        closes: series(20, (k) => 10 + ((i + k) % 7)),
      }));
      const wide = { ...SEEDED, memberCloses: members };
      const result = gather(
        cycleOutputs(wide),
        members.map((m) => m.symbol),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.marketRegime.breadth.total).toBe(30);
      expect(JSON.stringify(result.value).length).toBeLessThan(2_000);
    });

    it('the downstream readers bind the regime, its state and its read provenance', () => {
      const output = gathered(SEEDED);
      expect(resolveInputs(task('regime-state'), { 'gather-regime': output })).toEqual({
        regimeState: SEEDED_REGIME.state,
      });
      expect(resolveInputs(task('decide'), { 'gather-regime': output })).toMatchObject({
        marketRegime: SEEDED_REGIME,
      });
      expect(resolveInputs(task('write-cycle-doc'), { 'gather-regime': output })).toMatchObject({
        marketRegime: SEEDED_REGIME,
        regimeRead: output.read,
      });
    });
  });

  describe('the clock’s market close decides whether the trading day’s bar is complete', () => {
    const sameDay = { ...SEEDED, asOf: '2026-07-14' };

    it('an open or intraday cycle after the session close ends on the trading day', () => {
      const afterClose = clockAt('after_close', '2026-07-14');
      for (const slot of ['open', 'intraday']) {
        const output = gathered(sameDay, slot, '2026-07-14', afterClose);
        expect(output.marketRegime.asOf, slot).toBe('2026-07-14');
        expect(output.marketRegime, slot).toEqual(computeMarketRegime(sameDay));
      }
    });

    it('an open or intraday cycle during the session leaves the forming bar out', () => {
      for (const slot of ['open', 'intraday']) {
        const outputs = cycleOutputs(SEEDED, slot);
        const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
        // The forming bar of the trading day is in the read, at a close no series holds.
        for (const i of REGIME_INDEXES) {
          const forming = read.bars[i].at(-1)!;
          expect(forming.t).toBe(barTime('2026-07-14'));
          forming.c = 999;
        }
        const output = gather(outputs);
        expect(output.ok && output.value.marketRegime, slot).toEqual(SEEDED_REGIME);
      }
    });

    it('after_close ends on its own session', () => {
      const output = gathered(sameDay, 'after_close');
      expect(output.marketRegime).toEqual(computeMarketRegime(sameDay));
      expect(output.read.asOf).toBe('2026-07-14');
    });

    it('asOf is the latest completed session, computed from the clock and the read', () => {
      const sessions = ['2026-07-09', '2026-07-10', '2026-07-13', '2026-07-14'].map(barTime);
      for (const [slot, asOf] of [
        ['pre_market', '2026-07-13'],
        ['open', '2026-07-13'],
        ['intraday', '2026-07-13'],
        ['after_close', '2026-07-14'],
      ] as const) {
        expect(latestCompletedSession(clockAt(slot, '2026-07-14'), sessions), slot).toBe(asOf);
      }
      // A holiday has no bar, so the session before it is the latest one.
      const afterHoliday = ['2026-07-01', '2026-07-02', '2026-07-06'].map(barTime);
      expect(latestCompletedSession(clockAt('open', '2026-07-06'), afterHoliday)).toBe(
        '2026-07-02',
      );
    });

    it('gives no regime when the clock is past the trading day', () => {
      const outputs = {
        ...cycleOutputs(SEEDED),
        'resolve-theses': { ...resolveOutput('open'), tradingDay: '2026-07-10' },
      };
      expect(refusal(outputs)).toContain('2026-07-13 is after tradingDay 2026-07-10');
    });
  });

  describe('each index series is the last 50 sessions of the read, ending on asOf', () => {
    it('leaves an older session out', () => {
      const outputs = cycleOutputs(SEEDED);
      const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
      const earlier = barTime(weekdays(SEEDED.asOf, 51)[0]!);
      for (const i of REGIME_INDEXES) read.bars[i].unshift({ t: earlier, c: 1 });
      const output = gather(outputs);
      expect(output.ok && output.value.marketRegime).toEqual(SEEDED_REGIME);
      expect(output.ok && output.value.read.count).toBe(52);
    });

    it('counts a session the read returns twice once', () => {
      const outputs = cycleOutputs(SEEDED);
      const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
      read.bars.QQQ.splice(10, 0, { ...read.bars.QQQ[10]! });
      const output = gather(outputs);
      expect(output.ok && output.value.marketRegime).toEqual(SEEDED_REGIME);
    });

    it('gives no regime from a read with fewer than 50 completed sessions', () => {
      const outputs = cycleOutputs(SEEDED);
      const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
      read.bars.IWM.shift();
      expect(refusal(outputs)).toContain('fewer than 50 IWM sessions up to 2026-07-13');
      expect(refusal(outputs)).toContain(REGIME_UNAVAILABLE);
    });

    it.each(['QQQ', 'IWM'] as const)(
      'gives no regime from a read whose %s series lacks the asOf session',
      (index) => {
        const outputs = cycleOutputs(SEEDED);
        const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
        const earlier = barTime(weekdays(SEEDED.asOf, 51)[0]!);
        read.bars[index] = [
          { t: earlier, c: 1 },
          ...read.bars[index].filter((b) => b.t.slice(0, 10) !== SEEDED.asOf),
        ];
        expect(refusal(outputs)).toContain(`no ${index} session on ${SEEDED.asOf}`);
        expect(refusal(outputs)).toContain(REGIME_UNAVAILABLE);
      },
    );

    it('gives no regime from a read with no completed SPY session', () => {
      const outputs = cycleOutputs(SEEDED);
      const read = outputs['read-index-bars'] as ReturnType<typeof indexRead>;
      read.bars.SPY = read.bars.SPY.slice(-1);
      expect(refusal(outputs)).toContain('no SPY session');
    });
  });

  describe('each member series is the last 20 sessions of the universe read up to asOf', () => {
    it('leaves the forming bar out', () => {
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      expect(universe.bars['AAPL']!.at(-1)!.t).toBe(barTime('2026-07-14'));
      universe.bars['AAPL']!.at(-1)!.c = 0.01;
      const output = gather(outputs);
      expect(output.ok && output.value.marketRegime.breadth).toEqual(SEEDED_REGIME.breadth);
    });

    it('follows the member’s own sessions, not the index sessions', () => {
      // MSFT has no bar on one session, and one more older session fills its twenty.
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      const msft = universe.bars['MSFT']!;
      msft.splice(5, 1);
      msft.unshift({ t: barTime(weekdays(SEEDED.asOf, 21)[0]!), c: 100 });
      const output = gather(outputs);
      expect(output.ok).toBe(true);
      expect(output.ok && output.value.marketRegime.breadth.total).toBe(3);
    });

    it('covers the campaign universe alone', () => {
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      universe.bars['TSLA'] = universe.bars['AAPL']!.map((b) => ({ ...b, c: 5 }));
      const output = gather(outputs);
      expect(output.ok && output.value.marketRegime.breadth).toEqual(SEEDED_REGIME.breadth);
      // A member named twice counts once.
      const twice = gather(cycleOutputs(SEEDED), [...UNIVERSE, 'AAPL']);
      expect(twice.ok && twice.value.marketRegime.breadth).toEqual(SEEDED_REGIME.breadth);
    });

    it('leaves a member the read carries no bars for out of the breadth, and names it', () => {
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      delete universe.bars['AAPL'];
      const result = gather(outputs, UNIVERSE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.thinMembers).toEqual(['AAPL']);
      expect(result.value.marketRegime.breadth.total).toBe(UNIVERSE.length - 1);
    });

    it('a thin member never costs the cycle its regime', () => {
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      universe.bars['MSFT']!.shift();
      const result = gather(outputs, UNIVERSE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.thinMembers).toEqual(['MSFT']);
    });

    it('gives no regime only when no member has 20 sessions', () => {
      const outputs = cycleOutputs(SEEDED);
      const universe = outputs['read-universe-bars'] as ReturnType<typeof universeRead>;
      for (const symbol of UNIVERSE) delete universe.bars[symbol];
      expect(refusal(outputs)).toContain('for no member');
    });

    it('the member closes come from the platform’s read of the campaign universe', () => {
      const read = task('read-universe-bars');
      expect(read.operation).toBe('api.http.call');
      expect(read.optional).toBe(true);
      expect(read.inputBindings).toMatchObject({
        universe: { kind: 'campaign_input', path: 'universe' },
      });
      const input = substituteTemplateBinds(
        read.inputTemplate as Record<string, unknown>,
        { universe: UNIVERSE, start: '2026-04-05T13:00:00.000Z' },
        new Set(Object.keys(read.inputBindings ?? {})),
      );
      expect(input).toMatchObject({
        apiId: 'alpaca-market-data',
        bindingId: REGIME_READ_BINDING_ID,
        endpointId: 'get_v2_stocks_bars',
        params: { symbols: 'AAPL,MSFT,SPY', timeframe: '1Day' },
      });
      const readSchema = read.outputContract!.schema as Record<string, unknown>;
      const universe = universeRead(SEEDED);
      expect(schemaRefuses(readSchema, universe)).toBe(false);
      expect(schemaRefuses(readSchema, { ...universe, nextPageToken: 'page-2' })).toBe(true);
    });
  });

  it('gives no regime when a read failed, so the cycle decides unavailable', () => {
    const { 'read-index-bars': _index, ...withoutIndex } = cycleOutputs(SEEDED);
    expect(refusal(withoutIndex)).toContain('read-index-bars produced no bars');
    const { 'read-universe-bars': _universe, ...withoutUniverse } = cycleOutputs(SEEDED);
    expect(refusal(withoutUniverse)).toContain('read-universe-bars produced no bars');
  });

  it('the index closes come from the read through the market-data binding', () => {
    const read = task('read-index-bars');
    expect(read.operation).toBe('api.http.call');
    expect(read.optional).toBe(true);
    expect(read.inputTemplate).toMatchObject({
      apiId: 'alpaca-market-data',
      bindingId: REGIME_READ_BINDING_ID,
      endpointId: 'get_v2_stocks_bars',
      params: { symbols: 'SPY,QQQ,IWM', timeframe: '1Day' },
    });
    const readSchema = read.outputContract!.schema as Record<string, unknown>;
    expect(schemaRefuses(readSchema, indexRead(SEEDED))).toBe(false);
    // A paged read holds only part of the bars, so it fails and the regime is unavailable.
    expect(schemaRefuses(readSchema, { ...indexRead(SEEDED), nextPageToken: 'page-2' })).toBe(true);
  });
});

function thesis(direction: 'long' | 'short', thesisId = `aapl-${direction}`) {
  return {
    thesisId,
    hypothesisId: 'breakout',
    approvedId: `${thesisId}-ok`,
    instrument: 'AAPL',
    direction,
    rationale: 'Closed above the 20-day high of 187.40 on 1.8x average volume.',
    entryCondition: null,
    falsificationCriterion: 'A daily close below 184.00.',
    confirmationCriterion: 'A daily close above 195.00.',
    deadlineTradingDays: 3,
    sizePct: 5,
    confidence: 'medium',
    entryLevel: 187.4,
    invalidationLevel: direction === 'long' ? 184 : 190,
  };
}

function decision(
  marketState: string,
  theses: unknown[],
  bias: string | null,
  projectedGrossExposurePct = 10,
) {
  return {
    tradingDay: '2026-07-14',
    regimeName: CAMPAIGN.regimeName,
    approvedOpenedToday: [],
    marketState,
    bias,
    approvedSetFault: null,
    theses,
    projectedGrossExposurePct,
    decisionRationale: 'Breakdown setup on AAPL.',
  };
}

describe('daily-trading-cycle regime as information', () => {
  const decide = task('decide');
  const decideSchema = (state: string) =>
    effectiveSchema(decide, {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
      'regime-state': { decision: state },
    });

  it('decide reads the regime, the calendar and the pre-market evidence as inputs, and no cap', () => {
    expect(decide.dependsOn).toEqual(['regime-state', 'read-pre-market', 'tally-set']);
    expect(decide.inputBindings).toMatchObject({
      marketState: { kind: 'task_output', taskId: 'regime-state', path: 'decision' },
      marketRegime: { kind: 'task_output', taskId: 'gather-regime', path: 'marketRegime' },
      calendar: { kind: 'task_output', taskId: 'ingest-calendar', path: 'calendar' },
      preMarketEvidence: { kind: 'task_output', taskId: 'read-pre-market' },
    });
    expect(Object.keys(decide.inputBindings ?? {})).not.toContain('regimeCaps');
    expect(decide.outputContract?.validatorRefs).toEqual(['trading.approved-theses']);
  });

  it('marketState is pinned to the gathered regime', () => {
    const output = decision('risk_off', [thesis('short')], 'short');
    expect(schemaRefuses(decideSchema('risk_off'), output)).toBe(false);
    expect(schemaRefuses(decideSchema('risk_on'), output)).toBe(true);
  });

  it('a regime opens and closes nothing by itself: any direction passes in any state', () => {
    for (const state of ['risk_on', 'mixed', 'risk_off', 'stressed', REGIME_UNAVAILABLE]) {
      const schema = decideSchema(state);
      expect(schemaRefuses(schema, decision(state, [thesis('long')], 'long', 90))).toBe(false);
      expect(schemaRefuses(schema, decision(state, [thesis('short')], 'short'))).toBe(false);
      expect(
        schemaRefuses(schema, decision(state, [thesis('long'), thesis('short')], 'neutral')),
      ).toBe(false);
      expect(schemaRefuses(schema, decision(state, [], null))).toBe(false);
    }
  });

  it('regime-state names the gathered state, or unavailable when gather-regime failed', () => {
    const step = task('regime-state');
    expect(task('gather-regime').optional).toBe(true);
    expect(step.optional).toBeUndefined();
    expect(step.operation).toBe('workflow.run.decide');
    const decided = (outputs: Record<string, unknown>) =>
      decideByRules(WorkflowRunDecideInputSchema.parse(opInput(step, outputs))).decision;
    for (const state of ['risk_on', 'mixed', 'risk_off', 'stressed']) {
      expect(decided({ 'gather-regime': { marketRegime: { state } } })).toBe(state);
    }
    expect(decided({})).toBe(REGIME_UNAVAILABLE);
  });

  it('the campaign holds no cap: no regime caps, no exposure, size or count cap', () => {
    const contract = entry.bundle.manifest.campaign!;
    for (const field of [
      'regimeCaps',
      'maxThesesPerDay',
      'maxPositionSizePct',
      'maxGrossExposurePct',
    ]) {
      expect(contract.fields[field]).toBeUndefined();
    }
    expect(validateCampaignConfig(contract, CAMPAIGN).ok).toBe(true);
    expect(contract.startChecks ?? []).toEqual([]);
  });
});

describe('daily-trading-cycle pre-market evidence', () => {
  const read = task('read-pre-market');
  const projection = read.outputProjection as WorkflowTaskOutputProjection;
  const contract = read.outputContract!.schema as Record<string, unknown>;
  const path = PRE_MARKET_NOTE_PATH_TEMPLATE.replace('{tradingDay}', '2026-07-14');

  /** What the memory read returns for `note` under the task's window. */
  function readResult(note: string | null) {
    if (note === null) return { found: false };
    const data = note.slice(0, PRE_MARKET_EVIDENCE_MAX_CHARS);
    return {
      stat: { path },
      data,
      range: {
        kind: 'chars',
        start: 0,
        end: data.length,
        totalChars: note.length,
        hasMore: data.length < note.length,
      },
    };
  }

  function evidence(note: string | null) {
    const projected = projectTaskOutput(projection, readResult(note), null);
    if (!projected.ok) throw new Error(JSON.stringify(projected.failures));
    expect(schemaRefuses(contract, projected.value)).toBe(false);
    return projected.value;
  }

  it('reads the day’s note through a window capped in characters', () => {
    expect(read.type).toBe('operation');
    expect(read.operation).toBe('memory.store.get');
    expect(opInput(read, { 'resolve-theses': resolveOutput('open') })).toEqual({
      target: { path },
      view: 'content',
      ifMissing: 'absent',
      byteRange: { start: 0, end: PRE_MARKET_EVIDENCE_MAX_CHARS },
      maxBytes: PRE_MARKET_EVIDENCE_MAX_CHARS,
    });
  });

  it('passes the note to decide when it exists', () => {
    expect(evidence('SPY gapped up on CPI. Watch AAPL over 187.40.')).toEqual({
      path,
      text: 'SPY gapped up on CPI. Watch AAPL over 187.40.',
      totalChars: 45,
      truncated: false,
    });
  });

  it('bounds an oversized note and marks it truncated', () => {
    const note = 'x'.repeat(PRE_MARKET_EVIDENCE_MAX_CHARS + 500);
    const value = evidence(note);
    expect(value['truncated']).toBe(true);
    expect(value['totalChars']).toBe(PRE_MARKET_EVIDENCE_MAX_CHARS + 500);
    expect((value['text'] as string).length).toBe(PRE_MARKET_EVIDENCE_MAX_CHARS);
    // The contract bounds the text itself, whatever reaches it.
    expect(schemaRefuses(contract, { ...value, text: note })).toBe(true);
  });

  it('a day with no note passes no text', () => {
    expect(evidence(null)).toEqual({ path: null, text: null, totalChars: null, truncated: null });
    expect(
      schemaRefuses(contract, { path: null, text: 'stale', totalChars: 5, truncated: false }),
    ).toBe(true);
  });
});

describe('daily-trading-cycle calendar and recorded regime', () => {
  const CALENDAR = {
    date: '2026-07-14',
    session: 'half_day',
    earlyCloseAt: '13:00',
    holidayName: null,
    releases: [{ time: '08:30', name: 'CPI', importance: 'high' }],
  };
  const regime = gathered(SEEDED);
  const record = {
    cycleDoc: {
      tradingDay: '2026-07-14',
      slot: 'open',
      slotIndex: null,
      coverageNote: 'No slot missed since the last cycle.',
      thesesOpened: [],
      openedApprovals: [],
      approvedSetFault: null,
      thesesResolved: [],
      submittedCount: 0,
      deferredCount: 0,
      failedCount: 0,
      projectedGrossExposurePct: 0,
      decisionRationale: 'No approved entry for this slot.',
    },
    snapshotDoc: {
      equity: 100000,
      cash: 100000,
      positions: [],
      brokerGrossExposurePct: 0,
      grossExposurePct: 0,
      orphanFlattens: [],
      armTable: null,
    },
    cycleDocPath: '/portfolio/theses/cycles/2026-07-14-open.json',
    snapshotDocPath: '/portfolio/snapshots/2026-07-14-open.json',
  };
  const NOTE_PATH = PRE_MARKET_NOTE_PATH_TEMPLATE.replace('{tradingDay}', '2026-07-14');
  const upstream = {
    'gather-regime': regime,
    'regime-state': { decision: regime.marketRegime.state },
    'read-pre-market': { path: NOTE_PATH, text: 'Watch AAPL.', totalChars: 11, truncated: false },
    decide: { bias: null },
    'decision-state': { decision: regime.marketRegime.state },
    record,
  };
  const recorded = (calendar: unknown = null) => ({
    marketState: regime.marketRegime.state,
    marketRegime: regime.marketRegime,
    calendar,
  });
  const written = (taskId: string, outputs: Record<string, unknown>) =>
    (opInput(task(taskId), outputs)['content'] as { inlineJson: Record<string, unknown> })
      .inlineJson;

  it('reads the calendar from a source the space binds, as an optional task', () => {
    const t = task('ingest-calendar');
    expect(t.optional).toBe(true);
    expect(t.inputTemplate).toMatchObject({ apiId: 'market-calendar', endpointId: 'get_day' });
    expect(opInput(t, { 'resolve-theses': resolveOutput('open') })['params']).toEqual({
      date: '2026-07-14',
    });
    const schema = t.outputContract!.schema as Record<string, unknown>;
    expect(schemaRefuses(schema, { calendar: CALENDAR })).toBe(false);
    expect(schemaRefuses(schema, { calendar: { date: '2026-07-14' } })).toBe(true);
    // A space without a calendar source can still run the cycle.
    const required = deriveRequiredCapabilities(entry.bundle);
    expect(required).not.toContain('market-calendar');
    expect(required).toContain('alpaca-market-data');
  });

  it('the calendar appears when a calendar source is bound', () => {
    const bound = { ...upstream, 'ingest-calendar': { calendar: CALENDAR } };
    for (const id of ['write-cycle-doc', 'write-snapshot']) {
      expect(written(id, bound), id).toMatchObject(recorded(CALENDAR));
    }
    expect(resolveInputs(task('decide'), bound)['calendar']).toEqual(CALENDAR);
  });

  it('the calendar is absent without one', () => {
    // No source bound: the optional calendar task failed and binds nothing.
    for (const id of ['write-cycle-doc', 'write-snapshot']) {
      expect(written(id, upstream), id).toMatchObject(recorded(null));
    }
    expect(resolveInputs(task('decide'), upstream)).not.toHaveProperty('calendar');
  });

  it('the cycle doc and the snapshot carry the regime the decision was made under', () => {
    const cycleDoc = written('write-cycle-doc', upstream);
    expect(cycleDoc).toEqual({
      ...record.cycleDoc,
      bias: null,
      ...recorded(),
      regimeRead: { bindingId: REGIME_READ_BINDING_ID, asOf: '2026-07-13', count: 51 },
      decisionFault: null,
      preMarketNote: NOTE_PATH,
      preMarketFault: null,
    });
    expect(written('write-snapshot', upstream)).toEqual({ ...record.snapshotDoc, ...recorded() });
    // The record writes neither: the snapshot it produces holds its contract's fields only.
    const recordSchema = task('record').outputContract!.schema as {
      properties: { snapshotDoc: { additionalProperties: boolean } };
    };
    expect(recordSchema.properties.snapshotDoc.additionalProperties).toBe(false);
  });

  it('the cycle doc and the snapshot record a regime that could not be gathered', () => {
    const { 'gather-regime': _failed, ...withoutRegime } = upstream;
    const unavailable = {
      ...withoutRegime,
      'regime-state': { decision: REGIME_UNAVAILABLE },
      'decision-state': { decision: REGIME_UNAVAILABLE },
    };
    const absent = { marketState: REGIME_UNAVAILABLE, marketRegime: null, calendar: null };
    expect(written('write-cycle-doc', unavailable)).toEqual({
      ...record.cycleDoc,
      bias: null,
      ...absent,
      regimeRead: null,
      decisionFault: null,
      preMarketNote: NOTE_PATH,
      preMarketFault: null,
    });
    expect(written('write-snapshot', unavailable)).toEqual({ ...record.snapshotDoc, ...absent });
  });

  describe('a cycle whose regime cannot be gathered', () => {
    /** A falsified thesis resolve-theses closes this cycle. */
    const CLOSE = {
      thesisId: 'aapl-long',
      instrument: 'AAPL',
      direction: 'long',
      outcome: 'falsified',
      closePosition: true,
      closeQty: 10,
    };

    /** Each task's answer on a cycle where every regime read fails. */
    function answer(slot: string) {
      return (taskId: string, input: Record<string, unknown>): TaskAnswer => {
        switch (taskId) {
          case 'ingest-clock':
            return {
              data: {
                timestamp: '2026-07-14T20:30:00Z',
                is_open: false,
                next_open: '2026-07-15T13:30:00Z',
                next_close: '2026-07-15T20:00:00Z',
              },
            };
          case 'ingest-account':
            return {
              data: { equity: '100000', cash: '100000', buying_power: '200000', status: 'ACTIVE' },
            };
          case 'ingest-positions':
          case 'ingest-orders':
            return { data: [] };
          case 'resolve-theses':
            return { proceed: true, ...resolveOutput(slot), resolutions: [CLOSE] };
          case 'ingest-calendar':
          case 'read-index-bars':
          case 'read-universe-bars':
            return 'fail';
          case 'read-pre-market':
            return {};
          case 'decide':
            return decision(String(input['marketState']), [], null, 0);
          case 'execute-orders':
            return { orderResults: [], submittedCount: 0, deferredCount: 0, failedCount: 0 };
          case 'record':
            return { ...record, cycleDoc: { ...record.cycleDoc, slot } };
          default:
            return {};
        }
      };
    }

    for (const slot of ['open', 'after_close']) {
      it(`still decides, closes, records and completes on ${slot}`, () => {
        const run = runSkillTasks(
          wf.tasks as unknown as WorkflowTask[],
          { slot },
          answer(slot),
          undefined,
          { campaign: CAMPAIGN },
        );
        expect(run.statuses.get('gather-regime')).toBe('failed');
        for (const id of [
          'regime-state',
          'decide',
          'execute-orders',
          'record',
          'write-snapshot',
          'record-learnings',
          'write-cycle-doc',
        ]) {
          expect(run.statuses.get(id), id).toBe('succeeded');
        }
        const decideInput = run.inputs.get('decide')!;
        expect(decideInput['marketState']).toBe(REGIME_UNAVAILABLE);
        expect(decideInput).not.toHaveProperty('marketRegime');
        // The decision that opens nothing passes its contract under unavailable.
        const unavailableSchema = effectiveSchema(task('decide'), {
          $campaign: CAMPAIGN,
          'resolve-theses': resolveOutput(slot),
          'regime-state': { decision: REGIME_UNAVAILABLE },
        });
        const decided = decision(REGIME_UNAVAILABLE, [], null, 0);
        expect(schemaRefuses(unavailableSchema, decided)).toBe(false);
        // The close reaches the order step.
        expect(run.inputs.get('execute-orders')!['resolutions']).toEqual([CLOSE]);
        const cycleDoc = (
          run.inputs.get('write-cycle-doc')!['content'] as { inlineJson: Record<string, unknown> }
        ).inlineJson;
        expect(cycleDoc).toMatchObject({
          slot,
          marketState: REGIME_UNAVAILABLE,
          marketRegime: null,
          calendar: null,
          regimeRead: null,
        });
      });
    }
  });

  describe('a cycle whose pre-market read fails', () => {
    const CLOSE = {
      thesisId: 'aapl-long',
      instrument: 'AAPL',
      direction: 'long',
      outcome: 'falsified',
      closePosition: true,
      closeQty: 10,
    };
    /** The failure the read's task row records. The cycle doc carries it. */
    const READ_FAULT = 'MEMORY_STORE_UNAVAILABLE: the memory store did not answer';

    function answer(slot: string) {
      return (taskId: string, input: Record<string, unknown>): TaskAnswer => {
        switch (taskId) {
          case 'ingest-clock':
            return {
              data: {
                timestamp: '2026-07-14T14:30:00Z',
                is_open: true,
                next_open: '2026-07-15T13:30:00Z',
                next_close: '2026-07-14T20:00:00Z',
              },
            };
          case 'ingest-account':
            return {
              data: { equity: '100000', cash: '100000', buying_power: '200000', status: 'ACTIVE' },
            };
          case 'ingest-positions':
          case 'ingest-orders':
            return { data: [] };
          case 'resolve-theses':
            return { proceed: true, ...resolveOutput(slot), resolutions: [CLOSE] };
          case 'ingest-calendar':
            return 'fail';
          case 'read-index-bars':
            return { data: { bars: indexRead(SEEDED).bars, next_page_token: null } };
          case 'read-universe-bars':
            return { data: { bars: universeRead(SEEDED).bars, next_page_token: null } };
          case 'read-pre-market':
            return failWith(READ_FAULT);
          case 'decide':
            return decision(String(input['marketState']), [], null, 0);
          case 'execute-orders':
            return { orderResults: [], submittedCount: 1, deferredCount: 0, failedCount: 0 };
          case 'record':
            return { ...record, cycleDoc: { ...record.cycleDoc, slot } };
          default:
            return {};
        }
      };
    }

    it('the read is optional, so its failure blocks nothing after it', () => {
      expect(task('read-pre-market').optional).toBe(true);
    });

    for (const slot of ['open', 'after_close']) {
      it(`decides without evidence, closes, records and completes on ${slot}`, () => {
        const run = runSkillTasks(
          wf.tasks as unknown as WorkflowTask[],
          { slot },
          answer(slot),
          undefined,
          { campaign: CAMPAIGN },
        );
        expect(run.statuses.get('read-pre-market')).toBe('failed');
        for (const id of [
          'decide',
          'decision-state',
          'execute-orders',
          'record',
          'write-snapshot',
          'record-learnings',
          'write-cycle-doc',
        ]) {
          expect(run.statuses.get(id), id).toBe('succeeded');
        }
        const decideInput = run.inputs.get('decide')!;
        expect(decideInput).not.toHaveProperty('preMarketEvidence');
        expect(decideInput['marketState']).toBe(regime.marketRegime.state);
        expect(run.inputs.get('execute-orders')!['resolutions']).toEqual([CLOSE]);
        const cycleDoc = (
          run.inputs.get('write-cycle-doc')!['content'] as { inlineJson: Record<string, unknown> }
        ).inlineJson;
        expect(cycleDoc).toMatchObject({
          slot,
          marketState: regime.marketRegime.state,
          decisionFault: null,
          preMarketNote: null,
          preMarketFault: READ_FAULT,
        });
      });
    }
  });

  describe('a cycle whose decide fails on a validator fault', () => {
    const CLOSE = {
      thesisId: 'aapl-long',
      instrument: 'AAPL',
      direction: 'long',
      outcome: 'falsified',
      closePosition: true,
      closeQty: 10,
    };
    const REPAIR = { thesisId: 'msft-long', instrument: 'MSFT', qty: '4' };
    const ORPHAN = { symbol: 'SPY', qty: '3', side: 'long', evidence: 'provenance undetermined' };
    /** The failure decide's task row records. The cycle doc carries it, not a fixed text. */
    const DECIDE_FAULT =
      'OUTPUT_VALIDATOR_FAULT: trading.regime-caps could not read its inputs: connection terminated';

    /**
     * Each task's answer on a cycle that gathers its regime and whose decide
     * the harness fails: a validator that could not read its inputs fails it
     * as OUTPUT_VALIDATOR_FAULT, transient and retryable.
     */
    function answer(slot: string) {
      return (taskId: string): TaskAnswer => {
        switch (taskId) {
          case 'ingest-clock':
            return {
              data: {
                timestamp: '2026-07-14T14:30:00Z',
                is_open: true,
                next_open: '2026-07-15T13:30:00Z',
                next_close: '2026-07-14T20:00:00Z',
              },
            };
          case 'ingest-account':
            return {
              data: { equity: '100000', cash: '100000', buying_power: '200000', status: 'ACTIVE' },
            };
          case 'ingest-positions':
          case 'ingest-orders':
            return { data: [] };
          case 'resolve-theses':
            return {
              proceed: true,
              ...resolveOutput(slot),
              resolutions: [CLOSE],
              repairCloses: [REPAIR],
              orphanFlattens: [ORPHAN],
            };
          case 'ingest-calendar':
            return 'fail';
          case 'read-index-bars':
            return { data: { bars: indexRead(SEEDED).bars, next_page_token: null } };
          case 'read-universe-bars':
            return { data: { bars: universeRead(SEEDED).bars, next_page_token: null } };
          case 'decide':
            return failWith(DECIDE_FAULT);
          case 'execute-orders':
            return { orderResults: [], submittedCount: 3, deferredCount: 0, failedCount: 0 };
          case 'record':
            return { ...record, cycleDoc: { ...record.cycleDoc, slot } };
          default:
            return {};
        }
      };
    }

    it('decide is optional, so its failure leaves the closes running', () => {
      expect(task('decide').optional).toBe(true);
      expect(task('execute-orders').dependsOn).toEqual(['decision-state']);
      expect(task('decision-state').optional).toBeUndefined();
    });

    for (const slot of ['open', 'after_close']) {
      it(`still closes, repairs, flattens, records and completes on ${slot}, keeping the regime`, () => {
        const run = runSkillTasks(
          wf.tasks as unknown as WorkflowTask[],
          { slot },
          answer(slot),
          undefined,
          { campaign: CAMPAIGN },
        );
        expect(run.statuses.get('gather-regime')).toBe('succeeded');
        expect(run.statuses.get('decide')).toBe('failed');
        for (const id of [
          'decision-state',
          'execute-orders',
          'record',
          'write-snapshot',
          'record-learnings',
          'write-cycle-doc',
        ]) {
          expect(run.statuses.get(id), id).toBe('succeeded');
        }
        // The closes, the repair closes and the orphan flattens reach the
        // order step, and no new entry does.
        const orders = run.inputs.get('execute-orders')!;
        expect(orders['resolutions']).toEqual([CLOSE]);
        expect(orders['repairCloses']).toEqual([REPAIR]);
        expect(orders['orphanFlattens']).toEqual([ORPHAN]);
        expect(orders).not.toHaveProperty('theses');
        // The record learns why, and a failed decide leaves the regime as it was read.
        const recordInput = run.inputs.get('record')!;
        expect(recordInput['marketState']).toBe(regime.marketRegime.state);
        expect(recordInput['decisionFault']).toBe(DECIDE_FAULT);
        const doc = (id: string) =>
          (run.inputs.get(id)!['content'] as { inlineJson: Record<string, unknown> }).inlineJson;
        expect(doc('write-cycle-doc')).toMatchObject({
          slot,
          marketState: regime.marketRegime.state,
          marketRegime: regime.marketRegime,
          bias: null,
          decisionFault: DECIDE_FAULT,
        });
        expect(doc('write-snapshot')).toMatchObject({ marketState: regime.marketRegime.state });
      });
    }

    it('the record contract holds a failed decide to a cycle that opened nothing', () => {
      const schema = effectiveSchema(task('record'), {
        $campaign: CAMPAIGN,
        'resolve-theses': { ...resolveOutput('open'), resolutions: [] },
        'execute-orders': { submittedCount: 0, deferredCount: 0, failedCount: 0 },
        'ingest-account': { equity: 100000, cash: 100000 },
        decide: FAILED,
      }) as {
        properties: {
          openedDocPaths: { minItems: number };
          cycleDoc: {
            properties: {
              openedApprovals: { minItems: number; maxItems: number };
              approvedSetFault: { const: unknown };
            };
          };
        };
      };
      expect(schema.properties.openedDocPaths.minItems).toBe(0);
      expect(schema.properties.cycleDoc.properties.openedApprovals).toMatchObject({
        minItems: 0,
        maxItems: 0,
      });
      expect(schema.properties.cycleDoc.properties.approvedSetFault.const).toBeNull();
    });
  });
});
