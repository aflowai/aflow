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
  getValidator,
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
  REGIME_UNAVAILABLE,
  computeMarketRegime,
  realizedVolPct,
  regimeCapIssues,
  regimeCapsApply,
  type RegimeEvidence,
} from '../skillCatalog/dailyTradingCycleRegime.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

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
    risk_off: { maxGrossExposurePct: 20, biases: ['short', 'neutral'] },
    stressed: { maxGrossExposurePct: 10, biases: ['neutral'] },
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

function gathered(evidence: RegimeEvidence, slot = 'open', tradingDay = '2026-07-14') {
  return {
    tradingDay,
    slot,
    indexCloses: evidence.indexCloses,
    memberCloses: evidence.memberCloses,
    marketRegime: computeMarketRegime(evidence),
  };
}

function resolveOutput(slot: string) {
  return { tradingDay: '2026-07-14', slot, slotIndex: null, remainingThesesToday: 3 };
}

/** The task's static schema with every derivedFrom binding evaluated against `sources`. */
function effectiveSchema(t: Task, sources: Record<string, unknown>): Record<string, unknown> {
  const patches = (t.outputContract?.derivedFrom ?? []).map((b) => {
    const m = /^(enum|value|count):(.+)$/.exec(b.binding)!;
    const source = sources[b.from];
    if (source === undefined) throw new Error(`no test source for binding ${b.bindingId}`);
    const path = compileRestrictedPath(m[2]!);
    const kind = m[1] as 'enum' | 'value' | 'count';
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

    const rule = getValidator(MARKET_REGIME_VALIDATOR_REF)!;
    const sound = gathered(evidence);
    expect(rule.safeParse(sound).success).toBe(true);
    const unrounded = {
      ...sound,
      marketRegime: {
        ...sound.marketRegime,
        indexes: { ...sound.marketRegime.indexes, IWM: { ...iwm, aboveSma20: true } },
      },
    };
    expect(rule.safeParse(unrounded).success).toBe(false);
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

    const rule = getValidator(MARKET_REGIME_VALIDATOR_REF)!;
    const sound = gathered(evidence);
    expect(rule.safeParse(sound).success).toBe(true);
    const unstressed = { ...sound, marketRegime: { ...sound.marketRegime, state: 'mixed' } };
    expect(rule.safeParse(unstressed).success).toBe(false);
  });

  it('the gather contract accepts the computed regime and refuses any other number', () => {
    const t = task('gather-regime');
    expect(t.type).toBe('agent');
    expect(t.outputContract?.validatorRefs).toEqual([MARKET_REGIME_VALIDATOR_REF]);
    const rule = getValidator(MARKET_REGIME_VALIDATOR_REF)!;
    const schema = effectiveSchema(t, {
      'resolve-theses': resolveOutput('open'),
      $campaign: CAMPAIGN,
    });
    const refuses = (output: unknown) =>
      schemaRefuses(schema, output) || !rule.safeParse(output).success;
    const sound = gathered(SEEDED);
    expect(refuses(sound)).toBe(false);

    const withRegime = (patch: Record<string, unknown>) => ({
      ...sound,
      marketRegime: { ...sound.marketRegime, ...patch },
    });
    const indexes = sound.marketRegime.indexes;
    const wrongAverage = withRegime({
      indexes: { ...indexes, SPY: { ...indexes.SPY, sma20: 141 } },
    });
    expect(refuses(wrongAverage)).toBe(true);
    expect(rule.safeParse(wrongAverage).error?.issues[0]?.message).toContain('Set it to 139.5');
    expect(refuses(withRegime({ realizedVolPct: 12 }))).toBe(true);
    expect(refuses(withRegime({ breadth: { above: 3, total: 3, share: 1 } }))).toBe(true);
    expect(refuses(withRegime({ breadth: { above: 2, total: 3, share: 0.5 } }))).toBe(true);
    expect(refuses(withRegime({ state: 'risk_on' }))).toBe(true);

    // The breadth covers the campaign universe: no member missing, none outside it.
    expect(refuses({ ...sound, memberCloses: sound.memberCloses.slice(0, 2) })).toBe(true);
    const outsider = [
      ...sound.memberCloses.slice(0, 2),
      { symbol: 'TSLA', closes: series(20, () => 5) },
    ];
    expect(refuses({ ...sound, memberCloses: outsider })).toBe(true);
    const twice = [...sound.memberCloses.slice(0, 2), sound.memberCloses[0]!];
    expect(refuses({ ...sound, memberCloses: twice })).toBe(true);
  });

  it('a cycle before the close reads completed sessions only', () => {
    const rule = getValidator(MARKET_REGIME_VALIDATOR_REF)!;
    const sameDay = { ...SEEDED, asOf: '2026-07-14' };
    expect(rule.safeParse(gathered(sameDay, 'intraday')).success).toBe(false);
    expect(rule.safeParse(gathered(sameDay, 'after_close')).success).toBe(true);
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
      expect.objectContaining({ path: ['bias'] }),
    ]);
    const neutral = decision('stressed', [thesis('long'), thesis('short')], 'neutral', 8);
    expect(regimeCapIssues(neutral, CAMPAIGN.regimeCaps)).toEqual([]);
    expect(
      regimeCapIssues(
        { ...neutral, theses: [thesis('short')], bias: 'short' },
        CAMPAIGN.regimeCaps,
      ),
    ).toEqual([expect.objectContaining({ path: ['bias'] })]);
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
  const upstream = {
    'gather-regime': regime,
    'regime-state': { decision: regime.marketRegime.state },
    decide: { bias: null },
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
    expect(cycleDoc).toEqual({ ...record.cycleDoc, bias: null, ...recorded() });
    expect(written('write-snapshot', upstream)).toEqual({ ...record.snapshotDoc, ...recorded() });
    // The record writes neither: the snapshot it produces holds its contract's fields only.
    const recordSchema = task('record').outputContract!.schema as {
      properties: { snapshotDoc: { additionalProperties: boolean } };
    };
    expect(recordSchema.properties.snapshotDoc.additionalProperties).toBe(false);
  });

  it('the cycle doc and the snapshot record a regime that could not be gathered', () => {
    const { 'gather-regime': _failed, ...withoutRegime } = upstream;
    const unavailable = { ...withoutRegime, 'regime-state': { decision: REGIME_UNAVAILABLE } };
    const absent = { marketState: REGIME_UNAVAILABLE, marketRegime: null, calendar: null };
    expect(written('write-cycle-doc', unavailable)).toEqual({
      ...record.cycleDoc,
      bias: null,
      ...absent,
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
        });
      });
    }
  });
});
