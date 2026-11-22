import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  decideByRules,
  deriveRequiredCapabilities,
  projectTaskOutput,
  validateCampaignConfig,
} from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  lookupValidator,
  mergeDerivedPatches,
  substituteTemplateBinds,
  WorkflowRunDecideInputSchema,
  type WorkflowTask,
  type WorkflowTaskOutputProjection,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  MARKET_REGIME_VALIDATOR_REF,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
  REGIME_CAPS_VALIDATOR_REF,
  REGIME_INDEXES,
  REGIME_READ_BINDING_ID,
  REGIME_UNAVAILABLE,
  campaignRegimeCapIssues,
  computeMarketRegime,
  latestCompletedSession,
  marketRegimeIssues,
  realizedVolPct,
  regimeCapIssues,
  regimeCapsApply,
  type RegimeCaps,
  type RegimeEvidence,
  type RegimeIndex,
} from '../skillCatalog/dailyTradingCycleRegime.js';
import { failWith, runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

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
      thesisBudgetPerDay: 2,
    },
  ],
  universe: UNIVERSE,
  maxThesesPerDay: 3,
  maxPositionSizePct: 8,
  maxGrossExposurePct: 60,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
  regimeCaps: {
    risk_off: { maxGrossExposurePct: 20, biases: ['short'] },
    stressed: { maxGrossExposurePct: 10, biases: ['long', 'short', 'neutral'] },
  },
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

function gathered(
  evidence: RegimeEvidence,
  slot = 'open',
  tradingDay = '2026-07-14',
  clock = clockAt(slot, tradingDay),
) {
  const { bars } = indexRead(evidence, slot, tradingDay);
  const upToAsOf = (b: { t: string }) => b.t.slice(0, 10) <= evidence.asOf;
  const members = universeRead(evidence, slot, tradingDay).bars;
  return {
    tradingDay,
    slot,
    clock,
    indexCloses: Object.fromEntries(
      REGIME_INDEXES.map((i) => [i, bars[i].filter(upToAsOf)]),
    ) as Record<RegimeIndex, Array<{ t: string; c: number }>>,
    memberCloses: evidence.memberCloses.map((m) => ({
      symbol: m.symbol,
      closes: members[m.symbol]!.filter(upToAsOf),
    })),
    marketRegime: computeMarketRegime(evidence),
    read: { bindingId: REGIME_READ_BINDING_ID, asOf: evidence.asOf, count: bars.SPY.length },
  };
}

/** The universe read an output's own member series give: what the read held when they are sound. */
function readOfMembers(output: unknown) {
  const members = (output as { memberCloses?: Array<{ symbol: string; closes: unknown }> })
    .memberCloses;
  return {
    bars: Object.fromEntries((members ?? []).map((m) => [m.symbol, m.closes])),
    nextPageToken: null,
  };
}

/**
 * The gather rule's refusals of `output`, held to `read`, the run's
 * read-index-bars output, and to `universe`, its read-universe-bars output.
 * The member tests name the universe read. The rest hold the member series
 * to a read that carries them as reported.
 */
const refusals = (output: unknown, read: unknown, universe: unknown = readOfMembers(output)) =>
  marketRegimeIssues(output, read, universe);

function resolveOutput(slot: string) {
  return {
    tradingDay: '2026-07-14',
    slot,
    slotIndex: null,
    remainingThesesToday: 3,
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
    expect(computeMarketRegime(SEEDED)).toEqual({
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
    });
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
    // What an agent gets by comparing the close with the averages it reported.
    expect(iwm.aboveSma20).toBe(iwm.close > iwm.sma20);
    expect(iwm.aboveSma50).toBe(iwm.close > iwm.sma50);
    expect(iwm.aboveSma20).toBe(false);

    const read = indexRead(evidence);
    const sound = gathered(evidence);
    expect(refusals(sound, read)).toEqual([]);
    const unrounded = {
      ...sound,
      marketRegime: {
        ...sound.marketRegime,
        indexes: { ...sound.marketRegime.indexes, IWM: { ...iwm, aboveSma20: true } },
      },
    };
    expect(refusals(unrounded, read)).not.toEqual([]);
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
    // What an agent gets by applying the rule to the volatility it reported.
    expect(regime.state).toBe('stressed');

    const read = indexRead(evidence);
    const sound = gathered(evidence);
    expect(refusals(sound, read)).toEqual([]);
    const unstressed = { ...sound, marketRegime: { ...sound.marketRegime, state: 'mixed' } };
    expect(refusals(unstressed, read)).not.toEqual([]);
  });

  it('the gather contract accepts the computed regime and refuses any other number', () => {
    const t = task('gather-regime');
    expect(t.type).toBe('agent');
    expect(t.outputContract?.validatorRefs).toEqual([MARKET_REGIME_VALIDATOR_REF]);
    // The rule reads the run's read-index-bars output, so it runs with the runtime context.
    expect(lookupValidator(MARKET_REGIME_VALIDATOR_REF)?.kind).toBe('runtime');
    const read = indexRead(SEEDED);
    const schema = effectiveSchema(t, {
      'resolve-theses': resolveOutput('open'),
      'ingest-clock': clockAt('open', '2026-07-14'),
      'read-index-bars': read,
      $campaign: CAMPAIGN,
    });
    const refuses = (output: unknown) =>
      schemaRefuses(schema, output) || refusals(output, read).length > 0;
    const sound = gathered(SEEDED);
    expect(refuses(sound)).toBe(false);

    // Exactly the computed number, as rounded: one cent off is refused.
    const spy = sound.marketRegime.indexes.SPY;
    const offByACent = {
      ...sound,
      marketRegime: {
        ...sound.marketRegime,
        indexes: { ...sound.marketRegime.indexes, SPY: { ...spy, sma50: spy.sma50 + 0.01 } },
      },
    };
    expect(refuses(offByACent)).toBe(true);

    const withRegime = (patch: Record<string, unknown>) => ({
      ...sound,
      marketRegime: { ...sound.marketRegime, ...patch },
    });
    const indexes = sound.marketRegime.indexes;
    const wrongAverage = withRegime({
      indexes: { ...indexes, SPY: { ...indexes.SPY, sma20: 141 } },
    });
    expect(refuses(wrongAverage)).toBe(true);
    expect(refusals(wrongAverage, read)[0]?.message).toContain('Set it to 139.5');
    expect(refuses(withRegime({ realizedVolPct: 12 }))).toBe(true);
    expect(refuses(withRegime({ breadth: { above: 3, total: 3, share: 1 } }))).toBe(true);
    expect(refuses(withRegime({ breadth: { above: 2, total: 3, share: 0.5 } }))).toBe(true);
    expect(refuses(withRegime({ state: 'risk_on' }))).toBe(true);

    // The breadth covers the campaign universe: no member missing, none outside it.
    expect(refuses({ ...sound, memberCloses: sound.memberCloses.slice(0, 2) })).toBe(true);
    const outsider = [
      ...sound.memberCloses.slice(0, 2),
      { symbol: 'TSLA', closes: sound.memberCloses[0]!.closes.map((b) => ({ ...b, c: 5 })) },
    ];
    expect(refuses({ ...sound, memberCloses: outsider })).toBe(true);
    const twice = [...sound.memberCloses.slice(0, 2), sound.memberCloses[0]!];
    expect(refuses({ ...sound, memberCloses: twice })).toBe(true);
  });

  describe('the clock’s market close decides whether the trading day’s bar is complete', () => {
    const sameDay = { ...SEEDED, asOf: '2026-07-14' };
    const lastSession = (output: ReturnType<typeof gathered>) =>
      output.indexCloses.SPY[output.indexCloses.SPY.length - 1]!.t;

    it('an open or intraday cycle after the session close ends on the trading day', () => {
      const afterClose = clockAt('after_close', '2026-07-14');
      for (const slot of ['open', 'intraday']) {
        const read = indexRead(sameDay, slot);
        const output = gathered(sameDay, slot, '2026-07-14', afterClose);
        expect(lastSession(output), slot).toBe(barTime('2026-07-14'));
        expect(output.marketRegime.asOf, slot).toBe('2026-07-14');
        expect(refusals(output, read), slot).toEqual([]);
        const schema = effectiveSchema(task('gather-regime'), {
          'resolve-theses': resolveOutput(slot),
          'ingest-clock': afterClose,
          'read-index-bars': read,
          $campaign: CAMPAIGN,
        });
        expect(schemaRefuses(schema, output), slot).toBe(false);
      }
    });

    it('an open cycle during the session ends on the session before', () => {
      const output = gathered(SEEDED, 'open');
      expect(output.clock.isOpen).toBe(true);
      expect(lastSession(output)).toBe(barTime('2026-07-13'));
      expect(refusals(output, indexRead(SEEDED, 'open'))).toEqual([]);
    });

    it('refuses a series ending on the forming bar mid-session', () => {
      const issues = refusals(gathered(sameDay, 'intraday'), indexRead(sameDay, 'intraday'));
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['marketRegime', 'asOf'],
            message: expect.stringContaining('still forming on this intraday cycle'),
          }),
          expect.objectContaining({
            path: ['indexCloses', 'SPY', 49, 't'],
            message: expect.stringContaining('still forming on this intraday cycle'),
          }),
        ]),
      );
    });

    it('after_close ends on its own session', () => {
      expect(refusals(gathered(sameDay, 'after_close'), indexRead(sameDay, 'after_close'))).toEqual(
        [],
      );
    });
  });

  describe('each index series is the last 50 completed sessions of the read, ending on asOf', () => {
    // One more completed session before the fifty, so a series can skip one and still hold 50.
    const earlier = barTime(weekdays(SEEDED.asOf, 51)[0]!);
    const base = indexRead(SEEDED);
    const read = {
      ...base,
      bars: Object.fromEntries(
        REGIME_INDEXES.map((i) => [i, [{ t: earlier, c: 99 }, ...base.bars[i]]]),
      ) as typeof base.bars,
    };
    const sound = gathered(SEEDED);
    const spy = sound.indexCloses.SPY;
    const withSpy = (bars: Array<{ t: string; c: number }>) => ({
      ...sound,
      indexCloses: { ...sound.indexCloses, SPY: bars },
    });
    const at = (output: unknown, path: Array<string | number>) =>
      refusals(output, read).filter((issue) => JSON.stringify(issue.path) === JSON.stringify(path));

    it('passes the correct series and leaves the older session out', () => {
      expect(refusals(sound, read)).toEqual([]);
    });

    it('refuses a series that skips a session', () => {
      const skipped = withSpy([{ t: earlier, c: 99 }, ...spy.slice(0, 10), ...spy.slice(11)]);
      expect(skipped.indexCloses.SPY).toHaveLength(50);
      expect(at(skipped, ['indexCloses', 'SPY'])).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(`skips ${weekdays(SEEDED.asOf, 50)[10]!}`),
        }),
      ]);
    });

    it('refuses a series ending on the forming bar on an open cycle', () => {
      const forming = read.bars.SPY[read.bars.SPY.length - 1]!;
      expect(forming.t).toBe(barTime('2026-07-14'));
      const onForming = withSpy([...spy.slice(1), forming]);
      expect(at(onForming, ['indexCloses', 'SPY', 49, 't'])).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('still forming on this open cycle'),
        }),
      ]);
      expect(at(onForming, ['indexCloses', 'SPY'])).toEqual([
        expect.objectContaining({ message: expect.stringContaining('End it on 2026-07-13') }),
      ]);
    });

    it('refuses a series out of order, a repeated session and one ending before asOf', () => {
      const swapped = withSpy([...spy.slice(0, 10), spy[11]!, spy[10]!, ...spy.slice(12)]);
      expect(at(swapped, ['indexCloses', 'SPY', 11, 't'])).toEqual([
        expect.objectContaining({ message: expect.stringContaining('oldest first') }),
      ]);
      const repeated = withSpy([...spy.slice(0, 11), spy[10]!, ...spy.slice(12)]);
      expect(at(repeated, ['indexCloses', 'SPY', 11, 't'])).not.toEqual([]);
      const short = withSpy([{ t: earlier, c: 99 }, ...spy.slice(0, -1)]);
      expect(at(short, ['indexCloses', 'SPY'])).toEqual([
        expect.objectContaining({ message: expect.stringContaining('End it on 2026-07-13') }),
      ]);
    });

    it('binds each close to its session: a close moved to another session is refused', () => {
      const moved = withSpy(
        spy.map((bar, k) =>
          k === 10 ? { ...bar, c: spy[11]!.c } : k === 11 ? { ...bar, c: spy[10]!.c } : bar,
        ),
      );
      expect(at(moved, ['indexCloses', 'SPY', 10, 'c'])).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(`Set it to ${String(spy[10]!.c)}`),
        }),
      ]);
      expect(at(moved, ['indexCloses', 'SPY', 11, 'c'])).not.toEqual([]);
    });

    it('refuses every series when the read cannot be read', () => {
      expect(refusals(sound, null)).toEqual([expect.objectContaining({ path: ['indexCloses'] })]);
    });
  });

  describe('each member series is held bar for bar to the universe read', () => {
    const read = indexRead(SEEDED);
    const universe = universeRead(SEEDED);
    const sound = gathered(SEEDED);
    const aapl = sound.memberCloses[0]!.closes;
    const withAapl = (closes: Array<{ t: string; c: number }>) => ({
      ...sound,
      memberCloses: [{ symbol: 'AAPL', closes }, ...sound.memberCloses.slice(1)],
    });
    const memberIssues = (output: unknown, held: unknown = universe) =>
      refusals(output, read, held).filter((issue) => issue.path[0] === 'memberCloses');

    it('passes a correct read-backed member series, the forming bar left out', () => {
      expect(universe.bars['AAPL']!.at(-1)!.t).toBe(barTime('2026-07-14'));
      expect(refusals(sound, read, universe)).toEqual([]);
    });

    it('refuses a member close that disagrees with the read', () => {
      const lifted = withAapl(aapl.map((bar, k) => (k === 19 ? { ...bar, c: 99 } : bar)));
      expect(memberIssues(lifted)).toEqual([
        expect.objectContaining({
          path: ['memberCloses', 0, 'closes', 19, 'c'],
          message: expect.stringContaining(`Set it to ${String(aapl[19]!.c)}`),
        }),
      ]);
    });

    it('refuses a member the read does not carry', () => {
      const { AAPL: _absent, ...withoutAapl } = universe.bars;
      expect(memberIssues(sound, { ...universe, bars: withoutAapl })).toEqual([
        expect.objectContaining({
          path: ['memberCloses', 0, 'symbol'],
          message: expect.stringContaining('returned no bars for'),
        }),
      ]);
    });

    it('refuses a member series that skips, repeats or adds a session', () => {
      const earlier = { t: barTime(weekdays(SEEDED.asOf, 21)[0]!), c: 0.5 };
      const longer = {
        ...universe,
        bars: { ...universe.bars, AAPL: [earlier, ...universe.bars['AAPL']!] },
      };
      const skipped = withAapl([earlier, ...aapl.slice(0, 10), ...aapl.slice(11)]);
      expect(memberIssues(skipped, longer)).toEqual([
        expect.objectContaining({
          path: ['memberCloses', 0, 'closes'],
          message: expect.stringContaining(`skips ${weekdays(SEEDED.asOf, 20)[10]!}`),
        }),
      ]);
      const repeated = withAapl([...aapl.slice(0, 11), aapl[10]!, ...aapl.slice(12)]);
      expect(memberIssues(repeated)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['memberCloses', 0, 'closes', 11, 't'] }),
        ]),
      );
      const forming = universe.bars['AAPL']!.at(-1)!;
      const onForming = withAapl([...aapl.slice(1), forming]);
      expect(memberIssues(onForming)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['memberCloses', 0, 'closes', 19, 't'],
            message: expect.stringContaining('after asOf'),
          }),
        ]),
      );
    });

    it('refuses every member series when the universe read cannot be read', () => {
      expect(refusals(sound, read, null)).toEqual([
        expect.objectContaining({ path: ['memberCloses'] }),
      ]);
    });

    it('the member closes come from the platform’s read of the campaign universe', () => {
      const t = task('read-universe-bars');
      expect(t.operation).toBe('api.http.call');
      expect(t.optional).toBe(true);
      expect(t.inputBindings).toMatchObject({
        universe: { kind: 'campaign_input', path: 'universe' },
      });
      const input = substituteTemplateBinds(
        t.inputTemplate as Record<string, unknown>,
        { universe: UNIVERSE, start: '2026-04-05T13:00:00.000Z' },
        new Set(Object.keys(t.inputBindings ?? {})),
      );
      expect(input).toMatchObject({
        apiId: 'alpaca-market-data',
        bindingId: REGIME_READ_BINDING_ID,
        endpointId: 'get_v2_stocks_bars',
        params: { symbols: 'AAPL,MSFT,SPY', timeframe: '1Day' },
      });
      const readSchema = t.outputContract!.schema as Record<string, unknown>;
      expect(schemaRefuses(readSchema, universe)).toBe(false);
      expect(schemaRefuses(readSchema, { ...universe, nextPageToken: 'page-2' })).toBe(true);

      const gather = task('gather-regime');
      expect(gather.dependsOn).toContain('read-universe-bars');
      expect(gather.inputBindings).toMatchObject({
        memberBars: { kind: 'task_output', taskId: 'read-universe-bars', path: 'bars' },
      });
      // The agent reads no feed: every close it reports comes from a read.
      expect(gather.context?.capabilities?.integrations ?? []).toEqual([]);
    });
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
    expect(latestCompletedSession(clockAt('open', '2026-07-06'), afterHoliday)).toBe('2026-07-02');

    // A stale regime: the closes end a session early on an open cycle whose read holds 2026-07-13.
    const stale = gathered({ ...SEEDED, asOf: '2026-07-10' });
    expect(refusals(stale, indexRead(SEEDED))[0]).toMatchObject({
      path: ['marketRegime', 'asOf'],
      message: expect.stringContaining('Set it to 2026-07-13'),
    });

    // The clock and every session are pinned to their producers, so asOf is no agent’s pick.
    const t = task('gather-regime');
    expect(t.dependsOn).toContain('read-index-bars');
    const schema = effectiveSchema(t, {
      'resolve-theses': resolveOutput('open'),
      'ingest-clock': clockAt('open', '2026-07-14'),
      'read-index-bars': indexRead(SEEDED),
      $campaign: CAMPAIGN,
    });
    const sound = gathered(SEEDED);
    expect(schemaRefuses(schema, sound)).toBe(false);
    expect(schemaRefuses(schema, { ...sound, clock: { ...sound.clock, isOpen: false } })).toBe(
      true,
    );
    const spy = sound.indexCloses.SPY;
    const invented = [...spy.slice(0, -1), { ...spy[spy.length - 1]!, t: barTime('2026-07-15') }];
    expect(
      schemaRefuses(schema, { ...sound, indexCloses: { ...sound.indexCloses, SPY: invented } }),
    ).toBe(true);
    expect(
      schemaRefuses(schema, { ...sound, indexCloses: { ...sound.indexCloses, SPY: spy.slice(1) } }),
    ).toBe(true);
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

    const t = task('gather-regime');
    expect(t.inputBindings).toMatchObject({
      indexBars: { kind: 'task_output', taskId: 'read-index-bars', path: 'bars' },
    });
    const schema = effectiveSchema(t, {
      'resolve-theses': resolveOutput('open'),
      'ingest-clock': clockAt('open', '2026-07-14'),
      'read-index-bars': indexRead(SEEDED),
      $campaign: CAMPAIGN,
    });
    const sound = gathered(SEEDED);
    const last = sound.indexCloses.SPY[sound.indexCloses.SPY.length - 1]!;
    const spy = [...sound.indexCloses.SPY.slice(0, -1), { ...last, c: 500 }];
    const notRead = { ...sound, indexCloses: { ...sound.indexCloses, SPY: spy } };
    expect(schemaRefuses(schema, notRead)).toBe(true);
    // The provenance names the binding and the bars the read returned.
    expect(schemaRefuses(schema, { ...sound, read: { ...sound.read, count: 3 } })).toBe(true);
    expect(
      schemaRefuses(schema, { ...sound, read: { ...sound.read, bindingId: 'another-feed' } }),
    ).toBe(true);
    expect(
      refusals({ ...sound, read: { ...sound.read, asOf: '2026-07-10' } }, indexRead(SEEDED)),
    ).not.toEqual([]);
  });
});

function thesis(direction: 'long' | 'short', thesisId = `aapl-${direction}`) {
  return {
    thesisId,
    hypothesisId: 'breakout',
    approvedId: `${thesisId}-ok`,
    reviewRunId: 'run-review-0714',
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
    slot: 'open',
    slotIndex: null,
    marketState,
    bias,
    approvedSetFault: null,
    theses,
    projectedGrossExposurePct,
    decisionRationale: 'Breakdown setup on AAPL.',
  };
}

describe('daily-trading-cycle per-regime caps', () => {
  const decide = task('decide');
  const decideSchema = (state: string) =>
    effectiveSchema(decide, {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
      'regime-state': { decision: state },
    });

  it('decide takes the regime, its caps, the calendar and the pre-market evidence as inputs', () => {
    expect(decide.dependsOn).toEqual(['regime-state', 'read-pre-market']);
    expect(decide.inputBindings).toMatchObject({
      marketState: { kind: 'task_output', taskId: 'regime-state', path: 'decision' },
      marketRegime: { kind: 'task_output', taskId: 'gather-regime', path: 'marketRegime' },
      regimeCaps: { kind: 'campaign_input', path: 'regimeCaps' },
      calendar: { kind: 'task_output', taskId: 'ingest-calendar', path: 'calendar' },
      preMarketEvidence: { kind: 'task_output', taskId: 'read-pre-market' },
    });
    expect(decide.outputContract?.validatorRefs).toContain(REGIME_CAPS_VALIDATOR_REF);
    expect(lookupValidator(REGIME_CAPS_VALIDATOR_REF)?.kind).toBe('runtime');
  });

  it('marketState is pinned to the gathered regime', () => {
    const output = decision('risk_off', [thesis('short')], 'short');
    expect(schemaRefuses(decideSchema('risk_off'), output)).toBe(false);
    expect(schemaRefuses(decideSchema('risk_on'), output)).toBe(true);
  });

  it('a decision over the regime’s gross exposure cap is refused', () => {
    const at = decision('risk_off', [thesis('short')], 'short', 20);
    const over = decision('risk_off', [thesis('short')], 'short', 25);
    expect(schemaRefuses(decideSchema('risk_off'), over)).toBe(false);
    expect(regimeCapIssues(at, CAMPAIGN.regimeCaps)).toEqual([]);
    expect(regimeCapIssues(over, CAMPAIGN.regimeCaps)).toEqual([
      expect.objectContaining({ path: ['projectedGrossExposurePct'] }),
    ]);
    // Under the campaign-wide cap is not enough in a capped state.
    expect(over.projectedGrossExposurePct).toBeLessThan(CAMPAIGN.maxGrossExposurePct);
    // A state the campaign does not cap is held to the campaign-wide cap alone.
    expect(
      regimeCapIssues(decision('mixed', [thesis('long')], 'long', 55), CAMPAIGN.regimeCaps),
    ).toEqual([]);
  });

  it('a decision with a bias the regime forbids is refused', () => {
    const long = decision('risk_off', [thesis('long')], 'long');
    expect(schemaRefuses(decideSchema('risk_off'), long)).toBe(false);
    expect(regimeCapIssues(long, CAMPAIGN.regimeCaps)).toEqual([
      expect.objectContaining({ path: ['theses', 0, 'direction'] }),
    ]);
    const neutral = decision('stressed', [thesis('long'), thesis('short')], 'neutral', 8);
    expect(regimeCapIssues(neutral, CAMPAIGN.regimeCaps)).toEqual([]);
    // Both directions listed without neutral: each alone, never both in one decision.
    const unmixed: RegimeCaps = { risk_on: { maxGrossExposurePct: 50, biases: ['long', 'short'] } };
    const short = decision('risk_on', [thesis('short')], 'short');
    expect(regimeCapIssues(short, unmixed)).toEqual([]);
    expect(
      regimeCapIssues(decision('risk_on', [thesis('long'), thesis('short')], 'neutral'), unmixed),
    ).toEqual([expect.objectContaining({ path: ['bias'] })]);
  });

  it('a long-only regime refuses a decision that mixes one long and one short thesis', () => {
    const mixed = decision('risk_on', [thesis('long'), thesis('short')], 'neutral');
    expect(schemaRefuses(decideSchema('risk_on'), mixed)).toBe(false);
    const longOnly: RegimeCaps = { risk_on: { maxGrossExposurePct: 50, biases: ['long'] } };
    expect(regimeCapIssues(mixed, longOnly)).toEqual([
      expect.objectContaining({ path: ['theses', 1, 'direction'] }),
    ]);
    // A neutral label cannot carry the direction the regime leaves out.
    const longOrNeutral: RegimeCaps = {
      risk_on: { maxGrossExposurePct: 50, biases: ['long', 'neutral'] },
    };
    expect(regimeCapIssues(mixed, longOrNeutral)).toEqual([
      expect.objectContaining({ path: ['theses', 1, 'direction'] }),
    ]);
    expect(regimeCapIssues(decision('risk_on', [thesis('long')], 'long'), longOnly)).toEqual([]);
  });

  it('the bias a decision names is the one its theses take', () => {
    const schema = decideSchema('risk_on');
    expect(schemaRefuses(schema, decision('risk_on', [thesis('long')], 'long'))).toBe(false);
    expect(schemaRefuses(schema, decision('risk_on', [thesis('long')], 'short'))).toBe(true);
    expect(schemaRefuses(schema, decision('risk_on', [thesis('long')], 'neutral'))).toBe(true);
    expect(schemaRefuses(schema, decision('risk_on', [thesis('long')], null))).toBe(true);
    expect(
      schemaRefuses(schema, decision('risk_on', [thesis('long'), thesis('short')], 'neutral')),
    ).toBe(false);
    expect(schemaRefuses(schema, decision('risk_on', [], null))).toBe(false);
    expect(schemaRefuses(schema, decision('risk_on', [], 'long'))).toBe(true);
  });

  it('a decision that opens nothing passes in any regime, so its closes run', () => {
    const none = decision('stressed', [], null, 55);
    expect(regimeCapIssues(none, CAMPAIGN.regimeCaps)).toEqual([]);
    expect(regimeCapsApply(none)).toBe(false);
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

  it('without a regime, decide is pinned to unavailable and its contract refuses any new thesis', () => {
    const schema = decideSchema(REGIME_UNAVAILABLE);
    // No new entry of any direction, whatever the exposure.
    for (const opened of [[thesis('long')], [thesis('short')], [thesis('long'), thesis('short')]]) {
      const bias = opened.length === 2 ? 'neutral' : opened[0]!.direction;
      expect(schemaRefuses(schema, decision(REGIME_UNAVAILABLE, opened, bias, 5))).toBe(true);
    }
    // The decision that resolves, closes and records passes.
    expect(schemaRefuses(schema, decision(REGIME_UNAVAILABLE, [], null, 0))).toBe(false);
    expect(schemaRefuses(schema, decision(REGIME_UNAVAILABLE, [], 'long', 0))).toBe(true);
    // The pin holds: a gathered state cannot stand in for unavailable.
    expect(schemaRefuses(schema, decision('risk_off', [thesis('short')], 'short'))).toBe(true);
    // A gathered regime is still held to its caps.
    expect(
      schemaRefuses(decideSchema('risk_off'), decision('risk_off', [thesis('long')], 'long')),
    ).toBe(false);
    expect(regimeCapsApply(decision('risk_off', [thesis('long')], 'long'))).toBe(true);
  });

  it('campaign start refuses a campaign without regimeCaps, so no running campaign lacks them', () => {
    const contract = entry.bundle.manifest.campaign!;
    const { regimeCaps: _omitted, ...withoutCaps } = CAMPAIGN;
    const missing = validateCampaignConfig(contract, withoutCaps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues).toEqual([
        expect.objectContaining({ field: 'regimeCaps', code: 'MISSING_FIELD' }),
      ]);
    }
    // The contract's own rule refuses caps that do not parse, whatever reaches it.
    expect(campaignRegimeCapIssues(withoutCaps)).toEqual([
      expect.objectContaining({ path: ['regimeCaps'] }),
    ]);
    expect(
      campaignRegimeCapIssues({ ...CAMPAIGN, regimeCaps: { risk_on: { biases: ['long'] } } }),
    ).toEqual([expect.objectContaining({ path: ['regimeCaps'] })]);
    expect(campaignRegimeCapIssues(CAMPAIGN)).toEqual([]);
  });

  it('the caps are a frozen campaign field, and none may exceed the campaign-wide cap', () => {
    const contract = entry.bundle.manifest.campaign!;
    expect(contract.fields['regimeCaps']?.mutable).toBe(false);
    expect(validateCampaignConfig(contract, CAMPAIGN).ok).toBe(true);
    expect(validateCampaignConfig(contract, { ...CAMPAIGN, regimeCaps: {} }).ok).toBe(true);
    const { regimeCaps: _omitted, ...withoutCaps } = CAMPAIGN;
    expect(validateCampaignConfig(contract, withoutCaps).ok).toBe(false);
    const above = validateCampaignConfig(contract, {
      ...CAMPAIGN,
      regimeCaps: { risk_on: { maxGrossExposurePct: 80, biases: ['long'] } },
    });
    expect(above.ok).toBe(false);
    if (!above.ok) {
      expect(above.issues).toEqual([
        expect.objectContaining({ field: 'regimeCaps', code: 'RULE_VIOLATION' }),
      ]);
    }
    // neutral without both directions beside it admits no thesis, so start refuses it.
    const neutralAlone = {
      ...CAMPAIGN.regimeCaps,
      stressed: { maxGrossExposurePct: 10, biases: ['neutral'] },
    };
    expect(validateCampaignConfig(contract, { ...CAMPAIGN, regimeCaps: neutralAlone }).ok).toBe(
      false,
    );
    expect(campaignRegimeCapIssues({ ...CAMPAIGN, regimeCaps: neutralAlone })).toEqual([
      expect.objectContaining({ path: ['regimeCaps', 'stressed', 'biases'] }),
    ]);
    const badBias = validateCampaignConfig(contract, {
      ...CAMPAIGN,
      regimeCaps: { risk_on: { maxGrossExposurePct: 50, biases: ['sideways'] } },
    });
    expect(badBias.ok).toBe(false);
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
          case 'gather-regime':
            return 'fail';
          case 'read-pre-market':
            return {};
          case 'decide':
            return { ...decision(String(input['marketState']), [], null, 0), slot };
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
        const run = runSkillTasks(wf.tasks as unknown as WorkflowTask[], { slot }, answer(slot));
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
        const decided = { ...decision(REGIME_UNAVAILABLE, [], null, 0), slot };
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
          case 'gather-regime':
            return regime;
          case 'read-pre-market':
            return failWith(READ_FAULT);
          case 'decide':
            return { ...decision(String(input['marketState']), [], null, 0), slot };
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
        const run = runSkillTasks(wf.tasks as unknown as WorkflowTask[], { slot }, answer(slot));
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
          case 'gather-regime':
            return regime;
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
      it(`still closes, repairs, flattens, records and completes on ${slot}, deciding unavailable`, () => {
        const run = runSkillTasks(wf.tasks as unknown as WorkflowTask[], { slot }, answer(slot));
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
        // The record learns why, and the docs name the state unavailable.
        const recordInput = run.inputs.get('record')!;
        expect(recordInput['marketState']).toBe(REGIME_UNAVAILABLE);
        expect(recordInput['decisionFault']).toBe(DECIDE_FAULT);
        const doc = (id: string) =>
          (run.inputs.get(id)!['content'] as { inlineJson: Record<string, unknown> }).inlineJson;
        expect(doc('write-cycle-doc')).toMatchObject({
          slot,
          marketState: REGIME_UNAVAILABLE,
          marketRegime: regime.marketRegime,
          bias: null,
          decisionFault: DECIDE_FAULT,
        });
        expect(doc('write-snapshot')).toMatchObject({ marketState: REGIME_UNAVAILABLE });
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
