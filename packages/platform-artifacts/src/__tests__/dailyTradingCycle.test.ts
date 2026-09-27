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
  mergeDerivedPatches,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';

const CYCLE_SLUG = 'daily-trading-cycle';
const PROCEED_GATE = 'tasks.resolve-theses.output.proceed == true';

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
    expect(derived.every((b) => b.from === '$campaign')).toBe(true);
    const byTarget = Object.fromEntries(derived.map((b) => [b.target, b.binding]));
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
    const config = {
      universe: ['AAPL', 'MSFT', 'SPY'],
      maxThesesPerDay: 3,
      maxPositionSizePct: 8,
      maxGrossExposurePct: 60,
      minHorizonTradingDays: 1,
      maxHorizonTradingDays: 5,
    };
    const decide = task('decide')!;
    const patches = (decide.outputContract?.derivedFrom ?? []).map((b) => {
      const m = /^(enum|value|count):\$\.(.+?)(\[\*\])?$/.exec(b.binding)!;
      const field = m[2] as keyof typeof config;
      return {
        bindingId: b.bindingId,
        target: b.target,
        kind: (m[1] === 'value' ? 'const' : m[1]) as 'enum' | 'const' | 'count',
        value: config[field] as never,
      };
    });
    const { effectiveSchema } = mergeDerivedPatches(
      decide.outputContract!.schema as Record<string, unknown>,
      patches,
    );
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

  it('runs need no per-run inputs — cycle identity is derived, config is the campaign', () => {
    for (const t of wf.tasks) {
      const bindings = Object.values(t.inputBindings ?? {});
      expect(
        bindings.every((b) => (b as { kind: string }).kind !== 'run_input'),
        t.taskId,
      ).toBe(true);
    }
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
    expect(goal).toContain('/portfolio/theses/cycles/{tradingDay}-{slot}.json');
  });

  it('the slot taxonomy matches the scheduled cadence exactly (morning, after_close)', () => {
    const schema = task('resolve-theses')?.outputContract?.schema as {
      properties: { slot: { enum: string[] } };
    };
    expect(schema.properties.slot.enum).toEqual(['morning', 'after_close']);
    const goal = task('resolve-theses')?.goal ?? '';
    // A slot the schedule never fires (the old pre_open) would make every
    // cycle's coverageNote report a permanently-missed slot — pure noise.
    expect(goal).not.toContain('pre_open');
    expect(goal).not.toContain('intraday');
    expect(goal).toContain('slot: "morning"');
    expect(goal).toContain('slot: "after_close"');
    // Coverage compares against the SCHEDULED slot set, not all conceivable slots.
    expect(goal).toContain('two SCHEDULED slots per trading day');
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
    expect(doc).toContain('/portfolio/theses/cycles/{tradingDay}-{slot}.json');
    expect(doc).toContain('/portfolio/snapshots/{tradingDay}-{slot}.json');
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
    // The ledger carries the same two-slot taxonomy as the skill contract.
    expect(doc).toContain('morning | after_close');
    expect(doc).not.toContain('pre_open');
    expect(doc).not.toContain('intraday');
  });
});
