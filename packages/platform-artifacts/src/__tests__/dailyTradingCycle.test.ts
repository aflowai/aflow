import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  archiveThesisLedger,
  armTableIssues,
  computeArmTable,
  readLedgerTheses,
  failWith,
  runSkillTasks,
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateCampaignConfig,
  validateWhenExpression,
  validateWorkflowGraph,
  type ThesisLedgerArchiveStore,
  type ThesisLedgerDoc,
  type ThesisLedgerHolder,
  type TaskAnswer,
} from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  SkillComposeBundleSchema,
  getOperation,
  getRunDeriver,
  getValidator,
  lookupValidator,
  mergeDerivedPatches,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';
import AjvModule from 'ajv';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { PRODUCTION_UNIVERSE } from './productionSize.js';
import { INTRADAY_INDEX_RULE } from '../skillCatalog/dailyTradingCycleSlots.js';
import {
  APPROVED_THESES_VALIDATOR_REF,
  CYCLE_WORKFLOW_SLUG,
  DESK_TALLY_DERIVER,
  approvedThesesIssues,
  deskTallyDerivation,
  type ApprovedSetRead,
  type ApprovedSetSource,
  type OpeningLedgerDoc,
  type ApprovedSetWriter,
} from '../skillCatalog/dailyTradingCycleApproved.js';
import { DESK_LENSES, DESK_TALLY_RULE } from '../skillCatalog/strategyDeskTally.js';
import {
  ACCOUNT_CONFIG_TASK_ID,
  FRACTIONAL_TRADING_PIN,
} from '../skillCatalog/dailyTradingCycleShortSizing.js';

const CYCLE_SLUG = 'daily-trading-cycle';
const PROCEED_GATE = 'tasks.resolve-theses.output.proceed == true';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

type CycleSlot = 'pre_market' | 'open' | 'intraday' | 'after_close';
type CatalogTask = {
  outputContract?: {
    schema?: unknown;
    derivedFrom?: ReadonlyArray<{
      bindingId: string;
      from: string;
      binding: string;
      target: string;
    }>;
    validatorRefs?: readonly string[];
  };
};

const CAMPAIGN = {
  regimeName: 'momentum-and-reversion-1',
  hypotheses: [
    {
      id: 'breakout',
      name: 'Volume breakouts',
      statement: 'Closes above the 20-day high on 1.5x volume follow through within 3 sessions.',
    },
    {
      id: 'gap-fade',
      name: 'Opening gap fades',
      statement: 'Opening gaps over 2% on no news retrace half the gap by the close.',
    },
  ],
  universe: [...PRODUCTION_UNIVERSE],
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
};

/** The regime-state output every decide contract in this suite pins its marketState to. */
const REGIME_STATE = { decision: 'risk_on' };

/** The sources a contract binds when a test names none: an account read that omits fractional_trading. */
const DEFAULT_SOURCES: Record<string, Record<string, unknown>> = {
  'regime-state': REGIME_STATE,
  'ingest-account-config': { fractionalTrading: null },
  'derive-trading-day': { tradingDay: '2026-07-14' },
};

/** A valid resolve-theses output for one slot, with nothing resolved. */
function resolveOutput(slot: CycleSlot, overrides: Record<string, unknown> = {}) {
  return {
    tradingDay: '2026-07-14',
    slot,
    slotIndex: slot === 'intraday' ? 3 : null,
    proceed: true,
    noopReason: null,
    resolutions: [],
    openThesesAfter: [],
    pendingIntentions: [],
    repairCloses: [],
    orphanFlattens: [],
    thesesOpenedToday: [],
    approvedOpenedToday: [],
    coverageNote: 'No slot missed since the last cycle.',
    benchmarkClose: null,
    ...overrides,
  };
}

function thesis(
  thesisId: string,
  entryCondition: string | null,
  hypothesisId = 'breakout',
  approvedId = 'aapl-breakout-1',
) {
  return {
    thesisId,
    hypothesisId,
    approvedId,
    instrument: 'AAPL',
    direction: 'long',
    rationale: 'Closed above the 20-day high of 187.40 on 1.8x average volume.',
    entryCondition,
    falsificationCriterion: 'A daily close below 184.00.',
    confirmationCriterion: 'A daily close above 195.00.',
    deadlineTradingDays: 3,
    sizePct: 5,
    confidence: 'medium',
    entryLevel: 187.4,
    invalidationLevel: 184,
  };
}

/** A decide output for the 2026-07-14 cycle of `resolveOutput`. */
function decision(theses: unknown[]) {
  return {
    tradingDay: '2026-07-14',
    regimeName: CAMPAIGN.regimeName,
    marketState: 'risk_on',
    bias: theses.length > 0 ? 'long' : null,
    approvedSetFault: null,
    theses,
    projectedGrossExposurePct: 10,
    decisionRationale: 'Breakout setup on AAPL.',
  };
}

function openDoc(
  thesisId: string,
  hypothesisId: string,
  openedTradingDay: string,
  regimeName = CAMPAIGN.regimeName,
): ThesisLedgerDoc {
  return {
    path: `/portfolio/theses/open/${thesisId}.json`,
    content: JSON.stringify({
      thesisId,
      hypothesisId,
      regimeName,
      openedTradingDay,
      status: 'open',
    }),
  };
}

function resolvedDoc(thesisId: string, hypothesisId: string, outcome: string): ThesisLedgerDoc {
  return {
    path: `/portfolio/theses/resolved/${thesisId}.json`,
    content: JSON.stringify({
      thesisId,
      hypothesisId,
      regimeName: CAMPAIGN.regimeName,
      openedTradingDay: '2026-07-09',
      outcome,
    }),
  };
}

function orderResult(overrides: Record<string, unknown>) {
  return {
    clientOrderId: '2026-07-14-pre_market-aapl-1-open',
    thesisId: 'aapl-1',
    approvedId: 'aapl-breakout-1',
    intent: 'open',
    symbol: 'AAPL',
    side: 'buy',
    qty: null,
    notional: '5000.00',
    entryCondition: 'Trades above 187.40 after the open.',
    disposition: 'deferred',
    statusCode: null,
    orderId: null,
    orderStatus: null,
    fillState: null,
    filledAvgPrice: null,
    shortSizing: null,
    failureSource: null,
    error: null,
    ...overrides,
  };
}

/**
 * The schema a task's output is validated against at delegation: its static
 * schema with every derivedFrom binding evaluated against the named sources.
 */
function effectiveOutputSchema(
  t: CatalogTask,
  sources: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const patches = (t.outputContract?.derivedFrom ?? []).map((b) => {
    const m = /^(enum|value|count):(.+)$/.exec(b.binding);
    const source = sources[b.from] ?? DEFAULT_SOURCES[b.from];
    if (!m || !source) throw new Error(`no test source for binding ${b.bindingId}`);
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

function refuses(schema: Record<string, unknown>, output: unknown): boolean {
  return !ajv.compile(schema)(output);
}

/** The whole output contract: the effective schema, then every validatorRef. */
function contractRefuses(
  t: CatalogTask,
  sources: Record<string, Record<string, unknown>>,
  output: unknown,
): boolean {
  if (refuses(effectiveOutputSchema(t, sources), output)) return true;
  return (t.outputContract?.validatorRefs ?? []).some((ref) => {
    const validator = getValidator(ref);
    if (!validator) throw new Error(`validatorRef ${ref} is not registered`);
    return !validator.safeParse(output).success;
  });
}

describe('DAILY_TRADING_CYCLE', () => {
  const entry = getSkillCatalogEntry(CYCLE_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${CYCLE_SLUG}" not found`);
  }
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after Phase D materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const errors = validateWorkflowGraph(tasks, wf.stateVariables, wf.output);
    expect(errors).toEqual([]);
  });

  it('has the expected task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'ingest-clock',
        'derive-trading-day',
        'ingest-account',
        'ingest-account-config',
        'ingest-positions',
        'ingest-orders',
        'resolve-theses',
        'ingest-calendar',
        'read-index-bars',
        'read-universe-bars',
        'gather-regime',
        'regime-state',
        'read-pre-market',
        'check-set',
        'set-state',
        'run-desk',
        'read-set',
        'tally-set',
        'decide',
        'decision-state',
        'execute-orders',
        'record',
        'write-snapshot',
        'write-cycle-doc',
        'record-learnings',
        'read-close-cycle-doc',
        'read-close-snapshot',
        'read-recorded-reflection',
        'read-day-resolutions',
        'reflect',
        'record-reflection',
        'read-reflection',
        'write-close-report',
      ]),
    );
  });

  it('ledger persistence is structural: op tasks write the snapshot then the cycle doc, from pattern-validated paths', () => {
    const snap = task('write-snapshot');
    const cyc = task('write-cycle-doc');
    expect(snap?.type).toBe('operation');
    expect(snap?.operation).toBe('memory.store.put');
    expect(cyc?.type).toBe('operation');
    expect(cyc?.operation).toBe('memory.store.put');
    // The cycle doc is the completion marker — written last, after all persistence.
    expect(cyc?.dependsOn?.slice().sort()).toEqual(['record-learnings', 'write-snapshot']);
    expect(snap?.dependsOn).toEqual(['record']);
    const schema = task('record')?.outputContract?.schema as {
      required: string[];
      properties: Record<string, { pattern?: string; items?: { pattern?: string } }>;
    };
    for (const f of [
      'cycleDoc',
      'snapshotDoc',
      'cycleDocPath',
      'snapshotDocPath',
      'resolvedDocPaths',
      'openedDocPaths',
      'deletedOpenDocPaths',
    ]) {
      expect(schema.required, f).toContain(f);
    }
    expect(schema.properties.cycleDocPath.pattern).toContain('^/portfolio/theses/cycles/');
    expect(schema.properties.snapshotDocPath.pattern).toContain('^/portfolio/snapshots/');
    expect(schema.properties.resolvedDocPaths.items?.pattern).toContain(
      '^/portfolio/theses/resolved/',
    );
    expect(schema.properties.openedDocPaths.items?.pattern).toContain('^/portfolio/theses/open/');
    // Record produces content; the op tasks persist it — the goal says so.
    const goal = task('record')?.goal ?? '';
    expect(goal).toContain('you do not write it to memory yourself');
    // The marker is last across ALL persistence, learnings included.
    expect(task('write-cycle-doc')?.dependsOn?.sort()).toEqual([
      'record-learnings',
      'write-snapshot',
    ]);
    // Content pins: identity, counts, and account scalars are injected from
    // their upstream validated producers — an echoed value that disagrees
    // cannot validate; empty write receipts cannot cover skipped writes.
    const derived = task('record')?.outputContract?.derivedFrom ?? [];
    const byTarget = Object.fromEntries(derived.map((b) => [b.target, `${b.from}:${b.binding}`]));
    expect(byTarget).toMatchObject({
      '$.cycleDoc.tradingDay.const': 'resolve-theses:value:$.tradingDay',
      '$.cycleDoc.slot.const': 'resolve-theses:value:$.slot',
      '$.cycleDoc.submittedCount.const': 'execute-orders:value:$.submittedCount',
      '$.cycleDoc.deferredCount.const': 'execute-orders:value:$.deferredCount',
      '$.cycleDoc.failedCount.const': 'execute-orders:value:$.failedCount',
      '$.snapshotDoc.equity.const': 'ingest-account:value:$.equity',
      '$.snapshotDoc.cash.const': 'ingest-account:value:$.cash',
      '$.resolvedDocPaths.minItems': 'resolve-theses:count:$.resolutions',
      '$.openedDocPaths.minItems': 'decide:count:$.theses',
    });
  });

  it('resolve reports repairCloses and execute consumes them (unclosed resolutions never strand)', () => {
    const schema = task('resolve-theses')?.outputContract?.schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain('repairCloses');
    for (const consumer of ['execute-orders', 'decide']) {
      for (const field of ['repairCloses', 'orphanFlattens']) {
        expect(task(consumer)?.inputBindings?.[field], `${consumer}.${field}`).toEqual({
          kind: 'task_output',
          taskId: 'resolve-theses',
          path: field,
        });
      }
    }
    // The account is single-owner: every orphan is reconciled with provenance
    // evidence and flattened first — no operator carve-out.
    const resolveSchema = task('resolve-theses')?.outputContract?.schema as {
      required: string[];
      properties: Record<string, { items?: { required?: string[] } }>;
    };
    expect(resolveSchema.required).toContain('orphanFlattens');
    expect(resolveSchema.properties.orphanFlattens.items?.required).toContain('evidence');
    expect(task('execute-orders')?.goal ?? '').toContain('flatten each FIRST');
    expect(task('resolve-theses')?.goal ?? '').toContain('every orphan is the agent');
    const resolveGoal = task('resolve-theses')?.goal ?? '';
    expect(resolveGoal).toContain('UNCLOSED RESOLUTION');
    // Fill truth survives a duplicate record with no broker id.
    expect(resolveGoal).toContain('match the client order id');
    const executeGoal = task('execute-orders')?.goal ?? '';
    expect(executeGoal).toContain('list orders once');
  });

  it('the ingest chain is deterministic operation tasks (no agents before resolve)', () => {
    for (const id of [
      'ingest-clock',
      'ingest-account',
      'ingest-account-config',
      'ingest-positions',
      'ingest-orders',
    ]) {
      expect(task(id)?.type, id).toBe('operation');
      expect(task(id)?.operation, id).toBe('api.http.call');
      expect(task(id)?.retryability, id).toBe('safe');
    }
  });

  it('every post-resolve task gates on resolve-theses.proceed (duplicate-trigger no-op)', () => {
    for (const id of ['decide', 'execute-orders', 'record', 'record-learnings']) {
      expect(task(id)?.when?.expression, id).toBe(PROCEED_GATE);
    }
    expect(validateWhenExpression(PROCEED_GATE)).toBeNull();
    // resolve-theses declares `proceed` (required) so the gate reads a real field.
    const schema = task('resolve-theses')?.outputContract?.schema as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(schema.properties['proceed']?.type).toBe('boolean');
    expect(schema.required).toContain('proceed');
  });

  it('the decide contract binds what the strategy defines, and no cap', () => {
    const derived = task('decide')?.outputContract?.derivedFrom ?? [];
    expect(
      derived
        .filter((b) => b.from !== '$campaign')
        .map((b) => `${b.from}:${b.binding}>${b.target}`),
    ).toEqual([
      'resolve-theses:value:$.tradingDay>$.tradingDay.const',
      'regime-state:value:$.decision>$.marketState.const',
    ]);
    const byTarget = Object.fromEntries(
      derived.filter((b) => b.from === '$campaign').map((b) => [b.target, b.binding]),
    );
    expect(byTarget).toEqual({
      '$.regimeName.const': 'value:$.regimeName',
      '$.theses.items.deadlineTradingDays.minimum': 'value:$.minHorizonTradingDays',
      '$.theses.items.deadlineTradingDays.maximum': 'value:$.maxHorizonTradingDays',
    });
  });
  it('a sample campaign config merges into a decide schema with no size, count or exposure cap', () => {
    const effectiveSchema = effectiveOutputSchema(task('decide')!, {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
    });
    const theses = (effectiveSchema as any).properties.theses;
    expect(theses.maxItems).toBeUndefined();
    expect(theses.items.properties.sizePct.maximum).toBeUndefined();
    expect(theses.items.properties.deadlineTradingDays.minimum).toBe(1);
    expect(theses.items.properties.deadlineTradingDays.maximum).toBe(5);
    expect((effectiveSchema as any).properties.projectedGrossExposurePct.maximum).toBeUndefined();
  });
  it('the thesis shape is fully specified and required (pre-registration is structural)', () => {
    const schema = task('decide')?.outputContract?.schema as {
      properties: { theses: { items: { required: string[] } } };
    };
    expect(schema.properties.theses.items.required.sort()).toEqual(
      [
        'approvedId',
        'confidence',
        'confirmationCriterion',
        'entryLevel',
        'invalidationLevel',
        'deadlineTradingDays',
        'direction',
        'entryCondition',
        'falsificationCriterion',
        'hypothesisId',
        'instrument',
        'rationale',
        'sizePct',
        'thesisId',
      ].sort(),
    );
  });

  it('order authority is isolated to execute-orders: submit + cancel, nothing else', () => {
    for (const t of wf.tasks) {
      const grants = t.context?.capabilities?.integrations ?? [];
      const hasWrite = grants.some((g) => g.integrationId === 'alpaca-paper-orders-write');
      expect(hasWrite, t.taskId).toBe(t.taskId === 'execute-orders');
    }
    const grants = task('execute-orders')?.context?.capabilities?.integrations ?? [];
    const write = grants.find((g) => g.integrationId === 'alpaca-paper-orders-write');
    expect(write?.toolNames?.map((t) => t.toolName).sort()).toEqual([
      'delete_orders_order_id',
      'post_orders',
    ]);
    expect(write?.allTools).toBe(false);
    // The only other grants: read-side fill verification + the snapshot
    // pricing whole-share short sizing at submission time.
    const rest = grants.filter((g) => g !== write);
    expect(rest.map((g) => g.integrationId).sort()).toEqual([
      'alpaca-account-read',
      'alpaca-market-data',
    ]);
    const read = rest.find((g) => g.integrationId === 'alpaca-account-read');
    expect(read?.toolNames?.map((t) => t.toolName)).toEqual(['get_orders_order_id', 'get_orders']);
    expect(read?.allTools).toBe(false);
    const md = rest.find((g) => g.integrationId === 'alpaca-market-data');
    expect(md?.toolNames?.map((t) => t.toolName)).toEqual(['get_v2_stocks_snapshots']);
    expect(md?.allTools).toBe(false);
  });

  it('short entries size by the account’s fractional capability, read from the account', () => {
    const config = task(ACCOUNT_CONFIG_TASK_ID);
    expect(config?.outputProjection?.['fractionalTrading']).toEqual({
      path: 'data.fractional_trading',
      onMissing: 'null',
    });
    for (const id of ['execute-orders', 'decide']) {
      expect(task(id)?.inputBindings?.['fractionalTrading'], id).toEqual({
        kind: 'task_output',
        taskId: ACCOUNT_CONFIG_TASK_ID,
        path: 'fractionalTrading',
      });
    }
    const executeGoal = task('execute-orders')?.goal ?? '';
    // A short whole shares can express keeps its whole-share qty on a fractional account.
    expect(executeGoal).toContain(
      '`whole_share`: qty = floor(targetNotional / price) where that is ≥ 1, even where `fractionalTrading` is true: $5000 at 639.09 sends "7".',
    );
    expect(executeGoal).toContain(
      '`fractional`: only where the floor is 0 and `fractionalTrading` is true',
    );
    expect(executeGoal).toContain('$639 at 639.09 sends "0.999859174"');
    // Fractional short support is unverified, so the fractional qty is a last resort.
    expect(executeGoal).toContain(
      'Fractional short sales are unverified on this broker, so it is a last resort.',
    );
    expect(executeGoal).toContain(
      '`whole_share_capability_unknown`: whole shares where `fractionalTrading` is null',
    );
    expect(executeGoal).toContain('Never assume fractional.');
    // An unsent order is never reported as the broker's refusal.
    expect(executeGoal).toContain('An unsent order is never a broker rejection.');
    expect(executeGoal).not.toContain('the broker rejects fractional');
    // A deferred short intention re-derives qty from a FRESH price at submission.
    expect(executeGoal).toContain('never the stored notional itself');
    // Closes submit the held quantity verbatim — the sizing rule is a short-ENTRY rule only.
    expect(executeGoal).toContain('held quantity verbatim');
    // decide sizes as a percent of equity, and execution sizes the order from the account.
    const decideGoal = task('decide')?.goal ?? '';
    expect(decideGoal).toContain('Execution sizes each entry from your sizePct and these facts.');
    expect(executeGoal).toContain('A LONG entry sizes by notional = sizePct / 100 × equity');
    const recordGoal = task('record')?.goal ?? '';
    expect(recordGoal).toContain("records that the account's fractional capability was unknown");
  });

  it('resolve-theses can read per-order fill truth (expired orders never appear in the open-orders input)', () => {
    const grants = task('resolve-theses')?.context?.capabilities?.integrations ?? [];
    const read = grants.find((g) => g.integrationId === 'alpaca-account-read');
    expect(read?.toolNames?.map((t) => t.toolName)).toEqual(['get_orders_order_id', 'get_orders']);
    expect(read?.allTools).toBe(false);
  });

  it('campaign-1 evidence staging: market-data grants carry price tools only, no news', () => {
    for (const id of ['resolve-theses', 'decide']) {
      const grants = task(id)?.context?.capabilities?.integrations ?? [];
      const md = grants.find((g) => g.integrationId === 'alpaca-market-data');
      expect(md?.toolNames?.map((t) => t.toolName).sort(), id).toEqual([
        'get_v2_stocks_snapshots',
        'get_v2_stocks_symbol_bars',
      ]);
      expect(md?.allTools, id).toBe(false);
    }
  });

  it('daily bars are cached locally: both price-reading tasks read cache-first, resolution writes it', () => {
    for (const id of ['resolve-theses', 'decide']) {
      const goal = task(id)?.goal ?? '';
      expect(goal, id).toContain('/portfolio/market-data/{symbol}.json');
      expect(goal.toLowerCase(), id).toContain('cache-first');
    }
    expect(task('resolve-theses')?.context?.capabilities?.operations).toContain('memory.store.put');
    // An open-market fetch returns the day's still-forming bar; caching it
    // would freeze a partial OHLC as that session's permanent truth.
    expect(task('resolve-theses')?.goal).toContain('Only COMPLETED sessions enter the cache');
    // decide holds no memory write: a put carries no path scope and could
    // replace the approved set it is gated on.
    expect(task('decide')?.context?.capabilities?.operations).toEqual([
      'memory.store.get',
      'memory.store.query',
    ]);
    expect(task('decide')?.goal).toContain('never write it');
    // The ledger contract says who keeps the cache, and where decide's other bars come from.
    const ledger = getSkillBundleEntry('alpaca-thesis-trading')!.memorySeed[0]!.content;
    const cache = ledger.slice(
      ledger.indexOf('## Market-data cache'),
      ledger.indexOf('## How the'),
    );
    expect(cache).toContain('The resolve step keeps it');
    expect(cache).toContain('The decide step reads it and never writes it');
    expect(cache).toContain('fetches fresh from the market-data feed on each cycle');
    expect(cache).not.toContain('every cycle reads this doc');
    // The founding gap: price history mined from thesis prose instead of data.
    expect(task('resolve-theses')?.goal ?? '').toContain(
      'never mine price history from thesis rationales',
    );
  });

  it('every order result requires a thesisId (thesis discipline)', () => {
    const schema = task('execute-orders')?.outputContract?.schema as {
      properties: { orderResults: { items: { required: string[] } } };
    };
    expect(schema.properties.orderResults.items.required).toContain('thesisId');
  });

  it('fill truth first: entry_failed is a resolution category, criteria outcomes are for filled entries only', () => {
    const schema = task('resolve-theses')?.outputContract?.schema as {
      properties: {
        resolutions: {
          items: {
            required: string[];
            properties: { outcome: { enum: string[] }; entryFillState: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.properties.resolutions.items.properties.outcome.enum).toEqual([
      'confirmed',
      'falsified',
      'expired',
      'entry_failed',
      'tactical_exit',
    ]);
    // Every resolution must assert its entry's fill truth explicitly — the
    // cross-checkable link between outcome and broker data.
    expect(schema.properties.resolutions.items.required).toContain('entryFillState');
    expect(schema.properties.resolutions.items.properties.entryFillState.enum).toEqual([
      'filled',
      'partial',
      'none',
    ]);
    const goal = task('resolve-theses')?.goal ?? '';
    expect(goal).toContain('FILL TRUTH FIRST');
    expect(goal).toContain('entry_failed');
    expect(goal).toContain('NO P&L');
    expect(goal).toContain('entryFillState');
  });

  it('single-owner account: every orphan is reconciled, none left for an operator', () => {
    const schema = task('resolve-theses')?.outputContract?.schema as {
      required: string[];
      properties: { orphanFlattens: { items: { required: string[] } } };
    };
    // orphanFlattens is the ONLY orphan concept — no untrackedPositions bucket.
    expect(schema.required).toContain('orphanFlattens');
    expect(schema.required).not.toContain('untrackedPositions');
    expect(schema.properties.orphanFlattens.items.required).toEqual([
      'symbol',
      'qty',
      'side',
      'evidence',
    ]);
    for (const consumer of ['decide', 'record']) {
      expect(task(consumer)?.inputBindings?.['orphanFlattens'], consumer).toEqual({
        kind: 'task_output',
        taskId: 'resolve-theses',
        path: 'orphanFlattens',
      });
      expect(task(consumer)?.inputBindings?.['untrackedPositions'], consumer).toBeUndefined();
    }
    // A held position awaiting a deferred close is accounted for, not an orphan.
    expect(task('resolve-theses')?.goal ?? '').toContain('pending close intentions');
    // The agent owns the whole account — no operator carve-out.
    expect(task('resolve-theses')?.goal ?? '').toContain("agent's alone to manage");
  });

  it('orphans are excluded from the thesis-attributed gross: both gross numbers are reported', () => {
    const schema = task('record')?.outputContract?.schema as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(schema.required).toContain('grossExposurePct');
    expect(schema.required).toContain('brokerGrossExposurePct');
    expect(schema.properties['grossExposurePct']?.description).toContain('Campaign-attributed');
    const goal = task('record')?.goal ?? '';
    expect(goal).toContain('brokerGrossExposurePct');
    expect(goal).toContain('being cleared, not held as strategy');
    const decideGoal = task('decide')?.goal ?? '';
    expect(decideGoal).toContain('exclude `orphanFlattens`');
  });

  it('deferred exposure is visible to decide: pending intentions feed the projection', () => {
    const schema = task('resolve-theses')?.outputContract?.schema as {
      required: string[];
      properties: { pendingIntentions: { items: { required: string[] } } };
    };
    expect(schema.required).toContain('pendingIntentions');
    expect(schema.properties.pendingIntentions.items.required).toEqual([
      'thesisId',
      'intent',
      'symbol',
      'qty',
      'notional',
    ]);
    expect(task('decide')?.inputBindings?.['pendingIntentions']).toEqual({
      kind: 'task_output',
      taskId: 'resolve-theses',
      path: 'pendingIntentions',
    });
    const decideGoal = task('decide')?.goal ?? '';
    expect(decideGoal).toContain('pending entry intentions');
  });

  it('submission is clock-gated: closed-market cycles defer orders as intentions', () => {
    expect(task('execute-orders')?.inputBindings?.['marketIsOpen']).toEqual({
      kind: 'task_output',
      taskId: 'ingest-clock',
      path: 'isOpen',
    });
    const goal = task('execute-orders')?.goal ?? '';
    expect(goal).toContain('ONLY when `marketIsOpen` is true');
    expect(goal).toContain('/portfolio/intentions/');
    expect(goal).toContain('FIRST settle pending intentions');
    expect(goal).toContain('thesis deadline has passed is expired');
    const schema = task('execute-orders')?.outputContract?.schema as {
      required: string[];
      properties: { orderResults: { items: { properties: { disposition: { enum: string[] } } } } };
    };
    expect(schema.properties.orderResults.items.properties.disposition.enum).toEqual([
      'submitted',
      'duplicate',
      'deferred',
      'expired',
      'failed',
    ]);
    expect(schema.required).toContain('deferredCount');
  });

  it('a crash re-run cannot double-place or ghost-submit: duplicate disposition + thesis-doc gate', () => {
    const goal = task('execute-orders')?.goal ?? '';
    // A duplicate-id rejection is its own disposition — neither submitted nor failed.
    expect(goal).toContain('disposition: "duplicate"');
    expect(goal).toContain('count it in neither submittedCount nor failedCount');
    // An entry intention with no registered thesis behind it is dropped, never submitted.
    expect(goal).toContain('submittable only when its thesis doc exists');
    expect(goal).toContain('No order without a registered thesis applies to intentions too');
  });

  it('deferred closes keep their lifecycle: the settled close lands on the resolved doc', () => {
    const goal = task('record')?.goal ?? '';
    expect(goal).toContain('a settled CLOSE belongs to a thesis already resolved');
    expect(goal).toContain('/portfolio/theses/resolved/{thesisId}.json');
  });

  it('every order result is statusCode-gated and fill-verified same-cycle', () => {
    const items = (
      task('execute-orders')?.outputContract?.schema as {
        properties: {
          orderResults: {
            items: { required: string[]; properties: { fillState: { enum: unknown[] } } };
          };
        };
      }
    ).properties.orderResults.items;
    expect(items.required).toContain('statusCode');
    expect(items.required).toContain('fillState');
    expect(items.properties.fillState.enum).toEqual(['filled', 'partial', 'pending', null]);
    const goal = task('execute-orders')?.goal ?? '';
    expect(goal).toContain('statusCode');
    expect(goal).toContain('4xx/5xx');
    expect(goal).toContain('never silently count a rejection as success');
    expect(goal).toContain('Fill verification');
  });

  it('cancel authority exists for exactly the wash-trade remediation', () => {
    const goal = task('execute-orders')?.goal ?? '';
    expect(goal).toContain('cancel it by broker order id, then resubmit the exit once');
    expect(goal).toContain('Cancel NOTHING else');
  });

  it('gross exposure is cross-checked against the broker, not just self-reported', () => {
    const schema = task('record')?.outputContract?.schema as { required: string[] };
    expect(schema.required).toContain('grossExposurePct');
    // No eval scores the gross against a cap: the campaign holds none.
    const criteria = entry.bundle.evalSuite?.taskCriteria['record'] ?? [];
    expect(criteria.map((c) => c.name)).not.toContain('gross-exposure-within-cap');
  });

  it('pins single-run concurrency — a duplicate trigger cannot race the ledger idempotency check', () => {
    expect(entry.bundle.manifest.concurrency?.maxConcurrentRuns).toBe(1);
  });

  it('loop health: record caps learnings at the resolution count via derivedFrom', () => {
    const derived = task('record')?.outputContract?.derivedFrom ?? [];
    expect(derived).toContainEqual({
      bindingId: 'learnings-per-resolution-cap',
      from: 'resolve-theses',
      binding: 'count:$.resolutions',
      target: '$.learnings.maxItems',
    });
  });

  it('Phase D derives record.learnings from workflow.learn', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const record = tasks.find((t) => t.taskId === 'record');
    const learnings = (record?.outputContract?.schema as { properties: { learnings: unknown } })
      .properties.learnings;
    const opLearnings = (
      toJsonSchemaSync(getOperation('workflow.learn')!.inputZod) as {
        properties: { learnings: unknown };
      }
    ).properties.learnings;
    expect(learnings).toEqual(opLearnings);
  });

  it('no agent task grants order ops directly or opTaskOnly tools', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
    for (const t of wf.tasks) {
      const ops = t.context?.capabilities?.operations ?? [];
      expect(ops, t.taskId).not.toContain('api.http.call');
      expect(ops, t.taskId).not.toContain('workflow.learn');
    }
  });

  it('the only run inputs are the optional slot, slotIndex and desk folder', () => {
    expect(wf.runInputs?.map((r) => [r.id, r.required])).toEqual([
      ['slot', false],
      ['slotIndex', false],
      ['bindingId', false],
    ]);
    const entryContract = task('ingest-clock')?.inputContract?.bindings ?? {};
    expect(Object.keys(entryContract).sort()).toEqual(['bindingId', 'slot', 'slotIndex']);
    const readers = wf.tasks.filter((t) =>
      Object.values(t.inputBindings ?? {}).some(
        (b) => (b as { kind: string }).kind === 'run_input',
      ),
    );
    expect(readers.map((t) => t.taskId)).toEqual(['resolve-theses', 'set-state', 'run-desk']);
    expect(task('resolve-theses')?.inputBindings).toMatchObject({
      requestedSlot: { kind: 'run_input', path: 'slot' },
      requestedSlotIndex: { kind: 'run_input', path: 'slotIndex' },
    });
  });

  it('an explicit slotIndex and a derived one count by the same rule, from 1 at the open', () => {
    const resolveSchema = task('resolve-theses')?.outputContract?.schema as {
      properties: { slotIndex: { description: string } };
    };
    expect(INTRADAY_INDEX_RULE).toContain('09:30–10:29 is 1');
    expect(wf.runInputs?.find((r) => r.id === 'slotIndex')?.description).toContain(
      INTRADAY_INDEX_RULE,
    );
    expect(task('resolve-theses')?.goal).toContain(INTRADAY_INDEX_RULE);
    expect(resolveSchema.properties.slotIndex.description).toContain(INTRADAY_INDEX_RULE);
  });

  it('declares the campaign contract with regimeName as identity and every field frozen', () => {
    const campaign = entry.bundle.manifest.campaign;
    expect(campaign).toBeDefined();
    expect(Object.keys(campaign!.fields).sort()).toEqual(
      [
        'calibrationRule',
        'expectancyFloorR',
        'hypotheses',
        'minHorizonTradingDays',
        'maxHorizonTradingDays',
        'pooledSampleFloor',
        'regimeName',
        'universe',
        'windowTradingDays',
      ].sort(),
    );
    expect(campaign!.fields['regimeName']!.identity).toBe(true);
    for (const [key, field] of Object.entries(campaign!.fields)) {
      if (key === 'regimeName') continue; // identity fields are implicitly immutable
      expect(field.mutable, key).toBe(false);
    }
  });

  it('has no human task: the agent decides and executes on paper', () => {
    expect(wf.tasks.every((t) => t.type !== 'human')).toBe(true);
  });

  it('resolve-theses prose carries the self-healing coverage contract', () => {
    const goal = task('resolve-theses')?.goal ?? '';
    expect(goal).toContain('EVERY open thesis');
    expect(goal).toContain('missed slot');
    expect(goal.toLowerCase()).toContain('duplicate');
    // Idempotency key = the cycle doc for (tradingDay, slot).
    expect(goal).toContain('/portfolio/theses/cycles/{tradingDay}-{slotKey}.json');
  });

  it('one slot taxonomy runs through every task, the cycle doc and the ledger paths', () => {
    const slots = ['pre_market', 'open', 'intraday', 'after_close'];
    for (const id of ['resolve-theses', 'execute-orders']) {
      const schema = task(id)?.outputContract?.schema as {
        required: string[];
        properties: { slot: { enum: string[] } };
      };
      expect(schema.properties.slot.enum, id).toEqual(slots);
      expect(schema.required, id).toContain('slot');
    }
    const record = task('record')?.outputContract?.schema as {
      properties: {
        cycleDoc: { required: string[]; properties: { slot: { enum: string[] } } };
        cycleDocPath: { pattern: string };
        snapshotDocPath: { pattern: string };
      };
    };
    expect(record.properties.cycleDoc.properties.slot.enum).toEqual(slots);
    expect(record.properties.cycleDoc.required).toEqual(
      expect.arrayContaining(['slot', 'slotIndex']),
    );
    const cyclePath = new RegExp(record.properties.cycleDocPath.pattern);
    for (const key of ['pre_market', 'open', 'intraday-3', 'after_close']) {
      expect(cyclePath.test(`/portfolio/theses/cycles/2026-07-14-${key}.json`), key).toBe(true);
    }
    // An intraday cycle without its index would collide with the day's other firings.
    expect(cyclePath.test('/portfolio/theses/cycles/2026-07-14-intraday.json')).toBe(false);
    expect(cyclePath.test('/portfolio/theses/cycles/2026-07-14-morning.json')).toBe(false);
    expect(
      new RegExp(record.properties.snapshotDocPath.pattern).test(
        '/portfolio/snapshots/2026-07-14-intraday-3.json',
      ),
    ).toBe(true);
    const goal = task('resolve-theses')?.goal ?? '';
    // Coverage compares against the SCHEDULED slot set, not all conceivable slots.
    expect(goal).toContain('The expected grid is the SCHEDULED slots of each trading day');
  });

  it('record prose scopes learnings to resolutions and writes the cycle doc last', () => {
    const goal = task('record')?.goal ?? '';
    expect(goal).toContain('RESOLUTIONS ONLY');
    expect(goal).toContain('At most one learning per resolution');
    expect(goal.toLowerCase()).toContain('marks the cycle complete');
    // A non-fill carries no market evidence: process facts only, no calibration.
    expect(goal).toContain('teaches PROCESS facts only');
    expect(goal).toContain('no calibration point and no market learning may cite it');
  });

  it('task goals name no platform operation ids', () => {
    for (const t of wf.tasks) {
      if (t.type !== 'agent') continue;
      expect(t.goal, t.taskId).not.toContain('memory.store.');
      expect(t.goal, t.taskId).not.toContain('api.http.');
      expect(t.goal, t.taskId).not.toContain('workflow.learn');
    }
  });

  it('is a process-mode skill with an objective Layer-1 goal', () => {
    expect(wf.mode).toBe('process');
    expect(entry.bundle.manifest.mode).toBe('process');
    const goal = entry.bundle.manifest.goal;
    expect(goal.type).toBe('objective');
    const ids = (goal as { criteria: Array<{ id: string }> }).criteria.map((c) => c.id).sort();
    expect(ids).toEqual([
      'calibration',
      'cycle-reliability',
      'lens-predictiveness',
      'loop-health',
      'resolution-rate',
      'thesis-discipline',
    ]);
  });
});

describe('daily-trading-cycle per-slot contracts', () => {
  const wf = getSkillCatalogEntry(CYCLE_SLUG)!.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id)! as CatalogTask;
  const resolveRefuses = (output: unknown) =>
    contractRefuses(task('resolve-theses'), { $campaign: CAMPAIGN }, output);

  it('resolve-theses accepts a plain cycle for every slot', () => {
    for (const slot of ['pre_market', 'open', 'intraday', 'after_close'] as const) {
      expect(resolveRefuses(resolveOutput(slot)), slot).toBe(false);
    }
  });

  it('resolve-theses refuses a trading day other than the one the clock derives', () => {
    for (const slot of ['pre_market', 'after_close'] as const) {
      expect(resolveRefuses(resolveOutput(slot, { tradingDay: '2026-07-13' })), slot).toBe(true);
    }
    const derive = wf.tasks.find((t) => t.taskId === 'derive-trading-day')!;
    expect(derive.type).toBe('operation');
    expect(derive.operation).toBe('workflow.run.derive');
    expect(derive.dependsOn).toEqual(['ingest-clock']);
    const deriver = getRunDeriver(String((derive.inputTemplate as { deriver: string }).deriver));
    expect(deriver?.({ clock: { timestamp: '2026-07-14T16:23:00-04:00' } })).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
  });

  it('the clock, not the slot, decides whether an order is sent', () => {
    const schema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolveOutput('pre_market'),
    });
    const deferred = {
      slot: 'pre_market',
      fractionalTrading: null,
      orderResults: [orderResult({})],
      submittedCount: 0,
      deferredCount: 1,
      failedCount: 0,
    };
    expect(refuses(schema, deferred)).toBe(false);
    const submitted = {
      ...deferred,
      orderResults: [
        orderResult({
          disposition: 'submitted',
          statusCode: 200,
          orderId: 'b0b6dd9d',
          orderStatus: 'accepted',
          fillState: 'pending',
        }),
      ],
      submittedCount: 1,
      deferredCount: 0,
    };
    // No slot rule refuses a submission: the execute agent submits only while the market is open.
    expect(refuses(schema, submitted)).toBe(false);
    expect(task('execute-orders').goal).toContain('Submit orders ONLY when `marketIsOpen` is true');
  });

  it.each(['pre_market', 'open', 'intraday', 'after_close'] as const)(
    '%s: a cycle may decide entries, as many as the agent finds',
    (slot) => {
      const schema = effectiveOutputSchema(task('decide'), {
        $campaign: CAMPAIGN,
        'resolve-theses': resolveOutput(slot),
      });
      const many = ['aapl-2', 'aapl-3', 'aapl-4', 'aapl-5'].map((id) => thesis(id, null));
      expect(refuses(schema, decision([]))).toBe(false);
      expect(refuses(schema, decision(many))).toBe(false);
    },
  );
});

describe('daily-trading-cycle hypothesis arms', () => {
  const entry = getSkillCatalogEntry(CYCLE_SLUG)!;
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id)! as CatalogTask;
  const contract = entry.bundle.manifest.campaign!;

  it('the boundary-rule fields are required on the campaign contract', () => {
    expect(validateCampaignConfig(contract, CAMPAIGN).ok).toBe(true);
    for (const field of ['pooledSampleFloor', 'expectancyFloorR', 'calibrationRule'] as const) {
      const { [field]: _omitted, ...rest } = CAMPAIGN;
      const result = validateCampaignConfig(contract, rest);
      expect(result.ok, field).toBe(false);
      if (!result.ok) {
        expect(result.issues, field).toContainEqual(
          expect.objectContaining({ field, code: 'MISSING_FIELD' }),
        );
      }
      expect(contract.fields[field]?.mutable, field).toBe(false);
    }
  });

  it('the cycle doc cites only campaign arms for its resolved theses', () => {
    const schema = effectiveOutputSchema(task('record'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
      decide: { theses: [], approvedSetFault: null },
      'execute-orders': { submittedCount: 0, deferredCount: 0, failedCount: 0 },
      'ingest-account': { equity: 100000, cash: 60000 },
    });
    const cycleDoc = (schema['properties'] as Record<string, Record<string, unknown>>)['cycleDoc']!;
    const resolvedItem = (
      (cycleDoc['properties'] as Record<string, Record<string, unknown>>)['thesesResolved']![
        'items'
      ] as { properties: Record<string, { enum?: unknown }> }
    ).properties;
    expect(resolvedItem['hypothesisId']?.enum).toEqual(['breakout', 'gap-fade']);
  });

  describe('the per-arm table', () => {
    const ledger: ThesisLedgerDoc[] = [
      openDoc('aapl-1', 'breakout', '2026-07-10'),
      resolvedDoc('aapl-0', 'breakout', 'confirmed'),
      resolvedDoc('msft-0', 'breakout', 'falsified'),
      resolvedDoc('spy-0', 'breakout', 'tactical_exit'),
      resolvedDoc('msft-1', 'gap-fade', 'entry_failed'),
      // A record step that crashed between its writes left the open doc behind.
      openDoc('spy-1', 'gap-fade', '2026-07-12'),
      resolvedDoc('spy-1', 'gap-fade', 'falsified'),
      // Another campaign's thesis is not this campaign's.
      openDoc('aapl-9', 'breakout', '2026-07-12', 'momentum-0'),
    ];
    const bareDoc: ThesisLedgerDoc = {
      path: '/portfolio/theses/open/bare.json',
      content: JSON.stringify({ thesisId: 'bare', regimeName: CAMPAIGN.regimeName }),
    };
    const expected = [
      {
        hypothesisId: 'breakout',
        opened: 4,
        open: 1,
        resolved: { confirmed: 1, falsified: 1, tactical_exit: 1, expired: 0, entry_failed: 0 },
      },
      {
        hypothesisId: 'gap-fade',
        opened: 2,
        open: 0,
        resolved: { confirmed: 0, falsified: 1, tactical_exit: 0, expired: 0, entry_failed: 1 },
      },
    ];
    const table = { regimeName: CAMPAIGN.regimeName, arms: expected };

    it('is computed from a seeded ledger', () => {
      expect(
        computeArmTable(readLedgerTheses(ledger).theses, {
          regimeName: CAMPAIGN.regimeName,
          hypothesisIds: ['breakout', 'gap-fade'],
        }),
      ).toEqual(expected);
    });

    it('a doc that names its campaign but no hypothesisId is refused on every slot, never skipped', () => {
      const output = (armTable: unknown) => ({ armTable, snapshotDoc: { armTable } });
      expect(readLedgerTheses([...ledger, bareDoc]).refused).toEqual([
        { path: bareDoc.path, reason: 'it has no hypothesisId', origin: 'earlier' },
      ]);
      // The arm of a doc this cycle did not open is unknown to the agent, so
      // no remedy asks it to write one.
      for (const armTable of [table, null]) {
        expect(armTableIssues(output(armTable), [...ledger, bareDoc])).toEqual([
          expect.objectContaining({
            message: expect.stringMatching(
              new RegExp(`${bareDoc.path}.*the operator corrects or removes the doc`),
            ) as string,
          }),
        ]);
      }
    });

    it('the record contract refuses a table the ledger does not give', () => {
      const output = (armTable: unknown, snapshotTable: unknown = armTable) => ({
        armTable,
        snapshotDoc: { armTable: snapshotTable },
      });
      expect(armTableIssues(output(table), ledger)).toEqual([]);
      const reported = {
        ...table,
        arms: [expected[0], { ...expected[1]!, open: 1, opened: 3 }],
      };
      expect(armTableIssues(output(reported), ledger)).toEqual([
        expect.objectContaining({ path: ['armTable', 'arms', 1] }),
      ]);
      expect(armTableIssues(output(table, null), ledger)).toEqual([
        expect.objectContaining({ path: ['snapshotDoc', 'armTable'] }),
      ]);
      expect(armTableIssues(output(null), ledger)).toEqual([]);
    });

    const schemaFor = (
      slot: CycleSlot,
      cycle: { theses?: unknown[]; resolutions?: unknown[] } = {},
    ) =>
      effectiveOutputSchema(task('record'), {
        $campaign: CAMPAIGN,
        'resolve-theses': resolveOutput(slot, { resolutions: cycle.resolutions ?? [] }),
        decide: { theses: cycle.theses ?? [], approvedSetFault: null },
        'execute-orders': { submittedCount: 0, deferredCount: 0, failedCount: 0 },
        'ingest-account': { equity: 100000, cash: 60000 },
      });
    const recordOutput = (
      slot: CycleSlot,
      armTable: unknown,
      writes: {
        opened?: string[];
        resolved?: Array<{ thesisId: string; hypothesisId?: string; outcome: string }>;
      } = {},
    ) => {
      const opened = writes.opened ?? [];
      const resolved = writes.resolved ?? [];
      return {
        runSummary: 'Recorded the cycle.',
        approvedSetFaults: 0,
        cycleCompleted: 1,
        thesesOpened: opened.length,
        thesesResolved: resolved.length,
        grossExposurePct: 0,
        brokerGrossExposurePct: 0,
        cycleDoc: {
          tradingDay: '2026-07-14',
          slot,
          slotIndex: slot === 'intraday' ? 3 : null,
          coverageNote: 'No slot missed since the last cycle.',
          thesesOpened: opened,
          openedApprovals: opened.map((thesisId) => ({ thesisId, approvedId: 'aapl-breakout-1' })),
          approvedSetFault: null,
          thesesResolved: resolved.map((r) => ({ entryFillPrice: null, realizedR: null, ...r })),
          submittedCount: 0,
          deferredCount: 0,
          failedCount: 0,
          projectedGrossExposurePct: 0,
          decisionRationale: 'No setup.',
        },
        snapshotDoc: {
          equity: 100000,
          cash: 60000,
          positions: [],
          brokerGrossExposurePct: 0,
          grossExposurePct: 0,
          orphanFlattens: [],
          benchmarkClose: null,
          armTable,
        },
        cycleDocPath: `/portfolio/theses/cycles/2026-07-14-${slot}.json`,
        snapshotDocPath: `/portfolio/snapshots/2026-07-14-${slot}.json`,
        resolvedDocPaths: resolved.map((r) => `/portfolio/theses/resolved/${r.thesisId}.json`),
        openedDocPaths: opened.map((id) => `/portfolio/theses/open/${id}.json`),
        deletedOpenDocPaths: resolved.map((r) => `/portfolio/theses/open/${r.thesisId}.json`),
        armTable,
        learnings: [],
      };
    };

    describe('the campaign start migration', () => {
      // Docs the skill wrote before hypothesis arms: no regimeName, no hypothesisId.
      const legacyOpen: ThesisLedgerDoc = {
        path: '/portfolio/theses/open/legacy-1.json',
        content: JSON.stringify({ thesisId: 'legacy-1', openedTradingDay: '2026-07-08' }),
      };
      const legacyResolved: ThesisLedgerDoc = {
        path: '/portfolio/theses/resolved/legacy-0.json',
        content: JSON.stringify({ thesisId: 'legacy-0', openedTradingDay: '2026-07-07' }),
      };
      // Docs of the campaign before, under an arm id this campaign lacks.
      const priorOpen = openDoc('aapl-9', 'mean-reversion', '2026-07-10', 'momentum-0');
      const priorResolved: ThesisLedgerDoc = {
        path: '/portfolio/theses/resolved/msft-9.json',
        content: JSON.stringify({
          thesisId: 'msft-9',
          hypothesisId: 'mean-reversion',
          regimeName: 'momentum-0',
          openedTradingDay: '2026-07-09',
          outcome: 'falsified',
        }),
      };
      const priorCycle: ThesisLedgerDoc = {
        path: '/portfolio/theses/cycles/2026-07-10-after_close.json',
        content: '{}',
      };
      const earlier = [legacyOpen, legacyResolved, priorOpen, priorResolved];
      const startedAt = new Date('2026-07-13T21:05:09.123Z');
      const folder = `/portfolio/archive/theses/20260713T210509Z-${CAMPAIGN.regimeName}/`;
      const isLive = (path: string) =>
        path.startsWith('/portfolio/theses/open/') ||
        path.startsWith('/portfolio/theses/resolved/');

      /** A space's memory docs, moved the way the database store moves them. */
      function spaceStore(docs: readonly ThesisLedgerDoc[], holders: ThesisLedgerHolder[] = []) {
        const space = new Map(docs.map((doc) => [doc.path, doc.content]));
        const store: ThesisLedgerArchiveStore = {
          ledgerHolders: () => Promise.resolve(holders),
          moveLiveDocs: (plan) => {
            const moves = plan([...space.keys()].filter(isLive));
            for (const move of moves) {
              space.set(move.toPath, space.get(move.fromPath) ?? null);
              space.delete(move.fromPath);
            }
            return Promise.resolve(moves);
          },
        };
        const docsNow = (): ThesisLedgerDoc[] =>
          [...space].map(([path, content]) => ({ path, content }));
        return { store, docsNow };
      }
      const migrate = (store: ThesisLedgerArchiveStore) =>
        archiveThesisLedger(store, { regimeName: CAMPAIGN.regimeName, startedAt });

      it('moves the legacy and earlier-campaign docs in one pass and reports each move', async () => {
        const { store, docsNow } = spaceStore([...earlier, priorCycle]);
        expect(await migrate(store)).toEqual({
          ok: true,
          moved: [
            { fromPath: priorOpen.path, toPath: `${folder}open/aapl-9.json` },
            { fromPath: legacyOpen.path, toPath: `${folder}open/legacy-1.json` },
            { fromPath: legacyResolved.path, toPath: `${folder}resolved/legacy-0.json` },
            { fromPath: priorResolved.path, toPath: `${folder}resolved/msft-9.json` },
          ],
        });
        const after = new Map(docsNow().map((doc) => [doc.path, doc.content]));
        expect([...after.keys()].filter(isLive)).toEqual([]);
        for (const doc of earlier) {
          const name = doc.path.replace('/portfolio/theses/', '');
          expect(after.get(`${folder}${name}`), doc.path).toBe(doc.content);
        }
        expect(after.get(priorCycle.path)).toBe(priorCycle.content);
        expect(await migrate(store)).toEqual({ ok: true, moved: [] });
      });

      it('refuses while another campaign keeps its theses in the ledger, and moves nothing', async () => {
        const holder = { campaignId: 'c-1', workflowSlug: CYCLE_SLUG, regimeName: 'momentum-0' };
        const { store, docsNow } = spaceStore(earlier, [holder]);
        const result = await migrate(store);
        expect(result).toMatchObject({ ok: false });
        if (result.ok) throw new Error('expected a refusal');
        expect(result.message).toContain('End that campaign with workflow.campaign.end');
        expect(docsNow()).toEqual(earlier);
      });

      it('without the migration the runtime refuses a legacy doc, with a remedy its reader can carry out', () => {
        const docs = [...ledger, legacyOpen, legacyResolved];
        const recordIssues = armTableIssues(recordOutput('open', null), docs);
        expect(recordIssues.map((issue) => issue.message)).toEqual([
          expect.stringMatching(
            new RegExp(`^The thesis ledger doc ${legacyOpen.path}.*Stop and report its path\\.$`),
          ),
          expect.stringMatching(
            new RegExp(
              `^The thesis ledger doc ${legacyResolved.path}.*Stop and report its path\\.$`,
            ),
          ),
        ]);
      });

      it('runs the upgrade cycle end to end, record and decide passing, with the archive in the space', async () => {
        const { store, docsNow } = spaceStore([...earlier, priorCycle]);
        await migrate(store);
        const space = docsNow();

        const afterOpen = [...space, openDoc('aapl-2', 'breakout', '2026-07-14')];
        const openRecord = recordOutput('open', null, { opened: ['aapl-2'] });
        expect(refuses(schemaFor('open', { theses: [thesis('aapl-2', null)] }), openRecord)).toBe(
          false,
        );
        expect(armTableIssues(openRecord, afterOpen)).toEqual([]);

        const afterClose = [...space, resolvedDoc('aapl-2', 'breakout', 'falsified')];
        const noResolutions = { confirmed: 0, falsified: 0, tactical_exit: 0, expired: 0 };
        const closeTable = {
          regimeName: CAMPAIGN.regimeName,
          arms: [
            {
              hypothesisId: 'breakout',
              opened: 1,
              open: 0,
              resolved: { ...noResolutions, falsified: 1, entry_failed: 0 },
            },
            {
              hypothesisId: 'gap-fade',
              opened: 0,
              open: 0,
              resolved: { ...noResolutions, entry_failed: 0 },
            },
          ],
        };
        const closeRecord = recordOutput('after_close', closeTable, {
          resolved: [{ thesisId: 'aapl-2', hypothesisId: 'breakout', outcome: 'falsified' }],
        });
        const closeSchema = schemaFor('after_close', { resolutions: [{ thesisId: 'aapl-2' }] });
        expect(refuses(closeSchema, closeRecord)).toBe(false);
        expect(armTableIssues(closeRecord, afterClose)).toEqual([]);
      });

      it('refuses a resolved doc this cycle wrote without the arm fields, naming the rewrite', () => {
        const bareResolved: ThesisLedgerDoc = {
          path: '/portfolio/theses/resolved/aapl-1.json',
          content: JSON.stringify({
            thesisId: 'aapl-1',
            openedTradingDay: '2026-07-10',
            outcome: 'falsified',
          }),
        };
        const docs = [
          ...ledger.filter((doc) => doc.path !== '/portfolio/theses/open/aapl-1.json'),
          bareResolved,
        ];
        const resolved = [{ thesisId: 'aapl-1', hypothesisId: 'breakout', outcome: 'falsified' }];
        // The table the ledger would give with the bare doc left out.
        const [breakout, gapFade] = expected;
        const without = {
          ...table,
          arms: [{ ...breakout!, opened: 3, open: 0 }, gapFade],
        };
        for (const [slot, armTable] of [
          ['open', null],
          ['after_close', without],
        ] as const) {
          expect(armTableIssues(recordOutput(slot, armTable, { resolved }), docs), slot).toEqual([
            expect.objectContaining({
              message: expect.stringContaining(
                `${bareResolved.path} cannot be counted: it has no regimeName, hypothesisId`,
              ) as string,
            }),
          ]);
          expect(
            armTableIssues(recordOutput(slot, armTable, { resolved }), docs)[0]!.message,
          ).toContain('This cycle resolved it. Rewrite it as the full open doc of its thesis');
        }
      });

      it('refuses a doc this cycle opened without the arm fields, naming the rewrite', () => {
        const bare = {
          path: '/portfolio/theses/open/aapl-2.json',
          content: JSON.stringify({ thesisId: 'aapl-2', openedTradingDay: '2026-07-14' }),
        };
        const record = recordOutput('open', null, { opened: ['aapl-2'] });
        expect(armTableIssues(record, [...ledger, bare])).toEqual([
          expect.objectContaining({
            message: expect.stringContaining('This cycle opened it') as string,
          }),
        ]);
      });
    });

    it('is reported on after_close only, one row per campaign arm', () => {
      const afterClose = schemaFor('after_close');
      expect(refuses(afterClose, recordOutput('after_close', table))).toBe(false);
      expect(refuses(afterClose, recordOutput('after_close', null))).toBe(true);
      const oneArm = { ...table, arms: [expected[0]] };
      expect(refuses(afterClose, recordOutput('after_close', oneArm))).toBe(true);
      const otherCampaign = { ...table, regimeName: 'momentum-0' };
      expect(refuses(afterClose, recordOutput('after_close', otherCampaign))).toBe(true);
      const open = schemaFor('open');
      expect(refuses(open, recordOutput('open', null))).toBe(false);
      expect(refuses(open, recordOutput('open', table))).toBe(true);
    });
  });
});

describe('daily-trading-cycle approved set', () => {
  const wf = getSkillCatalogEntry(CYCLE_SLUG)!.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id)! as CatalogTask;
  const SET_PATH = '/research/2026-07-14/approved-theses.json';
  const DESK_RUN = 'run-desk-0714';

  function candidate(candidateId = 'aapl-breakout-1', overrides: Record<string, unknown> = {}) {
    return {
      candidateId,
      instrument: 'AAPL',
      direction: 'long',
      hypothesisId: 'breakout',
      entryLevel: 187.4,
      invalidationLevel: 184,
      confirmationLevel: 195,
      sizePct: 5,
      horizonTradingDays: 3,
      ...overrides,
    };
  }

  function setOf(
    candidates: unknown[],
    review: { lenses?: Record<string, unknown[]>; vetoes?: unknown[]; reviewRunId?: string } = {},
  ) {
    return {
      tradingDay: '2026-07-14',
      reviewRunId: review.reviewRunId ?? DESK_RUN,
      candidates,
      lenses: review.lenses ?? {},
      vetoes: review.vetoes ?? [],
    };
  }

  const rejectedBy = (lenses: string[], candidateId = 'aapl-breakout-1') =>
    Object.fromEntries(
      lenses.map((lens) => [
        lens,
        [{ candidateId, verdict: 'rejected', reason: `${lens} says no.` }],
      ]),
    );

  const SPACE = 'space-1';
  const OPERATOR: ApprovedSetWriter = { kind: 'operator', actor: 'api' };
  const runWriter = (
    workflowSlug: string,
    overrides: Partial<{ runId: string; status: string; spaceId: string }> = {},
  ): ApprovedSetWriter => ({
    kind: 'session',
    sessionId: 'session-9',
    stepExecutionId: 'step-write-set',
    drivenRuns: [],
    runs: [{ runId: DESK_RUN, workflowSlug, status: 'completed', spaceId: SPACE, ...overrides }],
  });
  const DESK_WRITER = runWriter('strategy-desk');
  const conversation = (drivenRuns: string[]): ApprovedSetWriter => ({
    kind: 'session',
    sessionId: 's-7',
    stepExecutionId: null,
    drivenRuns,
    runs: [],
  });

  function reader(
    content?: unknown,
    writer: ApprovedSetWriter = DESK_WRITER,
    ledger: OpeningLedgerDoc[] = [],
  ): ApprovedSetSource {
    const read = (path: string): Promise<ApprovedSetRead> => {
      if (path !== SET_PATH || content === undefined) return Promise.resolve({ status: 'missing' });
      return Promise.resolve({ status: 'found', content, writer });
    };
    return { spaceId: SPACE, read, readLedger: () => Promise.resolve(ledger) };
  }

  type Issues = Array<{ path: unknown[]; message: string }>;
  const paths = (issues: Issues) => issues.map((i) => i.path.join('.'));

  function decision(theses: unknown[], approvedSetFault: string | null = null) {
    return {
      tradingDay: '2026-07-14',
      regimeName: CAMPAIGN.regimeName,
      marketState: 'risk_on',
      bias: theses.length > 0 ? 'long' : null,
      approvedSetFault,
      theses,
      projectedGrossExposurePct: 5,
      decisionRationale: 'Breakout setup on AAPL.',
    };
  }

  it('decide names the approved-set rule as its one validator, and the runtime registers it', () => {
    expect(task('decide').outputContract?.validatorRefs).toEqual([APPROVED_THESES_VALIDATOR_REF]);
    expect(lookupValidator(APPROVED_THESES_VALIDATOR_REF)?.kind).toBe('runtime');
    expect(CYCLE_WORKFLOW_SLUG).toBe(wf.slug);
    expect(getRunDeriver(DESK_TALLY_DERIVER)).toBeDefined();
    expect(task('resolve-theses').outputContract?.validatorRefs ?? []).toEqual([]);
  });

  it('accepts a thesis of an approved candidate, with its own size, levels and deadline', async () => {
    const own = {
      ...thesis('aapl-2', null),
      sizePct: 9,
      entryLevel: 188.1,
      invalidationLevel: 180,
      deadlineTradingDays: 5,
    };
    expect(await approvedThesesIssues(decision([own]), reader(setOf([candidate()])))).toEqual([]);
  });

  it('holds one set for the whole day, so any slot reads the same candidates', async () => {
    const set = setOf([candidate()]);
    expect(Object.keys(set)).not.toContain('slots');
    for (const slot of ['pre_market', 'open', 'intraday', 'after_close'] as const) {
      expect(resolveOutput(slot).tradingDay).toBe('2026-07-14');
      expect(await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(set))).toEqual(
        [],
      );
    }
  });

  it('a lens that says nothing approves, and a minority of rejections stops nothing', async () => {
    const silent = setOf([candidate()]);
    expect(await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(silent))).toEqual(
      [],
    );
    const minority = setOf([candidate()], { lenses: rejectedBy(['macro', 'risk', 'technical']) });
    expect(
      await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(minority)),
    ).toEqual([]);
  });

  it('a majority of lens rejections turns a candidate down, naming the lenses', async () => {
    const majority = setOf([candidate()], {
      lenses: rejectedBy(['macro', 'risk', 'technical', 'fundamentals']),
    });
    const issues = await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(majority));
    expect(paths(issues)).toEqual(['theses.0.approvedId']);
    expect(issues[0]!.message).toContain(
      'rejected by 4 of 7 lenses (fundamentals, macro, technical, risk)',
    );
  });

  it('a vetoed candidate is refused by the veto’s named reason, not by silence', async () => {
    const vetoed = setOf([candidate()], {
      vetoes: [
        { candidateId: 'aapl-breakout-1', by: 'risk', reason: 'Earnings inside the horizon.' },
      ],
    });
    const issues = await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(vetoed));
    expect(issues).toEqual([
      expect.objectContaining({
        path: ['theses', 0, 'approvedId'],
        message: expect.stringContaining('vetoed by risk: Earnings inside the horizon.') as string,
      }),
    ]);
    // A veto with no reason is no veto: the set does not parse, and approves nothing.
    const unreasoned = setOf([candidate()], {
      vetoes: [{ candidateId: 'aapl-breakout-1', by: 'desk', reason: ' ' }],
    });
    const fault = await approvedThesesIssues(
      decision([thesis('aapl-2', null)]),
      reader(unreasoned),
    );
    expect(fault.some((i) => /does not parse/.test(i.message))).toBe(true);
  });

  it('keeps the candidate’s instrument, direction and arm', async () => {
    const set = reader(setOf([candidate()]));
    const other = {
      ...thesis('aapl-2', null),
      instrument: 'MSFT',
      direction: 'short',
      hypothesisId: 'gap-fade',
    };
    expect(paths(await approvedThesesIssues(decision([other]), set))).toEqual([
      'theses.0.instrument',
      'theses.0.direction',
      'theses.0.hypothesisId',
    ]);
  });

  it('opens each approved candidate once a day', async () => {
    const set = reader(setOf([candidate()]));
    const twice = await approvedThesesIssues(
      decision([thesis('aapl-2', null), thesis('aapl-3', null)]),
      set,
    );
    expect(paths(twice)).toEqual(['theses.1.approvedId']);
  });

  it('reads the day’s openings from the ledger the record step writes, not from decide', async () => {
    const doc = (path: string, body: Record<string, unknown>): OpeningLedgerDoc => ({
      path,
      content: JSON.stringify(body),
    });
    const set = setOf([candidate()]);
    const opensAgain = (ledger: OpeningLedgerDoc[]) =>
      approvedThesesIssues(decision([thesis('aapl-2', null)]), reader(set, DESK_WRITER, ledger));
    const openDoc = doc('/portfolio/theses/open/aapl-1.json', {
      thesisId: 'aapl-1',
      approvedId: 'aapl-breakout-1',
      openedTradingDay: '2026-07-14',
    });
    const earlier = await opensAgain([openDoc]);
    expect(paths(earlier)).toEqual(['theses.0.approvedId']);
    expect(earlier[0]!.message).toContain('by an earlier cycle today');
    // A thesis that resolved the same day still counts as opened.
    const resolvedDoc = doc('/portfolio/theses/resolved/aapl-1.json', {
      thesisId: 'aapl-1',
      approvedId: 'aapl-breakout-1',
      openedTradingDay: '2026-07-14',
      outcome: 'falsified',
    });
    expect(paths(await opensAgain([resolvedDoc]))).toEqual(['theses.0.approvedId']);
    // A cycle doc of the day counts even when its thesis doc is gone.
    const cycleDoc = doc('/portfolio/theses/cycles/2026-07-14-pre_market.json', {
      openedApprovals: [{ thesisId: 'aapl-1', approvedId: 'aapl-breakout-1' }],
    });
    expect(paths(await opensAgain([cycleDoc]))).toEqual(['theses.0.approvedId']);
    // An opening of another day, or of another candidate, does not.
    expect(
      await opensAgain([
        doc('/portfolio/theses/open/aapl-0.json', {
          approvedId: 'aapl-breakout-1',
          openedTradingDay: '2026-07-13',
        }),
        doc('/portfolio/theses/cycles/2026-07-13-open.json', {
          openedApprovals: [{ thesisId: 'aapl-0', approvedId: 'aapl-breakout-1' }],
        }),
        doc('/portfolio/theses/open/msft-1.json', {
          approvedId: 'msft-reversal-1',
          openedTradingDay: '2026-07-14',
        }),
      ]),
    ).toEqual([]);
    // decide carries no list of its own, so a decide that names none still meets the ledger.
    expect(
      await approvedThesesIssues(
        { ...decision([thesis('aapl-2', null)]), approvedOpenedToday: [] },
        reader(set, DESK_WRITER, [openDoc]),
      ),
    ).toHaveLength(1);
  });

  it('opens nothing when the ledger cannot be read', async () => {
    const source: ApprovedSetSource = {
      ...reader(setOf([candidate()])),
      readLedger: () => Promise.reject(new Error('the store is down')),
    };
    const issues = await approvedThesesIssues(decision([thesis('aapl-2', null)]), source);
    expect(paths(issues)).toEqual(['theses']);
    expect(issues[0]!.message).toContain('The thesis ledger cannot be read (the store is down)');
    expect(await approvedThesesIssues(decision([]), source)).toEqual([]);
  });

  it('refuses a thesis that names no candidate of the set, and lists the approved ones', async () => {
    const issues = await approvedThesesIssues(
      decision([thesis('aapl-2', null, 'breakout', 'msft-reversal-1')]),
      reader(setOf([candidate()])),
    );
    expect(issues[0]!.message).toContain('It approves: aapl-breakout-1.');
  });

  it('a day with no set opens nothing, and a decision that opens nothing passes', async () => {
    expect(await approvedThesesIssues(decision([]), reader())).toEqual([]);
    expect(paths(await approvedThesesIssues(decision([thesis('aapl-2', null)]), reader()))).toEqual(
      ['theses'],
    );
  });

  it('accepts the operator’s set and a completed desk run’s, and refuses every other writer', async () => {
    const ok = decision([thesis('aapl-2', null)]);
    const set = setOf([candidate()]);
    expect(await approvedThesesIssues(ok, reader(set, OPERATOR))).toEqual([]);
    expect(await approvedThesesIssues(ok, reader(set, DESK_WRITER))).toEqual([]);
    for (const [writer, why] of [
      [runWriter(CYCLE_WORKFLOW_SLUG), 'A cycle cannot approve its own theses'],
      [conversation(['run-desk-0714']), 'A conversation is never a run'],
      [conversation([]), 'the execution of no workflow run'],
      [runWriter('strategy-desk', { status: 'running' }), 'not completed'],
      [runWriter('strategy-desk', { spaceId: 'space-2' }), 'of another space'],
      [runWriter('strategy-desk', { runId: 'run-desk-other' }), 'names review run run-desk-0714'],
    ] as const) {
      const issues = await approvedThesesIssues(ok, reader(set, writer));
      expect(paths(issues), why).toEqual(['theses', 'approvedSetFault']);
      expect(issues[0]!.message, why).toContain(why);
    }
  });

  it('a set that cannot be read or parsed opens nothing and is named', async () => {
    const unreadable: ApprovedSetSource = {
      spaceId: SPACE,
      read: () => Promise.resolve({ status: 'unreadable', reason: 'the store is down' }),
      readLedger: () => Promise.resolve([]),
    };
    const issues = await approvedThesesIssues(decision([thesis('aapl-2', null)]), unreadable);
    expect(paths(issues)).toEqual(['theses', 'approvedSetFault']);
    // Naming the fault and opening nothing passes, so the closes and record run.
    const named = `The approved set at ${SET_PATH} cannot be read (the store is down)`;
    expect(await approvedThesesIssues(decision([], named), unreadable)).toEqual([]);
    const broken = reader({ tradingDay: '2026-07-14', candidates: 'none' });
    expect(paths(await approvedThesesIssues(decision([]), broken))).toEqual(['approvedSetFault']);
  });

  it('the tally deriver hands decide the approved candidates, and why the others were turned down', () => {
    const derived = deskTallyDerivation({
      set: JSON.stringify(
        setOf([candidate(), candidate('msft-reversal-1', { instrument: 'MSFT' })], {
          vetoes: [{ candidateId: 'msft-reversal-1', by: 'desk', reason: 'A gap fills it first.' }],
        }),
      ),
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.approved).toEqual([
      expect.objectContaining({
        candidateId: 'aapl-breakout-1',
        sizePct: 5,
        tally: { approvals: 7, rejections: 0, silent: [...DESK_LENSES] },
      }),
    ]);
    expect(derived.value.turnedDown).toEqual([
      {
        candidateId: 'msft-reversal-1',
        why: 'msft-reversal-1 was vetoed by desk: A gap fills it first.',
      },
    ]);
    expect(deskTallyDerivation({}).ok).toBe(true);
    expect(task('decide').inputBindings?.['approvedCandidates']).toEqual({
      kind: 'task_output',
      taskId: 'tally-set',
      path: 'approved',
    });
  });

  it('a day with no set and a desk folder runs the desk in the same firing; without the folder it does not', () => {
    const answer =
      (bindingSet: boolean) =>
      (taskId: string, input: Record<string, unknown>): Record<string, unknown> => {
        if (taskId === 'ingest-clock')
          return {
            data: {
              timestamp: '2026-07-14T10:40:00-04:00',
              is_open: true,
              next_open: '2026-07-15T09:30:00-04:00',
              next_close: '2026-07-14T16:00:00-04:00',
            },
          };
        if (taskId === 'ingest-account')
          return {
            data: { equity: '100000', cash: '100000', buying_power: '200000', status: 'ACTIVE' },
          };
        if (taskId === 'ingest-positions' || taskId === 'ingest-orders') return { data: [] };
        if (taskId === 'resolve-theses') return resolveOutput('open');
        if (taskId === 'check-set') return { found: false };
        if (taskId === 'run-desk') return { runId: DESK_RUN, outcome: 'completed' };
        if (taskId === 'read-set')
          return bindingSet
            ? { stat: { path: SET_PATH }, data: JSON.stringify(setOf([candidate()])) }
            : { found: false };
        return input['path'] !== undefined ? { path: input['path'] } : {};
      };
    const withDesk = runSkillTasks(
      wf.tasks as unknown as WorkflowTask[],
      { slot: 'open', bindingId: 'hb_desk' },
      answer(true),
      undefined,
      { campaign: CAMPAIGN },
    );
    expect(withDesk.statuses.get('run-desk')).toBe('succeeded');
    expect(withDesk.inputs.get('run-desk')).toMatchObject({
      slug: 'strategy-desk',
      inputs: { bindingId: 'hb_desk', tradingDay: '2026-07-14' },
      wait: 'until_complete',
    });
    expect(withDesk.inputs.get('decide')!['approvedCandidates']).toEqual([
      expect.objectContaining({ candidateId: 'aapl-breakout-1' }),
    ]);
    const without = runSkillTasks(
      wf.tasks as unknown as WorkflowTask[],
      { slot: 'open' },
      answer(false),
      undefined,
      { campaign: CAMPAIGN },
    );
    expect(without.statuses.get('run-desk')).toBe('skipped');
    expect(without.inputs.get('decide')!['approvedCandidates']).toEqual([]);
  });

  it('records the Layer 2 fields the review needs, each null where the step cannot read it', () => {
    const recordSchema = (benchmarkClose: number | null) =>
      effectiveOutputSchema(task('record'), {
        $campaign: CAMPAIGN,
        'resolve-theses': resolveOutput('after_close', { benchmarkClose }),
        decide: { theses: [], approvedSetFault: null },
        'execute-orders': { submittedCount: 0, deferredCount: 0, failedCount: 0 },
        'ingest-account': { equity: 100000, cash: 60000 },
      }) as {
        properties: {
          snapshotDoc: { required: string[]; properties: Record<string, { const?: unknown }> };
          cycleDoc: {
            properties: { thesesResolved: { items: { required: string[] } } };
          };
        };
      };
    // The snapshot's benchmark is pinned to the close resolve-theses read.
    const pinned = recordSchema(551.2).properties.snapshotDoc;
    expect(pinned.required).toContain('benchmarkClose');
    expect(pinned.properties['benchmarkClose']!.const).toBe(551.2);
    expect(recordSchema(null).properties.snapshotDoc.properties['benchmarkClose']!.const).toBe(
      null,
    );
    // Every resolved thesis carries its realized R, null where a fill is unknown.
    expect(
      recordSchema(null).properties.cycleDoc.properties.thesesResolved.items.required,
    ).toContain('realizedR');
    const resolveSchema = task('resolve-theses').outputContract!.schema as {
      required: string[];
      properties: { resolutions: { items: { required: string[] } } };
    };
    expect(resolveSchema.required).toContain('benchmarkClose');
    expect(resolveSchema.properties.resolutions.items.required).toContain('entryFillPrice');
  });

  it('keeps the entry fill on the resolved doc, so a close that settles later still computes realized R', () => {
    const record = task('record');
    const required = (
      record.outputContract!.schema as {
        properties: {
          cycleDoc: { properties: { thesesResolved: { items: { required: string[] } } } };
        };
      }
    ).properties.cycleDoc.properties.thesesResolved.items.required;
    expect(required).toEqual(expect.arrayContaining(['entryFillPrice', 'realizedR']));
    // The realized R is recomputed from the doc's own prices, never taken as written.
    expect(record.outputContract!.validatorRefs).toContain('trading.realized-r');
    const prompt = record.goal ?? '';
    // The resolution writes the entry fill onto the resolved doc beside realizedR.
    expect(prompt).toContain('`entryFillPrice` copied from the resolution, and `realizedR`');
    // A later settled close reads it back from that doc, with the doc's invalidation level.
    expect(prompt).toContain(
      "compute it from that resolved doc's own `entryFillPrice` and `invalidationLevel` and the settled close's `filledAvgPrice`",
    );
    const doc = getSkillBundleEntry('alpaca-thesis-trading')!.memorySeed[0]!.content;
    expect(doc).toContain('"entryFillPrice": "<the entry order\'s filled average price');
  });

  it('execute-orders submits an entry only for a thesis that carries an approvedId', () => {
    const schema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolveOutput('open'),
    });
    const submitted = (overrides: Record<string, unknown>) => ({
      slot: 'open',
      fractionalTrading: null,
      orderResults: [
        orderResult({
          clientOrderId: '2026-07-14-open-aapl-1-open',
          entryCondition: null,
          disposition: 'submitted',
          statusCode: 200,
          orderId: 'b0b6dd9d',
          orderStatus: 'accepted',
          fillState: 'pending',
          ...overrides,
        }),
      ],
      submittedCount: 1,
      deferredCount: 0,
      failedCount: 0,
    });
    expect(refuses(schema, submitted({}))).toBe(false);
    expect(refuses(schema, submitted({ approvedId: null }))).toBe(true);
    // An unapproved entry intention is dropped unsubmitted, never sent.
    expect(
      refuses(schema, {
        ...submitted({
          approvedId: null,
          disposition: 'expired',
          statusCode: null,
          orderId: null,
          orderStatus: null,
          fillState: null,
          error: 'Intention carries no approvedId.',
        }),
        submittedCount: 0,
      }),
    ).toBe(false);
    // A close never cites an approval.
    const close = { intent: 'close', side: 'sell', qty: '10', notional: null };
    expect(refuses(schema, submitted({ ...close, approvedId: null }))).toBe(false);
  });
});

describe('daily-trading-cycle short sizing', () => {
  const wf = getSkillCatalogEntry(CYCLE_SLUG)!.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id)! as CatalogTask;
  const schemaFor = (fractionalTrading: boolean | null) =>
    effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolveOutput('intraday', { slotIndex: 5 }),
      'ingest-account-config': { fractionalTrading },
    });

  /** The QQQ short of 2026-11-24: a $639.00 target at a 639.09 snapshot price. */
  const qqqShort = (overrides: Record<string, unknown>) =>
    orderResult({
      clientOrderId: '2026-11-24-intraday-5-2026-11-24-i5-qqq-s1-open',
      thesisId: '2026-11-24-i5-qqq-s1',
      symbol: 'QQQ',
      side: 'sell',
      notional: '639.00',
      entryCondition: null,
      ...overrides,
    });
  const submitted = (qty: string, shortSizing: string) =>
    qqqShort({
      qty,
      shortSizing,
      disposition: 'submitted',
      statusCode: 200,
      orderId: 'b0b6dd9d',
      orderStatus: 'accepted',
      fillState: 'pending',
    });
  const sizedToZero = (shortSizing: string, overrides: Record<string, unknown> = {}) =>
    qqqShort({
      qty: '0',
      shortSizing,
      disposition: 'failed',
      failureSource: 'sizing_rule',
      error: `Sizing rule ${shortSizing} sized 0 shares: one share at 639.09 exceeds the $639.00 target. No order was sent.`,
      ...overrides,
    });
  const output = (fractionalTrading: boolean | null, results: Record<string, unknown>[]) => ({
    slot: 'intraday',
    fractionalTrading,
    orderResults: results,
    submittedCount: results.filter((r) => r['disposition'] === 'submitted').length,
    deferredCount: 0,
    failedCount: results.filter((r) => r['disposition'] === 'failed').length,
  });

  /** One open cycle whose account configuration read answers `configuration`, or `configAnswer` where given. */
  const ingestRun = (configuration: Record<string, unknown>, configAnswer?: TaskAnswer) =>
    runSkillTasks(
      wf.tasks as unknown as WorkflowTask[],
      { slot: 'open' },
      (taskId, input) => {
        switch (taskId) {
          case 'ingest-clock':
            return {
              data: {
                timestamp: '2026-07-14T10:40:00-04:00',
                is_open: true,
                next_open: '2026-07-15T09:30:00-04:00',
                next_close: '2026-07-14T16:00:00-04:00',
              },
            };
          case 'ingest-account':
            // The account read carries no fractional_trading, as Alpaca's does not.
            return {
              data: {
                equity: '15000.42',
                cash: '9000.10',
                buying_power: '30000.84',
                status: 'ACTIVE',
              },
            };
          case 'ingest-account-config':
            return configAnswer ?? { data: configuration };
          case 'ingest-positions':
          case 'ingest-orders':
            return { data: [] };
          case 'resolve-theses':
            return resolveOutput('open');
          case 'check-set':
            return { found: false };
          default:
            return input['path'] !== undefined ? { path: input['path'] } : {};
        }
      },
      undefined,
      { campaign: CAMPAIGN },
    );
  const accountFacts = (run: ReturnType<typeof ingestRun>, taskId: string) => {
    const input = run.inputs.get(taskId) ?? {};
    return {
      equity: input['equity'],
      buyingPower: input['buyingPower'],
      fractionalTrading: input['fractionalTrading'],
    };
  };

  it('reads fractional_trading from the account configuration, never the account read', () => {
    expect(task('ingest-account').outputProjection).not.toHaveProperty('fractionalTrading');
    const config = task(ACCOUNT_CONFIG_TASK_ID);
    expect(config.inputTemplate).toMatchObject({
      apiId: 'alpaca-account-read',
      endpointId: 'get_account_configurations',
    });
    expect(config.outputProjection?.['fractionalTrading']).toEqual({
      path: 'data.fractional_trading',
      onMissing: 'null',
    });
    const schema = config.outputContract!.schema as Record<string, unknown>;
    for (const fractionalTrading of [true, false, null]) {
      expect(refuses(schema, { fractionalTrading })).toBe(false);
    }
    expect(refuses(schema, { fractionalTrading: 'true' })).toBe(true);
  });

  it('a fractional-capable account reads true, and execution sizes with it and the account', () => {
    const run = ingestRun({ fractional_trading: true, no_shorting: false, pdt_check: 'entry' });
    expect(run.statuses.get(ACCOUNT_CONFIG_TASK_ID)).toBe('succeeded');
    expect(accountFacts(run, 'execute-orders')).toEqual({
      equity: 15000.42,
      buyingPower: 30000.84,
      fractionalTrading: true,
    });
    expect(run.inputs.get('decide')!['fractionalTrading']).toBe(true);
  });

  it('an account that does not trade fractional shares reads false', () => {
    const run = ingestRun({ fractional_trading: false, no_shorting: false });
    expect(accountFacts(run, 'execute-orders')).toEqual({
      equity: 15000.42,
      buyingPower: 30000.84,
      fractionalTrading: false,
    });
    expect(run.inputs.get('decide')!['fractionalTrading']).toBe(false);
  });

  it('a configuration that omits fractional_trading reads null, so the whole-share fallback holds', () => {
    const run = ingestRun({ no_shorting: false });
    expect(run.statuses.get(ACCOUNT_CONFIG_TASK_ID)).toBe('succeeded');
    expect(accountFacts(run, 'execute-orders')).toEqual({
      equity: 15000.42,
      buyingPower: 30000.84,
      fractionalTrading: null,
    });
    // The null pins the contract to the capability-unknown rule.
    const schema = schemaFor(null);
    expect(refuses(schema, output(null, [submitted('1', 'whole_share_capability_unknown')]))).toBe(
      false,
    );
    expect(refuses(schema, output(null, [submitted('1', 'whole_share')]))).toBe(true);
  });

  it('a configuration read that fails costs the sizing fidelity, never the cycle', () => {
    // A stored alpaca-account-read definition that predates the endpoint fails the read.
    const stale =
      'API endpoint "get_account_configurations" is not declared by "alpaca-account-read".';
    const run = ingestRun({}, failWith(stale));
    expect(task(ACCOUNT_CONFIG_TASK_ID).optional).toBe(true);
    expect(run.statuses.get(ACCOUNT_CONFIG_TASK_ID)).toBe('failed');
    for (const id of ['ingest-positions', 'ingest-orders', 'resolve-theses', 'execute-orders']) {
      expect(run.statuses.get(id), id).toBe('succeeded');
    }
    expect(run.ran).toContain('decide');
    expect(run.ran).toContain('write-cycle-doc');
    // Execution reads no attribute, and its pin falls back to null: whole shares, capability unknown.
    expect(accountFacts(run, 'execute-orders')).toEqual({
      equity: 15000.42,
      buyingPower: 30000.84,
      fractionalTrading: undefined,
    });
    expect(FRACTIONAL_TRADING_PIN.whenUpstreamFailed).toEqual({ value: null });
    // The cycle doc records the gap.
    const doc = run.inputs.get('write-cycle-doc')!['content'] as {
      inlineJson: Record<string, unknown>;
    };
    expect(doc.inlineJson['accountConfigFault']).toBe(stale);
    // A read that succeeds records no gap.
    const ok = ingestRun({ fractional_trading: true });
    const okDoc = ok.inputs.get('write-cycle-doc')!['content'] as {
      inlineJson: Record<string, unknown>;
    };
    expect(okDoc.inlineJson['accountConfigFault']).toBeNull();
  });

  it('fractional_trading true: a $639 short at 639.09 submits a fractional qty, not 0', () => {
    const schema = schemaFor(true);
    expect(refuses(schema, output(true, [submitted('0.999859174', 'fractional')]))).toBe(false);
    // A zero qty never reaches the broker under the fractional rule.
    expect(refuses(schema, output(true, [submitted('0', 'fractional')]))).toBe(true);
    expect(refuses(schema, output(true, [submitted('0.000', 'fractional')]))).toBe(true);
    // The broker takes 9 decimal places at most.
    expect(refuses(schema, output(true, [submitted('0.9998591749', 'fractional')]))).toBe(true);
    // Where whole shares size it to 0, the fractional rule sizes it: a whole-share failure is refused.
    expect(refuses(schema, output(true, [sizedToZero('whole_share')]))).toBe(true);
    // A target under the $1 fractional minimum still sizes nothing, and says so.
    const underMinimum = sizedToZero('fractional', {
      notional: '0.50',
      error:
        'Sizing rule fractional sized nothing: the $0.50 target is under the $1 minimum. No order was sent.',
    });
    expect(refuses(schema, output(true, [underMinimum]))).toBe(false);
    // The flag is pinned to the account read.
    expect(refuses(schema, output(false, [submitted('0.999859174', 'fractional')]))).toBe(true);
    expect(refuses(schema, output(null, [submitted('0.999859174', 'fractional')]))).toBe(true);
  });

  it('fractional_trading true: a short whole shares can express keeps its whole-share qty', () => {
    const schema = schemaFor(true);
    // A $5000 target at 639.09 sends 7 shares, as it did before the account flag was read.
    const sevenShares = { ...submitted('7', 'whole_share'), notional: '5000.00' };
    expect(refuses(schema, output(true, [sevenShares]))).toBe(false);
    expect(refuses(schema, output(true, [submitted('1', 'whole_share')]))).toBe(false);
    // A fractional qty is a last resort under one share, never a general sizing rule.
    const fractionalSeven = { ...submitted('7.823624216', 'fractional'), notional: '5000.00' };
    expect(refuses(schema, output(true, [fractionalSeven]))).toBe(true);
    expect(refuses(schema, output(true, [submitted('1', 'fractional')]))).toBe(true);
    expect(refuses(schema, output(true, [submitted('1.5', 'fractional')]))).toBe(true);
    // The whole-share rule sends whole shares only.
    expect(refuses(schema, output(true, [submitted('7.823624216', 'whole_share')]))).toBe(true);
    // An absent flag's rule name never appears where the account read carries the flag.
    expect(refuses(schema, output(true, [submitted('7', 'whole_share_capability_unknown')]))).toBe(
      true,
    );
  });

  it('fractional_trading false: a short sizes whole shares, as before', () => {
    const schema = schemaFor(false);
    expect(refuses(schema, output(false, [submitted('2', 'whole_share')]))).toBe(false);
    expect(refuses(schema, output(false, [submitted('0.999859174', 'whole_share')]))).toBe(true);
    expect(refuses(schema, output(false, [submitted('0.999859174', 'fractional')]))).toBe(true);
    // One share costs more than the target: the sizing rule sends nothing, and says so.
    expect(refuses(schema, output(false, [sizedToZero('whole_share')]))).toBe(false);
  });

  it('fractional_trading absent: whole shares, the capability recorded as unknown', () => {
    const schema = schemaFor(null);
    const failed = sizedToZero('whole_share_capability_unknown');
    expect(refuses(schema, output(null, [failed]))).toBe(false);
    expect(refuses(schema, output(null, [submitted('1', 'whole_share_capability_unknown')]))).toBe(
      false,
    );
    // An absent flag is never silently read as either answer.
    expect(refuses(schema, output(null, [sizedToZero('whole_share')]))).toBe(true);
    expect(refuses(schema, output(null, [submitted('0.5', 'fractional')]))).toBe(true);
    // An order the sizing rule stopped is never a broker rejection.
    expect(refuses(schema, output(null, [{ ...failed, failureSource: 'broker_rejected' }]))).toBe(
      true,
    );
    expect(refuses(schema, output(null, [{ ...failed, failureSource: null }]))).toBe(true);
    expect(refuses(schema, output(null, [{ ...failed, statusCode: 422 }]))).toBe(true);
    // The record step copies the order result whole, so the thesis doc carries the unknown capability.
    const recordGoal = task('record').goal ?? '';
    expect(recordGoal).toContain(
      'Copy the entry order result whole, `shortSizing` and `failureSource` included',
    );
  });

  it('a failed order names its source: the broker, the sizing rule, or another unsent reason', () => {
    const schema = schemaFor(true);
    const rejected = qqqShort({
      qty: '0.999859174',
      shortSizing: 'fractional',
      disposition: 'failed',
      statusCode: 403,
      failureSource: 'broker_rejected',
      error: 'insufficient qty available for order',
    });
    expect(refuses(schema, output(true, [rejected]))).toBe(false);
    // A broker rejection carries the status of the call that was made.
    expect(refuses(schema, output(true, [{ ...rejected, statusCode: null }]))).toBe(true);
    const unsent = qqqShort({
      qty: null,
      shortSizing: 'fractional',
      disposition: 'failed',
      failureSource: 'not_submitted',
      error: 'The snapshot returned no price for QQQ, so no order was sent.',
    });
    expect(refuses(schema, output(true, [unsent]))).toBe(false);
    expect(refuses(schema, output(true, [{ ...unsent, error: null }]))).toBe(true);
    // Only a short entry can be stopped by the short sizing rule.
    const longStopped = orderResult({
      disposition: 'failed',
      failureSource: 'sizing_rule',
      error: 'Sized to zero.',
    });
    expect(refuses(schema, output(true, [longStopped]))).toBe(true);
    // An order that did not fail names no failure source.
    expect(
      refuses(
        schema,
        output(true, [{ ...submitted('1', 'whole_share'), failureSource: 'sizing_rule' }]),
      ),
    ).toBe(true);
    // A deferred short sizes nothing yet.
    const deferred = qqqShort({
      entryCondition: 'Trades below 639.00.',
      shortSizing: 'fractional',
    });
    expect(refuses(schema, output(true, [deferred]))).toBe(true);
    expect(refuses(schema, output(true, [{ ...deferred, shortSizing: null }]))).toBe(false);
  });
});

describe('alpaca-thesis-trading bundle', () => {
  const bundle = getSkillBundleEntry('alpaca-thesis-trading');
  if (!bundle) {
    throw new Error('bundle "alpaca-thesis-trading" not found');
  }

  it('ships the three Alpaca API definitions + default bindings on one credential pair', () => {
    expect(bundle.apiDefinitions.map((d) => d.apiId).sort()).toEqual([
      'alpaca-account-read',
      'alpaca-market-data',
      'alpaca-paper-orders-write',
    ]);
    expect(bundle.apiBindingTemplates.map((b) => b.bindingId).sort()).toEqual([
      'alpaca-account-read-default',
      'alpaca-market-data-default',
      'alpaca-paper-orders-write-default',
    ]);
    const credentialKeys = new Set(
      bundle.apiBindingTemplates.flatMap((b) => b.credentialSlots.map((s) => s.credentialKey)),
    );
    expect([...credentialKeys].sort()).toEqual(['alpaca-paper-key-id', 'alpaca-paper-secret-key']);
  });

  it('the orders-write binding allows submit + cancel only, pinned to the paper host', () => {
    const write = bundle.apiBindingTemplates.find(
      (b) => b.bindingId === 'alpaca-paper-orders-write-default',
    );
    expect(write?.egressPolicy?.allowedMethods).toEqual(['POST', 'DELETE']);
    expect(write?.egressPolicy?.allowedHosts).toEqual(['paper-api.alpaca.markets']);
  });

  it('the write definition carries the order-cancel endpoint', () => {
    const writeDef = bundle.apiDefinitions.find((d) => d.apiId === 'alpaca-paper-orders-write');
    const cancel = writeDef?.definition.endpoints.find(
      (e) => e.endpointId === 'delete_orders_order_id',
    );
    expect(cancel?.method).toBe('DELETE');
    expect(cancel?.path).toBe('/orders/{order_id}');
  });

  it('market-data stock endpoints require feed with free-tier teaching (sip default 403s)', () => {
    const md = bundle.apiDefinitions.find((d) => d.apiId === 'alpaca-market-data');
    for (const id of [
      'get_v2_stocks_symbol_snapshot',
      'get_v2_stocks_snapshots',
      'get_v2_stocks_symbol_bars',
    ]) {
      const ep = md?.definition.endpoints.find((e) => e.endpointId === id);
      const feed = ep?.queryParams?.find((q) => q.name === 'feed');
      expect(feed?.required, id).toBe(true);
      expect(feed?.description, id).toContain('iex');
      expect(feed?.description, id).toContain('403');
    }
  });

  it('the account-read definition registers every endpoint the ingest chain calls', () => {
    const accountRead = bundle.apiDefinitions.find((d) => d.apiId === 'alpaca-account-read');
    const endpointIds = new Set(accountRead?.definition.endpoints.map((e) => e.endpointId));
    for (const needed of [
      'get_clock',
      'get_account',
      'get_account_configurations',
      'get_positions',
      'get_orders',
    ]) {
      expect(endpointIds.has(needed), needed).toBe(true);
    }
  });

  it('seeds the thesis-ledger schema doc', () => {
    expect(bundle.memorySeed.map((s) => s.path)).toEqual(['portfolio/theses/SCHEMA.md']);
    const doc = bundle.memorySeed[0]!.content;
    expect(doc).toContain('/portfolio/theses/open/{thesisId}.json');
    expect(doc).toContain('/portfolio/theses/resolved/{thesisId}.json');
    expect(doc).toContain('/portfolio/intentions/{clientOrderId}.json');
    expect(doc).toContain('/portfolio/theses/cycles/{tradingDay}-{slotKey}.json');
    expect(doc).toContain('/portfolio/snapshots/{tradingDay}-{slotKey}.json');
    expect(doc).toContain('/portfolio/market-data/{symbol}.json');
    expect(doc).toContain('Only COMPLETED sessions enter the cache');
    // Order truth is part of the ledger contract.
    expect(doc).toContain('entry_failed');
    expect(doc).toContain('entryFillState');
    expect(doc).toContain('orphanFlattens');
    expect(doc).toContain('brokerGrossExposurePct');
    expect(doc).toContain('submittable only when');
    expect(doc).toContain('patched onto');
    // Layer separation is part of the ledger contract.
    expect(doc).toContain('Layer 1');
    expect(doc).toContain('Layer 2');
    expect(doc).toContain('Raw daily P&L is not a signal anywhere');
    // The ledger carries the same slot taxonomy as the skill contract, name and index.
    expect(doc).toContain('pre_market | open | intraday | after_close');
    expect(doc).not.toContain('morning');
    for (const field of [
      'openedSlotIndex',
      'proposedSlotIndex',
      'resolvedSlotIndex',
      'slotIndex',
    ]) {
      expect(doc, field).toContain(`"${field}"`);
    }
    expect(doc).toContain('"entryCondition"');
  });

  it('says the Strategy Desk writes the day’s set, and the agent decides and executes', () => {
    const doc = bundle.memorySeed[0]!.content;
    const hints = bundle.helmsmanHints.join('\n');
    expect(doc).toMatch(/\*\*Strategy Desk\*\* writes it/);
    for (const text of [bundle.description, doc, hints]) {
      // Operator-facing text names the skill, never an internal plan.
      expect(text).not.toMatch(/Plan \d+|Part B/);
      // No supervisory prose: the agent's authority is to decide and execute.
      expect(text).not.toMatch(/You supervise|zero discretion|last resort|resolve-only cycle by/);
    }
    expect(bundle.skillCatalogIds).toEqual([
      'daily-trading-cycle',
      'strategy-desk',
      'trading-reflection',
      'campaign-successor',
      'desk-charter',
      'performance-review',
    ]);
    expect(bundle.description).toContain('the agent decides and executes');
    expect(doc).toContain('One set per trading day');
    expect(doc).toContain(DESK_TALLY_RULE);
    expect(doc).toContain('/research/{tradingDay}/desk-runs/{runId}.json');
    // The operator owns the strategy: the campaign changes at a boundary.
    expect(bundle.description).toContain("The campaign is the operator's");
    // An update must deliver the approved-set shape, so the contract doc is overwritten.
    expect(bundle.memorySeed[0]!.seedPolicy).toBe('overwrite');
  });

  it('setup notes and hints describe the four cycle firings, each running the desk where the day has no set', () => {
    const text = [bundle.description, ...bundle.helmsmanHints].join('\n');
    for (const slot of ['pre_market', 'open', 'intraday', 'after_close']) {
      expect(text, slot).toContain(`slot: "${slot}"`);
    }
    for (const cron of ['47 8 * * 1-5', '37 9 * * 1-5', '7 10-15 * * 1-5', '23 16 * * 1-5']) {
      expect(text, cron).toContain(cron);
    }
    expect(text).toContain('staggered off round boundaries');
    expect(text).toContain('{ slot, bindingId }');
    expect(text).toContain('tradingDay: { "$now": "date" }');
    expect(text).toContain('runs the Strategy Desk and waits for it');
  });
});
