import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  archiveThesisLedger,
  armBudgetIssues,
  armTableIssues,
  campaignArmBudgets,
  computeArmTable,
  readLedgerTheses,
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateCampaignConfig,
  validateWhenExpression,
  validateWorkflowGraph,
  type ThesisLedgerArchiveStore,
  type ThesisLedgerDoc,
  type ThesisLedgerHolder,
} from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  SkillComposeBundleSchema,
  getOperation,
  getValidator,
  lookupValidator,
  mergeDerivedPatches,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';
import AjvModule from 'ajv';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { INTRADAY_INDEX_RULE } from '../skillCatalog/dailyTradingCycleSlots.js';
import {
  APPROVED_THESES_VALIDATOR_REF,
  CYCLE_WORKFLOW_SLUG,
  approvedThesesIssues,
  type ApprovedSetRead,
  type ApprovedSetSource,
  type ApprovedSetWriter,
} from '../skillCatalog/dailyTradingCycleApproved.js';

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
      thesisBudgetPerDay: 2,
    },
    {
      id: 'gap-fade',
      name: 'Opening gap fades',
      statement: 'Opening gaps over 2% on no news retrace half the gap by the close.',
      thesisBudgetPerDay: 1,
    },
  ],
  universe: ['AAPL', 'MSFT', 'SPY'],
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

/** The gather-regime output every decide contract in this suite pins its marketState to. */
const GATHERED = { marketRegime: { state: 'risk_on' } };

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
    maxThesesPerDay: 3,
    thesesOpenedToday: [],
    remainingThesesToday: slot === 'after_close' ? 0 : 3,
    coverageNote: 'No slot missed since the last cycle.',
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
    reviewRunId: 'run-review-0714',
    instrument: 'AAPL',
    direction: 'long',
    rationale: 'Closed above the 20-day high of 187.40 on 1.8x average volume.',
    entryCondition,
    falsificationCriterion: 'A daily close below 184.00.',
    confirmationCriterion: 'A daily close above 195.00.',
    deadlineTradingDays: 3,
    sizePct: 5,
    confidence: 'medium',
  };
}

/** A decide output for the 2026-07-14 cycle of `resolveOutput`. */
function decision(slot: CycleSlot, theses: unknown[]) {
  return {
    tradingDay: '2026-07-14',
    regimeName: CAMPAIGN.regimeName,
    slot,
    slotIndex: slot === 'intraday' ? 3 : null,
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
    const source = sources[b.from] ?? (b.from === 'gather-regime' ? GATHERED : undefined);
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

  it('has the expected 14-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'ingest-clock',
        'ingest-account',
        'ingest-positions',
        'ingest-orders',
        'resolve-theses',
        'ingest-calendar',
        'gather-regime',
        'read-pre-market',
        'decide',
        'execute-orders',
        'record',
        'write-snapshot',
        'write-cycle-doc',
        'record-learnings',
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
    for (const id of ['ingest-clock', 'ingest-account', 'ingest-positions', 'ingest-orders']) {
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

  it('the risk-gate binds every campaign cap into the decide contract from $campaign', () => {
    const derived = task('decide')?.outputContract?.derivedFrom ?? [];
    const fromCampaign = derived.filter((b) => b.from === '$campaign');
    // The rest come from resolve-theses: the day's remaining cap and the slot pin.
    expect(
      derived
        .filter((b) => b.from !== '$campaign')
        .map((b) => `${b.from}:${b.binding}>${b.target}`),
    ).toEqual([
      'resolve-theses:value:$.remainingThesesToday>$.theses.maxItems',
      'resolve-theses:value:$.slot>$.slot.const',
      'resolve-theses:value:$.tradingDay>$.tradingDay.const',
      'resolve-theses:value:$.slotIndex>$.slotIndex.const',
      'gather-regime:value:$.marketRegime.state>$.marketState.const',
    ]);
    const byTarget = Object.fromEntries(fromCampaign.map((b) => [b.target, b.binding]));
    expect(byTarget).toEqual({
      '$.theses.items.instrument.enum': 'enum:$.universe[*]',
      '$.theses.items.hypothesisId.enum': 'enum:$.hypotheses[*].id',
      '$.regimeName.const': 'value:$.regimeName',
      '$.theses.maxItems': 'value:$.maxThesesPerDay',
      '$.theses.items.sizePct.maximum': 'value:$.maxPositionSizePct',
      '$.projectedGrossExposurePct.maximum': 'value:$.maxGrossExposurePct',
      '$.theses.items.deadlineTradingDays.minimum': 'value:$.minHorizonTradingDays',
      '$.theses.items.deadlineTradingDays.maximum': 'value:$.maxHorizonTradingDays',
    });
  });

  it('a sample campaign config merges into an enforceable decide schema', () => {
    const effectiveSchema = effectiveOutputSchema(task('decide')!, {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
    });
    const theses = (effectiveSchema as any).properties.theses;
    expect(theses.maxItems).toBe(3);
    expect(theses.items.properties.instrument.enum).toEqual(['AAPL', 'MSFT', 'SPY']);
    expect(theses.items.properties.sizePct.maximum).toBe(8);
    expect(theses.items.properties.deadlineTradingDays.minimum).toBe(1);
    expect(theses.items.properties.deadlineTradingDays.maximum).toBe(5);
    expect((effectiveSchema as any).properties.projectedGrossExposurePct.maximum).toBe(60);
  });

  it('the thesis shape is fully specified and required (pre-registration is structural)', () => {
    const schema = task('decide')?.outputContract?.schema as {
      properties: { theses: { items: { required: string[] } } };
    };
    expect(schema.properties.theses.items.required.sort()).toEqual(
      [
        'approvedId',
        'reviewRunId',
        'confidence',
        'confirmationCriterion',
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

  it('short entries size in whole shares — the broker rejects fractional short sales', () => {
    const executeGoal = task('execute-orders')?.goal ?? '';
    expect(executeGoal).toContain('SHORT entry sizes in whole shares');
    expect(executeGoal).toContain('floor(targetNotional / latest price)');
    // qty 0 is an honest failed order, never a silently skipped or resized one.
    expect(executeGoal).toContain('qty 0 means one share costs more than the target size');
    // A deferred short intention re-derives qty from a FRESH price at submission.
    expect(executeGoal).toContain('never the stored notional itself');
    // Closes submit the held quantity verbatim — whole-share is a short-ENTRY rule only.
    expect(executeGoal).toContain('held quantity verbatim');
    const decideGoal = task('decide')?.goal ?? '';
    expect(decideGoal).toContain('whole shares rounded down from sizePct / 100 × equity');
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

  it('orphans are excluded from the cap-scored gross: both gross numbers are reported', () => {
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

  it('deferred exposure is visible to the risk gate: pending intentions feed the projection', () => {
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
    expect(decideGoal).toContain('deferral must not smuggle exposure past the cap');
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
    const criteria = entry.bundle.evalSuite?.taskCriteria['record'] ?? [];
    expect(criteria).toContainEqual({
      name: 'gross-exposure-within-cap',
      type: 'threshold',
      metric: 'grossExposurePct',
      operator: 'lte',
      target: { $campaign: 'maxGrossExposurePct' },
    });
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

  it('the only run inputs are the optional slot and slotIndex, read by resolve-theses alone', () => {
    expect(wf.runInputs?.map((r) => [r.id, r.required])).toEqual([
      ['slot', false],
      ['slotIndex', false],
    ]);
    const entryContract = task('ingest-clock')?.inputContract?.bindings ?? {};
    expect(Object.keys(entryContract).sort()).toEqual(['slot', 'slotIndex']);
    for (const t of wf.tasks) {
      const runInputs = Object.entries(t.inputBindings ?? {}).filter(
        ([, b]) => (b as { kind: string }).kind === 'run_input',
      );
      expect(runInputs.length > 0, t.taskId).toBe(t.taskId === 'resolve-theses');
    }
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
        'maxGrossExposurePct',
        'maxPositionSizePct',
        'maxThesesPerDay',
        'minHorizonTradingDays',
        'maxHorizonTradingDays',
        'pooledSampleFloor',
        'regimeCaps',
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

  it('has no human task — the structural risk-gate is the safety layer on paper', () => {
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
    for (const id of ['resolve-theses', 'decide', 'execute-orders']) {
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

  it('resolve-theses: a remaining cap that ignores the theses opened today is refused', () => {
    const opened = { thesesOpenedToday: ['aapl-1', 'msft-1'] };
    expect(resolveRefuses(resolveOutput('open', { ...opened, remainingThesesToday: 1 }))).toBe(
      false,
    );
    expect(resolveRefuses(resolveOutput('open', { ...opened, remainingThesesToday: 3 }))).toBe(
      true,
    );
    // The cap the remainder derives from is the campaign's, not one the agent picks.
    expect(
      resolveRefuses(
        resolveOutput('open', { ...opened, maxThesesPerDay: 5, remainingThesesToday: 3 }),
      ),
    ).toBe(true);
    // A day past its cap floors at 0.
    expect(
      resolveRefuses(
        resolveOutput('intraday', {
          thesesOpenedToday: ['a-1', 'b-1', 'c-1', 'd-1'],
          remainingThesesToday: 0,
        }),
      ),
    ).toBe(false);
  });

  it('pre_market: a cycle that submits an order is refused', () => {
    const schema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolveOutput('pre_market'),
    });
    const deferred = {
      slot: 'pre_market',
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
    expect(refuses(schema, submitted)).toBe(true);
  });

  it.each(['open', 'intraday'] as const)(
    '%s: a cycle that forms an entry past the day’s remaining cap is refused',
    (slot) => {
      // Two of the day's three theses were opened by earlier slots.
      const resolved = resolveOutput(slot, {
        thesesOpenedToday: ['aapl-1', 'msft-1'],
        remainingThesesToday: 1,
      });
      expect(resolveRefuses(resolved)).toBe(false);
      const schema = effectiveOutputSchema(task('decide'), {
        $campaign: CAMPAIGN,
        'resolve-theses': resolved,
      });
      expect(refuses(schema, decision(slot, [thesis('aapl-2', null)]))).toBe(false);
      expect(
        refuses(schema, decision(slot, [thesis('aapl-2', null), thesis('aapl-3', null)])),
      ).toBe(true);
    },
  );

  it('after_close: a cycle that forms a new entry is refused', () => {
    const schema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('after_close'),
    });
    expect(refuses(schema, decision('after_close', []))).toBe(false);
    expect(refuses(schema, decision('after_close', [thesis('aapl-2', null)]))).toBe(true);
  });
});

describe('daily-trading-cycle hypothesis arms', () => {
  const entry = getSkillCatalogEntry(CYCLE_SLUG)!;
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id)! as CatalogTask;
  const contract = entry.bundle.manifest.campaign!;

  it('a thesis with a missing or unknown hypothesisId is refused by the decide contract', () => {
    const schema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
    });
    expect(refuses(schema, decision('open', [thesis('aapl-2', null, 'gap-fade')]))).toBe(false);
    const { hypothesisId: _omitted, ...uncited } = thesis('aapl-2', null);
    expect(refuses(schema, decision('open', [uncited]))).toBe(true);
    expect(refuses(schema, decision('open', [thesis('aapl-2', null, 'mean-reversion')]))).toBe(
      true,
    );
  });

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

  it('a thesisBudgetPerDay over the campaign’s cap is refused', () => {
    const [breakout, gapFade] = CAMPAIGN.hypotheses;
    const atCap = { ...CAMPAIGN, hypotheses: [{ ...breakout!, thesisBudgetPerDay: 3 }, gapFade!] };
    expect(validateCampaignConfig(contract, atCap).ok).toBe(true);
    const overCap = {
      ...CAMPAIGN,
      hypotheses: [{ ...breakout!, thesisBudgetPerDay: 4 }, gapFade!],
    };
    const result = validateCampaignConfig(contract, overCap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({ field: 'hypotheses', code: 'RULE_VIOLATION' }),
      ]);
      expect(result.issues[0]!.detail).toContain("over the campaign's maxThesesPerDay of 3");
    }
  });

  it('an arm past its daily budget is refused, counting the theses it opened earlier that day', () => {
    const ledger = [
      openDoc('aapl-1', 'breakout', '2026-07-14'),
      openDoc('msft-1', 'gap-fade', '2026-07-13'),
    ];
    const scope = { hypotheses: CAMPAIGN.hypotheses, docs: ledger };
    const output = (theses: unknown[]) => decision('intraday', theses);
    expect(armBudgetIssues(output([thesis('aapl-2', null)]), scope)).toEqual([]);
    expect(
      armBudgetIssues(output([thesis('aapl-2', null), thesis('aapl-3', null)]), scope),
    ).toEqual([expect.objectContaining({ path: ['theses', 1, 'hypothesisId'] })]);
    // A re-run after a crash re-proposes a thesis the ledger already holds.
    expect(
      armBudgetIssues(output([thesis('aapl-1', null), thesis('aapl-2', null)]), scope),
    ).toEqual([]);
  });

  it('the arm budget gate refuses when the campaign cannot be found or has no arms', () => {
    const active = (config: Record<string, unknown>, workflowSlug = CYCLE_SLUG) => [
      { config, workflowSlug },
    ];
    const scope = { workflowSlug: CYCLE_SLUG, regimeName: CAMPAIGN.regimeName };
    expect(campaignArmBudgets(active(CAMPAIGN), scope)).toEqual({
      ok: true,
      hypotheses: CAMPAIGN.hypotheses,
    });
    const { hypotheses: _omitted, ...armless } = CAMPAIGN;
    for (const [campaigns, label] of [
      [active({ ...CAMPAIGN, regimeName: 'momentum-0' }), 'other'],
      [active(armless), 'armless'],
      [[], 'none'],
    ] as const) {
      expect(campaignArmBudgets(campaigns, scope), label).toMatchObject({
        ok: false,
        issue: { path: ['regimeName'] },
      });
    }
  });

  it('a same-named campaign of another skill in the space supplies no budget', () => {
    const [breakout] = CAMPAIGN.hypotheses;
    const forked = {
      workflowSlug: 'daily-trading-cycle-fork',
      config: { ...CAMPAIGN, hypotheses: [{ ...breakout!, thesisBudgetPerDay: 3 }] },
    };
    const own = { workflowSlug: CYCLE_SLUG, config: CAMPAIGN };
    const scope = { workflowSlug: CYCLE_SLUG, regimeName: CAMPAIGN.regimeName };
    expect(campaignArmBudgets([forked, own], scope)).toEqual({
      ok: true,
      hypotheses: CAMPAIGN.hypotheses,
    });
    expect(campaignArmBudgets([forked], scope)).toMatchObject({
      ok: false,
      issue: { path: ['regimeName'] },
    });
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
      const scope = { hypotheses: CAMPAIGN.hypotheses, docs: [...ledger, bareDoc] };
      expect(armBudgetIssues(decision('intraday', [thesis('aapl-2', null)]), scope)).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(`${bareDoc.path}.*Submit no theses and name the doc in decisionRationale`),
          ) as string,
        }),
      ]);
      expect(armBudgetIssues(decision('intraday', []), scope)).toEqual([]);
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
          openedApprovals: opened.map((thesisId) => ({
            thesisId,
            approvedId: 'aapl-breakout-1',
            reviewRunId: 'run-review-0714',
          })),
          approvedSetFault: null,
          thesesResolved: resolved,
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
        const scope = { hypotheses: CAMPAIGN.hypotheses, docs };
        const decideIssues = armBudgetIssues(decision('open', [thesis('aapl-2', null)]), scope);
        expect(decideIssues).toHaveLength(2);
        for (const issue of decideIssues) {
          expect(issue.message).toContain('Submit no theses and name the doc in decisionRationale');
        }
      });

      it('runs the upgrade cycle end to end, record and decide passing, with the archive in the space', async () => {
        const { store, docsNow } = spaceStore([...earlier, priorCycle]);
        await migrate(store);
        const space = docsNow();
        const scope = { hypotheses: CAMPAIGN.hypotheses, docs: space };
        expect(armBudgetIssues(decision('open', [thesis('aapl-2', null)]), scope)).toEqual([]);

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

  function approvedEntry(overrides: Record<string, unknown> = {}) {
    return {
      approvedId: 'aapl-breakout-1',
      instrument: 'AAPL',
      direction: 'long',
      hypothesisId: 'breakout',
      entryLevel: 187.4,
      invalidationLevel: 184,
      confirmationLevel: 195,
      maxSizePct: 5,
      horizonTradingDays: 3,
      reviewerVerdict: 'approved',
      reviewRunId: 'run-review-0714',
      ...overrides,
    };
  }

  const SPACE = 'space-1';
  const OPERATOR: ApprovedSetWriter = { kind: 'operator', actor: 'api' };
  const runWriter = (
    workflowSlug: string,
    overrides: Partial<{ runId: string; status: string; spaceId: string }> = {},
  ): ApprovedSetWriter => ({
    kind: 'session',
    sessionId: 'session-9',
    stepExecutionId: null,
    drivenRuns: [],
    runs: [
      {
        runId: 'run-review-0714',
        workflowSlug,
        status: 'completed',
        spaceId: SPACE,
        ...overrides,
      },
    ],
  });
  /** An agent conversation's session: it executes no run's task, whatever runs it drove. */
  const conversation = (drivenRuns: string[]): ApprovedSetWriter => ({
    kind: 'session',
    sessionId: 's-7',
    stepExecutionId: null,
    drivenRuns,
    runs: [],
  });

  /** An in-memory space: the set at its path with the writer of record, or no document at all. */
  function reader(content?: unknown, writer: ApprovedSetWriter = OPERATOR): ApprovedSetSource {
    const read = (path: string): Promise<ApprovedSetRead> => {
      if (path !== SET_PATH || content === undefined) return Promise.resolve({ status: 'missing' });
      return Promise.resolve({ status: 'found', content, writer });
    };
    return { spaceId: SPACE, read };
  }

  type Issues = Array<{ path: unknown[]; message: string }>;
  /** A faulted set refuses the theses, because it approves nothing. */
  const refusesForFault = (issues: Issues) =>
    issues.some((i) => i.path.join('.') === 'theses' && /approves nothing/.test(i.message));
  const paths = (issues: Issues) => issues.map((i) => i.path.join('.'));

  function setFor(slotKey: string, entries: unknown[]) {
    return { tradingDay: '2026-07-14', slots: { [slotKey]: entries } };
  }

  function decision(slot: CycleSlot, theses: unknown[], approvedSetFault: string | null = null) {
    return {
      tradingDay: '2026-07-14',
      regimeName: CAMPAIGN.regimeName,
      slot,
      slotIndex: slot === 'intraday' ? 3 : null,
      marketState: 'risk_on',
      bias: theses.length > 0 ? 'long' : null,
      approvedSetFault,
      theses,
      projectedGrossExposurePct: 5,
      decisionRationale: 'Breakout setup on AAPL.',
    };
  }

  it('decide names the approved-set rule, and the runtime registers it as a runtime validator', () => {
    expect(task('decide').outputContract?.validatorRefs).toEqual([
      APPROVED_THESES_VALIDATOR_REF,
      'trading.thesis-arm-budget',
      'trading.regime-caps',
    ]);
    expect(lookupValidator(APPROVED_THESES_VALIDATOR_REF)?.kind).toBe('runtime');
    // The writer refusal names this workflow, so it must be the cycle's own slug.
    expect(CYCLE_WORKFLOW_SLUG).toBe(wf.slug);
    // A bad set never pauses decide: a paused run holds the cycle's one run
    // slot, and no later cycle could resolve. decide holds no blocked-signal.
    expect(wf.manifest?.concurrency?.maxConcurrentRuns ?? 1).toBe(1);
    const decideOps = wf.tasks.find((t) => t.taskId === 'decide')?.context?.capabilities
      ?.operations;
    expect(decideOps).not.toContain('agent.control.signal_blocked');
    // Resolution stays mechanical: no approved-set rule gates it.
    expect(task('resolve-theses').outputContract?.validatorRefs).not.toContain(
      APPROVED_THESES_VALIDATOR_REF,
    );
    expect(task('resolve-theses').outputContract?.derivedFrom ?? []).not.toContainEqual(
      expect.objectContaining({ from: 'decide' }),
    );
  });

  it('accepts a thesis that instantiates an approved entry of its own slot', async () => {
    const operatorSet = reader(setFor('open', [approvedEntry()]));
    expect(
      await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), operatorSet),
    ).toEqual([]);
    // An intraday cycle reads the entries under its own firing.
    const intraday = reader(setFor('intraday-3', [approvedEntry()]));
    expect(
      await approvedThesesIssues(decision('intraday', [thesis('aapl-2', null)]), intraday),
    ).toEqual([]);
    // A completed review run of another skill, named by every entry, approves too.
    const reviewed = reader(setFor('open', [approvedEntry()]), runWriter('strategy-desk'));
    expect(
      await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), reviewed),
    ).toEqual([]);
  });

  it('refuses a set the decide agent writes for itself, whatever it holds', async () => {
    // decide's own memory.store.put lands with its session, which belongs to the cycle run.
    const selfWritten = reader(
      setFor('open', [approvedEntry({ reviewRunId: 'run-cycle-0714' })]),
      runWriter(CYCLE_SLUG, { runId: 'run-cycle-0714', status: 'running' }),
    );
    const opened = await approvedThesesIssues(
      decision('open', [{ ...thesis('aapl-2', null), reviewRunId: 'run-cycle-0714' }]),
      selfWritten,
    );
    expect(refusesForFault(opened)).toBe(true);
    expect(opened[0]!.message).toContain('A cycle cannot approve its own theses');
    // An earlier cycle run cannot approve a later day's theses either, finished or not.
    const earlierCycle = reader(
      setFor('open', [approvedEntry()]),
      runWriter(CYCLE_SLUG, { status: 'completed' }),
    );
    expect(
      refusesForFault(
        await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), earlierCycle),
      ),
    ).toBe(true);
    // The fault must be named, so the cycle doc shows it.
    expect(paths(await approvedThesesIssues(decision('open', []), selfWritten))).toEqual([
      'approvedSetFault',
    ]);
    const named = decision('open', [], opened[0]!.message.split('. It approves nothing')[0]!);
    expect(await approvedThesesIssues(named, selfWritten)).toEqual([]);
  });

  it.each([
    ['an agent conversation that belongs to no run', conversation([])],
    // The conversation that drove the review run names that run in every entry.
    ['the session that drove the review run', conversation(['run-review-0714'])],
    [
      'a session tied to two runs',
      {
        ...runWriter('strategy-desk'),
        runs: [
          {
            runId: 'run-review-0714',
            workflowSlug: 'strategy-desk',
            status: 'completed',
            spaceId: SPACE,
          },
          {
            runId: 'run-review-0715',
            workflowSlug: 'strategy-desk',
            status: 'completed',
            spaceId: SPACE,
          },
        ],
      },
    ],
    ['a review run still in progress', runWriter('strategy-desk', { status: 'running' })],
    ['a review run of another space', runWriter('strategy-desk', { spaceId: 'space-2' })],
    ['a review run its entries do not name', runWriter('strategy-desk', { runId: 'run-other' })],
  ] as Array<[string, ApprovedSetWriter]>)(
    'refuses a set written by %s',
    async (_label, writer) => {
      const source = reader(setFor('open', [approvedEntry()]), writer);
      expect(
        refusesForFault(
          await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), source),
        ),
      ).toBe(true);
    },
  );

  it('a set that cannot be read or parsed opens nothing and is named, never passed as empty', async () => {
    const failing: ApprovedSetSource = {
      spaceId: SPACE,
      read: () => Promise.resolve({ status: 'unreadable', reason: 'connection reset' }),
    };
    const withTheses = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null)]),
      failing,
    );
    expect(refusesForFault(withTheses)).toBe(true);
    expect(withTheses[0]!.message).toContain('cannot be read (connection reset)');
    // An empty decision passes only when it names the fault.
    expect(paths(await approvedThesesIssues(decision('open', []), failing))).toEqual([
      'approvedSetFault',
    ]);
    const malformed = reader({ tradingDay: '2026-07-14', slots: { open: [{ approvedId: 'x' }] } });
    const otherDay = reader({ ...setFor('open', [approvedEntry()]), tradingDay: '2026-07-15' });
    for (const source of [failing, malformed, otherDay]) {
      expect(paths(await approvedThesesIssues(decision('open', []), source))).toEqual([
        'approvedSetFault',
      ]);
      expect(
        await approvedThesesIssues(decision('open', [], 'The approved set is faulted.'), source),
      ).toEqual([]);
    }
    // A sound set has no fault to name.
    const sound = reader(setFor('open', [approvedEntry()]));
    expect(paths(await approvedThesesIssues(decision('open', [], 'invented'), sound))).toEqual([
      'approvedSetFault',
    ]);
  });

  it('with a refused set, an open thesis still resolves on its invalidation level and closes', async () => {
    // Resolution reads no approved set: its contract names neither the rule nor the set.
    const resolveContract = JSON.stringify(task('resolve-theses').outputContract);
    expect(resolveContract).not.toContain(APPROVED_THESES_VALIDATOR_REF);
    expect(task('resolve-theses').goal ?? '').not.toContain('approved-theses.json');
    const resolved = resolveOutput('open', {
      resolutions: [
        {
          thesisId: 'msft-1',
          instrument: 'MSFT',
          direction: 'long',
          outcome: 'falsified',
          entryFillState: 'filled',
          evidence:
            'Close 401.20 < invalidation level 405.00 stated in the falsification criterion.',
          statedConfidence: 'medium',
          closePosition: true,
          closeQty: '10',
        },
      ],
    });
    expect(contractRefuses(task('resolve-theses'), { $campaign: CAMPAIGN }, resolved)).toBe(false);
    // decide meets a set a cycle run wrote for itself: it opens nothing and names the fault.
    const refused = reader(setFor('open', [approvedEntry()]), runWriter(CYCLE_SLUG));
    const [refusal] = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null)]),
      refused,
    );
    const fault = refusal!.message.split('. It approves nothing')[0]!;
    const decided = decision('open', [], fault);
    expect(await approvedThesesIssues(decided, refused)).toEqual([]);
    const decideSchema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolved,
    });
    expect(refuses(decideSchema, decided)).toBe(false);
    // The falsified thesis's close goes to the broker as on any cycle.
    const executeSchema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolved,
    });
    expect(refuses(executeSchema, closeOnly())).toBe(false);
    // The cycle records, and its doc names the fault and scores it.
    const recordSchema = effectiveOutputSchema(task('record'), recordSources(resolved, decided));
    const recorded = recordOutput([], ['/portfolio/theses/resolved/msft-1.json'], [], fault);
    expect(refuses(recordSchema, recorded)).toBe(false);
    expect(refuses(recordSchema, { ...recorded, approvedSetFaults: 0 })).toBe(true);
    expect(
      refuses(recordSchema, {
        ...recorded,
        cycleDoc: { ...recorded.cycleDoc, approvedSetFault: null },
      }),
    ).toBe(true);
    expect(
      getSkillCatalogEntry(CYCLE_SLUG)!.bundle.evalSuite?.taskCriteria['record'],
    ).toContainEqual({
      name: 'approved-set-sound',
      type: 'threshold',
      metric: 'approvedSetFaults',
      operator: 'lte',
      target: 0,
    });
  });

  it('refuses a thesis outside the approved set', async () => {
    const set = setFor('open', [
      approvedEntry(),
      approvedEntry({ approvedId: 'msft-fade-1', instrument: 'MSFT', reviewerVerdict: 'rejected' }),
    ]);
    const source = reader(set);
    const refusedIds = async (approvedId: string) =>
      (
        await approvedThesesIssues(
          decision('open', [thesis('aapl-2', null, 'breakout', approvedId)]),
          source,
        )
      )
        .map((i) => i.path.join('.'))
        .includes('theses.0.approvedId');
    // Unknown to the set.
    expect(await refusedIds('nvda-gap-1')).toBe(true);
    // In the set, but the review turned it down.
    expect(await refusedIds('msft-fade-1')).toBe(true);
    // Approved, but for another slot of the day.
    const otherSlot = reader(setFor('pre_market', [approvedEntry()]));
    const issues = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null)]),
      otherSlot,
    );
    expect(issues.length).toBeGreaterThan(0);
    // Approved, but the thesis departs from its entry.
    const departs = await approvedThesesIssues(
      decision('open', [
        { ...thesis('aapl-2', null), instrument: 'MSFT', sizePct: 8, reviewRunId: 'run-other' },
      ]),
      source,
    );
    expect(departs.map((i) => i.path.join('.')).sort()).toEqual([
      'theses.0.instrument',
      'theses.0.reviewRunId',
      'theses.0.sizePct',
    ]);
    // One approved entry opens one thesis.
    const twice = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null), thesis('aapl-3', null)]),
      source,
    );
    expect(twice.map((i) => i.path.join('.'))).toEqual(['theses.1.approvedId']);
  });

  it('a thesis opens only under the arm its approved entry names', async () => {
    const source = reader(setFor('open', [approvedEntry()]));
    const otherArm = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null, 'gap-fade')]),
      source,
    );
    expect(paths(otherArm)).toEqual(['theses.0.hypothesisId']);
    expect(otherArm[0]!.message).toContain('approved under arm "breakout"');
    // The arm stays a campaign id: the decide contract refuses one it does not declare.
    const schema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('open'),
    });
    expect(refuses(schema, decision('open', [thesis('aapl-2', null)]))).toBe(false);
    expect(refuses(schema, decision('open', [thesis('aapl-2', null, 'mean-reversion')]))).toBe(
      true,
    );
    // An entry that names no arm leaves the set unparsed, so it approves nothing.
    const { hypothesisId: _omitted, ...armless } = approvedEntry();
    const unparsed = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null)]),
      reader(setFor('open', [armless])),
    );
    expect(refusesForFault(unparsed)).toBe(true);
    expect(unparsed.find((i) => i.path.join('.') === 'theses')?.message).toContain('hypothesisId');
  });

  it.each([
    ['a missing approved set', undefined],
    ['an empty approved set', setFor('open', [])],
    [
      'a set with no approved verdict',
      setFor('open', [approvedEntry({ reviewerVerdict: 'revise' })]),
    ],
  ])('%s yields a resolve-only cycle', async (_label, content) => {
    const source = reader(content);
    const opened = await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), source);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.path).toEqual(['theses']);
    expect(opened[0]!.message).toContain('resolve-only');
    // Opening nothing passes: a slot with no approved entry is resolve-only by design.
    expect(await approvedThesesIssues(decision('open', []), source)).toEqual([]);
  });

  it('a resolve-only cycle still resolves, closes and records', () => {
    const resolved = resolveOutput('open', {
      resolutions: [
        {
          thesisId: 'msft-1',
          instrument: 'MSFT',
          direction: 'long',
          outcome: 'falsified',
          entryFillState: 'filled',
          evidence: 'Close 401.20 < stop level 405.00 stated in the falsification criterion.',
          statedConfidence: 'medium',
          closePosition: true,
          closeQty: '10',
        },
      ],
    });
    expect(contractRefuses(task('resolve-theses'), { $campaign: CAMPAIGN }, resolved)).toBe(false);
    const decided = decision('open', []);
    const decideSchema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolved,
    });
    expect(refuses(decideSchema, decided)).toBe(false);
    const executeSchema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolved,
    });
    expect(refuses(executeSchema, closeOnly())).toBe(false);
    const recordSchema = effectiveOutputSchema(task('record'), recordSources(resolved, decided));
    expect(
      refuses(recordSchema, recordOutput([], ['/portfolio/theses/resolved/msft-1.json'])),
    ).toBe(false);
  });

  it('execute-orders submits an entry only for a thesis that carries an approvedId', () => {
    const schema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolveOutput('open'),
    });
    const submitted = (overrides: Record<string, unknown>) => ({
      slot: 'open',
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
    expect(refuses(schema, submitted(close))).toBe(true);
  });

  it('the ledger carries the approvedId and the review run id on each opened thesis', () => {
    const decided = decision('open', [thesis('aapl-2', null)]);
    const schema = effectiveOutputSchema(
      task('record'),
      recordSources(resolveOutput('open'), decided),
    );
    const opened = ['/portfolio/theses/open/aapl-2.json'];
    const approval = {
      thesisId: 'aapl-2',
      approvedId: 'aapl-breakout-1',
      reviewRunId: 'run-review-0714',
    };
    expect(refuses(schema, recordOutput([approval], [], opened))).toBe(false);
    // An opened thesis with no approval recorded cannot pass.
    expect(refuses(schema, recordOutput([], [], opened))).toBe(true);
    const withoutRun = { thesisId: approval.thesisId, approvedId: approval.approvedId };
    expect(refuses(schema, recordOutput([withoutRun], [], opened))).toBe(true);
    // The open-thesis doc carries both, verbatim from the decision.
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    const doc = bundle.memorySeed[0]!.content;
    const openSection = doc.slice(doc.indexOf('## Open thesis'), doc.indexOf('## Deferred'));
    expect(openSection).toContain('"approvedId"');
    expect(openSection).toContain('"reviewRunId"');
    expect(doc).toContain('"openedApprovals"');
    expect(doc).toContain('/research/{tradingDay}/approved-theses.json');
    expect(wf.tasks.find((t) => t.taskId === 'record')?.goal).toContain(
      '`approvedId` and `reviewRunId` included',
    );
  });

  function recordSources(resolved: Record<string, unknown>, decided: Record<string, unknown>) {
    return {
      $campaign: CAMPAIGN,
      'resolve-theses': resolved,
      decide: decided,
      'execute-orders': { submittedCount: 1, deferredCount: 0, failedCount: 0 },
      'ingest-account': { equity: 100000, cash: 50000 },
    };
  }

  /** execute-orders on a cycle that opens nothing: the falsified MSFT thesis's close alone. */
  function closeOnly() {
    return {
      slot: 'open',
      orderResults: [
        orderResult({
          clientOrderId: '2026-07-14-open-msft-1-close',
          thesisId: 'msft-1',
          approvedId: null,
          intent: 'close',
          symbol: 'MSFT',
          side: 'sell',
          qty: '10',
          notional: null,
          entryCondition: null,
          disposition: 'submitted',
          statusCode: 200,
          orderId: 'c1',
          orderStatus: 'accepted',
          fillState: 'filled',
        }),
      ],
      submittedCount: 1,
      deferredCount: 0,
      failedCount: 0,
    };
  }

  function recordOutput(
    openedApprovals: unknown[],
    resolvedDocPaths: string[],
    openedDocPaths: string[] = [],
    approvedSetFault: string | null = null,
  ) {
    return {
      runSummary: 'Open cycle recorded.',
      approvedSetFaults: approvedSetFault === null ? 0 : 1,
      cycleCompleted: 1,
      thesesOpened: openedDocPaths.length,
      thesesResolved: resolvedDocPaths.length,
      grossExposurePct: 5,
      brokerGrossExposurePct: 5,
      cycleDoc: {
        tradingDay: '2026-07-14',
        slot: 'open',
        slotIndex: null,
        coverageNote: 'No slot missed since the last cycle.',
        thesesOpened: openedDocPaths.map((p) => p.replace(/^.*\/(.+)\.json$/, '$1')),
        openedApprovals,
        approvedSetFault,
        thesesResolved: [],
        submittedCount: 1,
        deferredCount: 0,
        failedCount: 0,
        projectedGrossExposurePct: 5,
        decisionRationale: 'Recorded the cycle.',
      },
      snapshotDoc: {
        equity: 100000,
        cash: 50000,
        positions: [],
        brokerGrossExposurePct: 5,
        grossExposurePct: 5,
        orphanFlattens: [],
        armTable: null,
      },
      cycleDocPath: '/portfolio/theses/cycles/2026-07-14-open.json',
      snapshotDocPath: '/portfolio/snapshots/2026-07-14-open.json',
      resolvedDocPaths,
      openedDocPaths,
      deletedOpenDocPaths: resolvedDocPaths.map((p) => p.replace('/resolved/', '/open/')),
      armTable: null,
    };
  }
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
    for (const needed of ['get_clock', 'get_account', 'get_positions', 'get_orders']) {
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

  it('says who writes the approved set and what the operator does until Strategy Desk ships', () => {
    const doc = bundle.memorySeed[0]!.content;
    const hints = bundle.helmsmanHints.join('\n');
    for (const text of [bundle.description, doc, hints]) {
      expect(text).toMatch(
        /Strategy Desk\*{0,2} skill,?( which will\nwrite it,)? ships in a later revision of this bundle/,
      );
      // Operator-facing text names the skill, never an internal plan.
      expect(text).not.toMatch(/Plan \d+|Part B/);
    }
    for (const text of [bundle.description, doc]) {
      expect(text).toContain('Nothing in this bundle writes');
    }
    expect(bundle.description).toContain('Before each trading day, write its approved set');
    expect(bundle.description).toContain('Store → Update opens no new thesis until a set exists');
    expect(doc).toContain('resolve-only cycle by\ndesign');
    expect(bundle.helmsmanHints.join('\n')).toContain('Never write it yourself');
    // An update must deliver the approved-set shape, so the contract doc is overwritten.
    expect(bundle.memorySeed[0]!.seedPolicy).toBe('overwrite');
  });

  it('setup notes and hints describe the four firings, staggered off round boundaries', () => {
    const text = [bundle.description, ...bundle.helmsmanHints].join('\n');
    for (const slot of ['pre_market', 'open', 'intraday', 'after_close']) {
      expect(text, slot).toContain(`slot: "${slot}"`);
    }
    for (const cron of ['47 8 * * 1-5', '37 9 * * 1-5', '7 10-15 * * 1-5', '23 16 * * 1-5']) {
      expect(text, cron).toContain(cron);
    }
    expect(text).toContain('staggered off round boundaries');
  });
});
