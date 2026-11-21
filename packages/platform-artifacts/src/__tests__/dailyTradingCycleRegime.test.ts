import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
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
  type WorkflowTaskOutputProjection,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  MARKET_REGIME_VALIDATOR_REF,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
  REGIME_CAPS_VALIDATOR_REF,
  computeMarketRegime,
  regimeCapIssues,
  type RegimeEvidence,
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
      'gather-regime': { marketRegime: { state } },
    });

  it('decide takes the regime, its caps, the calendar and the pre-market evidence as inputs', () => {
    expect(decide.dependsOn).toEqual(['gather-regime', 'read-pre-market']);
    expect(decide.inputBindings).toMatchObject({
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
    // Even a campaign without caps: only new theses need them.
    expect(regimeCapIssues(none, undefined)).toEqual([]);
    expect(regimeCapIssues(decision('stressed', [thesis('long')], 'long'), undefined)).toEqual([
      expect.objectContaining({ path: ['marketState'] }),
    ]);
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
    decide: { bias: null },
    record,
  };
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
      expect(written(id, bound)['marketRegime'], id).toEqual({
        ...regime.marketRegime,
        calendar: CALENDAR,
      });
    }
    expect(resolveInputs(task('decide'), bound)['calendar']).toEqual(CALENDAR);
  });

  it('the calendar is absent without one', () => {
    // No source bound: the optional calendar task failed and binds nothing.
    for (const id of ['write-cycle-doc', 'write-snapshot']) {
      expect(written(id, upstream)['marketRegime'], id).toEqual({
        ...regime.marketRegime,
        calendar: null,
      });
    }
    expect(resolveInputs(task('decide'), upstream)).not.toHaveProperty('calendar');
  });

  it('the cycle doc and the snapshot carry the regime the decision was made under', () => {
    const cycleDoc = written('write-cycle-doc', upstream);
    expect(cycleDoc).toEqual({
      ...record.cycleDoc,
      bias: null,
      marketRegime: { ...regime.marketRegime, calendar: null },
    });
    expect(written('write-snapshot', upstream)).toEqual({
      ...record.snapshotDoc,
      marketRegime: { ...regime.marketRegime, calendar: null },
    });
    // The record writes neither: the snapshot it produces holds its contract's fields only.
    const recordSchema = task('record').outputContract!.schema as {
      properties: { snapshotDoc: { additionalProperties: boolean } };
    };
    expect(recordSchema.properties.snapshotDoc.additionalProperties).toBe(false);
  });
});
