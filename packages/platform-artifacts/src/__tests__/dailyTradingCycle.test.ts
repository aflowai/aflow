import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
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
  type ThesisLedgerDoc,
} from '@aflow/cybernetic-runtime';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  SkillComposeBundleSchema,
  getOperation,
  getValidator,
  mergeDerivedPatches,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';
import AjvModule from 'ajv';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { INTRADAY_INDEX_RULE } from '../skillCatalog/dailyTradingCycleSlots.js';

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
    maxThesesPerDay: 3,
    thesesOpenedToday: [],
    remainingThesesToday: slot === 'after_close' ? 0 : 3,
    coverageNote: 'No slot missed since the last cycle.',
    ...overrides,
  };
}

function thesis(thesisId: string, entryCondition: string | null, hypothesisId = 'breakout') {
  return {
    thesisId,
    hypothesisId,
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
    const source = sources[b.from];
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

  it('has the expected 11-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'ingest-clock',
        'ingest-account',
        'ingest-positions',
        'ingest-orders',
        'resolve-theses',
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

  it('daily bars are cached locally: cache-first prose + write grant on both price-reading tasks', () => {
    for (const id of ['resolve-theses', 'decide']) {
      const ops = task(id)?.context?.capabilities?.operations ?? [];
      expect(ops, id).toContain('memory.store.put');
      const goal = task(id)?.goal ?? '';
      expect(goal, id).toContain('/portfolio/market-data/{symbol}.json');
      expect(goal.toLowerCase(), id).toContain('cache-first');
      // An open-market fetch returns the day's still-forming bar; caching it
      // would freeze a partial OHLC as that session's permanent truth.
      expect(goal, id).toContain('Only COMPLETED sessions enter the cache');
    }
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
      decide: { theses: [] },
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
    const table = { regimeName: CAMPAIGN.regimeName, legacyDocsExcluded: 0, arms: expected };

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
        { path: bareDoc.path, reason: 'it has no hypothesisId', writtenThisCycle: false },
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
        decide: { theses: cycle.theses ?? [] },
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

    describe('after a campaign written before hypothesis arms', () => {
      // Docs the old skill version wrote: no regimeName, no hypothesisId.
      const legacyOpen: ThesisLedgerDoc = {
        path: '/portfolio/theses/open/legacy-1.json',
        content: JSON.stringify({ thesisId: 'legacy-1', openedTradingDay: '2026-07-14' }),
      };
      const legacyResolved = (thesisId: string): ThesisLedgerDoc => ({
        path: `/portfolio/theses/resolved/${thesisId}.json`,
        content: JSON.stringify({ thesisId, openedTradingDay: '2026-07-08', outcome: 'expired' }),
      });
      const withLegacy = [...ledger, legacyOpen, legacyResolved('legacy-0')];

      it('excludes the legacy docs from every arm and reports how many', () => {
        const reading = readLedgerTheses(withLegacy);
        expect(reading.refused).toEqual([]);
        expect(reading.legacy.map((doc) => doc.path)).toEqual([
          legacyOpen.path,
          '/portfolio/theses/resolved/legacy-0.json',
        ]);
        const output = (armTable: unknown) => ({ armTable, snapshotDoc: { armTable } });
        expect(armTableIssues(output({ ...table, legacyDocsExcluded: 2 }), withLegacy)).toEqual([]);
        expect(armTableIssues(output(table), withLegacy)).toEqual([
          expect.objectContaining({ path: ['armTable', 'legacyDocsExcluded'] }),
        ]);
        expect(armTableIssues(output(null), withLegacy)).toEqual([]);
      });

      it('runs the cycle end to end on the new campaign with the legacy docs in the ledger', () => {
        const scope = { hypotheses: CAMPAIGN.hypotheses, docs: withLegacy };
        expect(armBudgetIssues(decision('open', [thesis('aapl-2', null)]), scope)).toEqual([]);

        // The open cycle opens a thesis of the new campaign and resolves the
        // legacy one, whose resolved doc copies a doc that names no arm.
        const afterOpen = [
          ...ledger,
          openDoc('aapl-2', 'breakout', '2026-07-14'),
          legacyResolved('legacy-1'),
          legacyResolved('legacy-0'),
        ];
        const openSchema = schemaFor('open', {
          theses: [thesis('aapl-2', null)],
          resolutions: [{ thesisId: 'legacy-1' }],
        });
        const writes = {
          opened: ['aapl-2'],
          resolved: [{ thesisId: 'legacy-1', outcome: 'expired' }],
        };
        const openRecord = recordOutput('open', null, writes);
        expect(refuses(openSchema, openRecord)).toBe(false);
        expect(armTableIssues(openRecord, afterOpen)).toEqual([]);
        const invented = recordOutput('open', null, {
          ...writes,
          resolved: [{ thesisId: 'legacy-1', hypothesisId: 'breakout', outcome: 'expired' }],
        });
        expect(armTableIssues(invented, afterOpen)).toEqual([
          expect.objectContaining({ path: ['cycleDoc', 'thesesResolved', 0, 'hypothesisId'] }),
        ]);

        const [breakout, gapFade] = expected;
        const closeTable = {
          ...table,
          legacyDocsExcluded: 2,
          arms: [{ ...breakout!, opened: 5, open: 2 }, gapFade],
        };
        const closeRecord = recordOutput('after_close', closeTable);
        expect(refuses(schemaFor('after_close'), closeRecord)).toBe(false);
        expect(armTableIssues(closeRecord, afterOpen)).toEqual([]);
      });

      it('refuses a doc this cycle opened without the arm fields, naming the remedy it can carry out', () => {
        const bare = {
          path: '/portfolio/theses/open/aapl-2.json',
          content: JSON.stringify({ thesisId: 'aapl-2', openedTradingDay: '2026-07-14' }),
        };
        const record = recordOutput('open', null, { opened: ['aapl-2'] });
        expect(armTableIssues(record, [...withLegacy, bare])).toEqual([
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
