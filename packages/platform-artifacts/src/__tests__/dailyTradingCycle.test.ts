import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWhenExpression,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
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
  approvedThesesIssues,
  type ApprovedSetRead,
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
  universe: ['AAPL', 'MSFT', 'SPY'],
  maxThesesPerDay: 3,
  maxPositionSizePct: 8,
  maxGrossExposurePct: 60,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
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

function thesis(thesisId: string, entryCondition: string | null, approvedId = 'aapl-breakout-1') {
  return {
    thesisId,
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
    const m = /^(enum|value|count):\$\.([A-Za-z]+)(\[\*\])?$/.exec(b.binding);
    const source = sources[b.from];
    if (!m || !source) throw new Error(`no test source for binding ${b.bindingId}`);
    const raw = source[m[2]!];
    return {
      bindingId: b.bindingId,
      target: b.target,
      kind: (m[1] === 'value' ? 'const' : m[1]) as 'enum' | 'const' | 'count',
      value: (m[1] === 'count' ? (raw as unknown[]).length : raw) as never,
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
      'resolve-theses:value:$.slotIndex>$.slotIndex.const',
    ]);
    const byTarget = Object.fromEntries(fromCampaign.map((b) => [b.target, b.binding]));
    expect(byTarget).toEqual({
      '$.theses.items.instrument.enum': 'enum:$.universe[*]',
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
        'hypothesis',
        'maxGrossExposurePct',
        'maxPositionSizePct',
        'maxThesesPerDay',
        'minHorizonTradingDays',
        'maxHorizonTradingDays',
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

  it('carries exactly ONE prose strategy field (the hypothesis)', () => {
    const fields = entry.bundle.manifest.campaign!.fields;
    const proseFields = Object.entries(fields).filter(([key, f]) => {
      const schema = f.schema as { type?: string; pattern?: string; maxLength?: number };
      return key !== 'regimeName' && schema.type === 'string' && !schema.pattern;
    });
    expect(proseFields.map(([key]) => key)).toEqual(['hypothesis']);
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
      const decision = (theses: unknown[]) => ({
        tradingDay: resolved.tradingDay,
        slot,
        slotIndex: resolved.slotIndex,
        theses,
        projectedGrossExposurePct: 10,
        decisionRationale: 'Breakout setup on AAPL.',
      });
      expect(refuses(schema, decision([thesis('aapl-2', null)]))).toBe(false);
      expect(refuses(schema, decision([thesis('aapl-2', null), thesis('aapl-3', null)]))).toBe(
        true,
      );
    },
  );

  it('after_close: a cycle that forms a new entry is refused', () => {
    const schema = effectiveOutputSchema(task('decide'), {
      $campaign: CAMPAIGN,
      'resolve-theses': resolveOutput('after_close'),
    });
    const decision = (theses: unknown[]) => ({
      tradingDay: '2026-07-14',
      slot: 'after_close',
      slotIndex: null,
      theses,
      projectedGrossExposurePct: 10,
      decisionRationale: 'Recorded the close.',
    });
    expect(refuses(schema, decision([]))).toBe(false);
    expect(refuses(schema, decision([thesis('aapl-2', null)]))).toBe(true);
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

  /** A reader over an in-memory space: the set at its path, or no document at all. */
  function reader(content?: unknown) {
    const reads: string[] = [];
    const read = (path: string): Promise<ApprovedSetRead> => {
      reads.push(path);
      if (path !== SET_PATH || content === undefined) return Promise.resolve({ status: 'missing' });
      return Promise.resolve({ status: 'found', content });
    };
    return { read, reads };
  }

  function setFor(slotKey: string, entries: unknown[]) {
    return { tradingDay: '2026-07-14', slots: { [slotKey]: entries } };
  }

  function decision(slot: CycleSlot, theses: unknown[]) {
    return {
      tradingDay: '2026-07-14',
      slot,
      slotIndex: slot === 'intraday' ? 3 : null,
      theses,
      projectedGrossExposurePct: 5,
      decisionRationale: 'Breakout setup on AAPL.',
    };
  }

  it('decide names the approved-set rule, and the runtime registers it as a runtime validator', () => {
    expect(task('decide').outputContract?.validatorRefs).toEqual([APPROVED_THESES_VALIDATOR_REF]);
    expect(lookupValidator(APPROVED_THESES_VALIDATOR_REF)?.kind).toBe('runtime');
    // Resolution stays mechanical: no approved-set rule gates it.
    expect(task('resolve-theses').outputContract?.validatorRefs).not.toContain(
      APPROVED_THESES_VALIDATOR_REF,
    );
    expect(task('resolve-theses').outputContract?.derivedFrom ?? []).not.toContainEqual(
      expect.objectContaining({ from: 'decide' }),
    );
  });

  it('accepts a thesis that instantiates an approved entry of its own slot', async () => {
    const { read } = reader(setFor('open', [approvedEntry()]));
    expect(await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), read)).toEqual(
      [],
    );
    // An intraday cycle reads the entries under its own firing.
    const intraday = reader(setFor('intraday-3', [approvedEntry()]));
    expect(
      await approvedThesesIssues(decision('intraday', [thesis('aapl-2', null)]), intraday.read),
    ).toEqual([]);
  });

  it('refuses a thesis outside the approved set', async () => {
    const set = setFor('open', [
      approvedEntry(),
      approvedEntry({ approvedId: 'msft-fade-1', instrument: 'MSFT', reviewerVerdict: 'rejected' }),
    ]);
    const { read } = reader(set);
    const refusedIds = async (approvedId: string) =>
      (await approvedThesesIssues(decision('open', [thesis('aapl-2', null, approvedId)]), read))
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
      otherSlot.read,
    );
    expect(issues.length).toBeGreaterThan(0);
    // Approved, but the thesis departs from its entry.
    const departs = await approvedThesesIssues(
      decision('open', [
        { ...thesis('aapl-2', null), instrument: 'MSFT', sizePct: 8, reviewRunId: 'run-other' },
      ]),
      read,
    );
    expect(departs.map((i) => i.path.join('.')).sort()).toEqual([
      'theses.0.instrument',
      'theses.0.reviewRunId',
      'theses.0.sizePct',
    ]);
    // One approved entry opens one thesis.
    const twice = await approvedThesesIssues(
      decision('open', [thesis('aapl-2', null), thesis('aapl-3', null)]),
      read,
    );
    expect(twice.map((i) => i.path.join('.'))).toEqual(['theses.1.approvedId']);
  });

  it.each([
    ['a missing approved set', undefined],
    ['an empty approved set', setFor('open', [])],
    [
      'a set with no approved verdict',
      setFor('open', [approvedEntry({ reviewerVerdict: 'revise' })]),
    ],
  ])('%s yields a resolve-only cycle', async (_label, content) => {
    const { read } = reader(content);
    const opened = await approvedThesesIssues(decision('open', [thesis('aapl-2', null)]), read);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.path).toEqual(['theses']);
    expect(opened[0]!.message).toContain('resolve-only');
    // Opening nothing passes, and never needs the set.
    const fresh = reader(content);
    expect(await approvedThesesIssues(decision('open', []), fresh.read)).toEqual([]);
    expect(fresh.reads).toEqual([]);
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
    const executed = {
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
    const executeSchema = effectiveOutputSchema(task('execute-orders'), {
      'resolve-theses': resolved,
    });
    expect(refuses(executeSchema, executed)).toBe(false);
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
      'resolve-theses': resolved,
      decide: decided,
      'execute-orders': { submittedCount: 1, deferredCount: 0, failedCount: 0 },
      'ingest-account': { equity: 100000, cash: 50000 },
    };
  }

  function recordOutput(
    openedApprovals: unknown[],
    resolvedDocPaths: string[],
    openedDocPaths: string[] = [],
  ) {
    return {
      runSummary: 'Open cycle recorded.',
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
      },
      cycleDocPath: '/portfolio/theses/cycles/2026-07-14-open.json',
      snapshotDocPath: '/portfolio/snapshots/2026-07-14-open.json',
      resolvedDocPaths,
      openedDocPaths,
      deletedOpenDocPaths: resolvedDocPaths.map((p) => p.replace('/resolved/', '/open/')),
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
