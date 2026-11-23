import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { compileRestrictedPath, evaluateCount, evaluateEnum, evaluateValue } from '@aflow/lib';
import {
  DerivedSchemaMergeError,
  MemoryPutInputSchema,
  mergeDerivedPatches,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { ALPACA_THESIS_TRADING } from '../skillBundleCatalog/alpacaThesisTrading.js';
import {
  CLOSE_REPORT_AGENT_TASK_IDS,
  CLOSE_REPORT_PATH_TEMPLATE,
  CLOSE_REPORT_SECTIONS,
  CLOSE_REPORT_TASK_IDS,
  READ_CLOSE_CYCLE_DOC_TASK_ID,
  READ_DAY_RESOLUTIONS_TASK_ID,
  READ_REFLECTION_TASK_ID,
  RECORD_REFLECTION_TASK_ID,
  REFLECT_TASK_ID,
  WRITE_CLOSE_REPORT_TASK_ID,
} from '../skillCatalog/dailyTradingCycleCloseReport.js';
import {
  CLOSE_REASONS_VALIDATOR_REF,
  closeReasonIssues,
  DAY_RESOLUTIONS_VALIDATOR_REF,
  dayResolutionIssues,
  readDayResolutions,
  type CycleLedgerDoc,
} from '../skillCatalog/dailyTradingCycleDayResolutions.js';
import { failWith, runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const entry = getSkillCatalogEntry('daily-trading-cycle')!;
const wf = entry.bundle.workflow;
type Task = (typeof wf.tasks)[number];
const task = (id: string): Task => wf.tasks.find((t) => t.taskId === id)!;
const TASKS = wf.tasks as unknown as WorkflowTask[];

const TRADING_DAY = '2026-07-14';
const REPORT_PATH = `/portfolio/close-reports/${TRADING_DAY}.md`;
const REFLECTION_PATH = `/portfolio/theses/reflections/${TRADING_DAY}-after_close.json`;
const CYCLES = '/portfolio/theses/cycles/';
const CAMPAIGN = {
  regimeName: 'momentum-and-reversion-1',
  hypotheses: [{ id: 'breakout' }, { id: 'gap-fade' }],
  maxThesesPerDay: 3,
  maxGrossExposurePct: 60,
};

type Slot = 'pre_market' | 'open' | 'intraday' | 'after_close';

/** What each slot's cycle resolves: the open cycle one thesis, the after_close cycle another. */
const RESOLVED_BY: Record<Slot, Array<Record<string, unknown>>> = {
  pre_market: [],
  open: [
    {
      thesisId: 'msft-long',
      hypothesisId: 'gap-fade',
      outcome: 'confirmed',
      statedConfidence: 'high',
      lenses: null,
    },
  ],
  intraday: [],
  after_close: [
    {
      thesisId: 'aapl-long',
      hypothesisId: 'breakout',
      outcome: 'falsified',
      statedConfidence: 'medium',
      lenses: null,
    },
  ],
};

/** What each slot's cycle opens: the pre_market cycle forms both theses of the day. */
const OPENED_BY: Record<Slot, string[]> = {
  pre_market: ['aapl-long', 'msft-long'],
  open: [],
  intraday: [],
  after_close: [],
};

const REASON_OF: Record<string, string> = {
  'aapl-long': 'Closed at 183.10, below the 184.00 falsification level.',
  'msft-long': 'Traded at 431.20, above the 430.00 confirmation level.',
};

const CHANGES = [
  {
    observation: 'The only breakout thesis to resolve was falsified within one session.',
    evidence: [
      { path: '/portfolio/theses/resolved/aapl-long.json', field: 'outcome', value: 'falsified' },
    ],
  },
];

function resolveOutput(slot: Slot, proceed = true, thesesOpenedToday = ['aapl-long', 'msft-long']) {
  return {
    tradingDay: TRADING_DAY,
    slot,
    slotIndex: slot === 'intraday' ? 3 : null,
    proceed,
    noopReason: proceed ? null : 'This (tradingDay, slot) cycle is already recorded.',
    resolutions: [],
    openThesesAfter: [],
    pendingIntentions: [],
    repairCloses: [],
    orphanFlattens: [],
    maxThesesPerDay: 3,
    thesesOpenedToday,
    remainingThesesToday: slot === 'after_close' ? 0 : 1,
    coverageNote: 'No slot missed since the last cycle.',
  };
}

const ARM_TABLE = {
  regimeName: CAMPAIGN.regimeName,
  arms: [
    {
      hypothesisId: 'breakout',
      opened: 1,
      open: 0,
      resolved: { confirmed: 0, falsified: 1, expired: 0, entry_failed: 0, tactical_exit: 0 },
    },
    {
      hypothesisId: 'gap-fade',
      opened: 1,
      open: 0,
      resolved: { confirmed: 1, falsified: 0, expired: 0, entry_failed: 0, tactical_exit: 0 },
    },
  ],
};

function recordOutput(slot: Slot) {
  const slotKey = slot === 'intraday' ? 'intraday-3' : slot;
  return {
    runSummary: `${TRADING_DAY} ${slot}: ${String(RESOLVED_BY[slot].length)} resolved.`,
    cycleCompleted: 1,
    thesesOpened: OPENED_BY[slot].length,
    thesesResolved: RESOLVED_BY[slot].length,
    cycleDocPath: `${CYCLES}${TRADING_DAY}-${slotKey}.json`,
    snapshotDocPath: `/portfolio/snapshots/${TRADING_DAY}-${slotKey}.json`,
    cycleDoc: {
      tradingDay: TRADING_DAY,
      slot,
      slotIndex: slot === 'intraday' ? 3 : null,
      coverageNote: 'No slot missed since the last cycle.',
      thesesOpened: OPENED_BY[slot],
      openedApprovals: [],
      approvedSetFault: null,
      thesesResolved: RESOLVED_BY[slot],
      submittedCount: 1,
      deferredCount: 0,
      failedCount: 0,
      projectedGrossExposurePct: 4.2,
      decisionRationale: 'No thesis opens.',
    },
    snapshotDoc: {
      equity: 100000,
      cash: 95000,
      positions: [],
      brokerGrossExposurePct: 5,
      grossExposurePct: 5,
      orphanFlattens: [],
      armTable: slot === 'after_close' ? ARM_TABLE : null,
    },
  };
}

/** A space's memory: documents by path, as the put and get operations reach them. */
type Memory = Map<string, unknown>;

/** The space's cycle docs as the runtime reads them: each path and its JSON text. */
const cycleDocsOf = (memory: Memory): CycleLedgerDoc[] =>
  [...memory]
    .filter(([path]) => path.startsWith(CYCLES))
    .map(([path, doc]) => ({ path, content: JSON.stringify(doc) }));

/** The reflection a faithful agent gives: one reason per resolution of the day it was handed. */
function reflectionFor(input: Record<string, unknown>) {
  const resolutions = input['dayResolutions'] as Array<Record<string, string>>;
  return {
    tradingDay: input['tradingDay'],
    slot: 'after_close',
    reasons: resolutions.map((r) => ({
      thesisId: r['thesisId'],
      hypothesisId: r['hypothesisId'],
      outcome: r['outcome'],
      slotKey: r['slotKey'],
      reason: REASON_OF[r['thesisId']!],
    })),
    candidateChanges: CHANGES,
  };
}

interface CycleOptions {
  proceed?: boolean;
  /** Fails decide with this reason, which the cycle doc records as its decisionFault. */
  decideFault?: string;
  /** What resolve-theses answers as the day's openings, whatever the cycle docs record. */
  thesesOpenedToday?: string[];
}

function answer(memory: Memory, slot: Slot, options: CycleOptions) {
  return (taskId: string, input: Record<string, unknown>): TaskAnswer => {
    const operation = task(taskId).operation;
    if (operation === 'memory.store.put') {
      const path = String(input['path']);
      if (input['writeMode'] === 'create' && memory.has(path)) {
        return failWith(`MEMORY_ALREADY_EXISTS: ${path}`);
      }
      const content = input['content'] as { inlineJson?: unknown; inlineText?: unknown };
      memory.set(path, content.inlineJson ?? content.inlineText);
      return { path };
    }
    if (operation === 'memory.store.get') {
      const path = (input['target'] as { path: string }).path;
      return memory.has(path) ? { found: true, dataJson: memory.get(path) } : { found: false };
    }
    switch (taskId) {
      case 'ingest-clock':
        return {
          data: {
            timestamp: `${TRADING_DAY}T20:30:00Z`,
            is_open: false,
            next_open: '2026-07-15T13:30:00Z',
            next_close: '2026-07-15T20:00:00Z',
          },
        };
      case 'ingest-account':
        return {
          data: { equity: '100000', cash: '95000', buying_power: '190000', status: 'ACTIVE' },
        };
      case 'ingest-positions':
      case 'ingest-orders':
        return { data: [] };
      case 'resolve-theses':
        return resolveOutput(slot, options.proceed ?? true, options.thesesOpenedToday);
      // The harness derives gather-regime, so `answer` never sees it. With
      // both reads failed it refuses, and the cycle decides unavailable.
      case 'ingest-calendar':
      case 'read-index-bars':
      case 'read-universe-bars':
        return 'fail';
      case 'decide':
        return options.decideFault === undefined
          ? { marketState: input['marketState'], slot, theses: [] }
          : failWith(options.decideFault);
      case 'execute-orders':
        return { orderResults: [], submittedCount: 1, deferredCount: 0, failedCount: 0 };
      case 'record':
        return recordOutput(slot);
      case READ_DAY_RESOLUTIONS_TASK_ID: {
        const tradingDay = String(input['tradingDay']);
        const reading = readDayResolutions(cycleDocsOf(memory), tradingDay);
        return { tradingDay, resolutions: reading.resolutions, thesesOpened: reading.opened };
      }
      case REFLECT_TASK_ID:
        return reflectionFor(input);
      default:
        return {};
    }
  };
}

function runCycle(memory: Memory, slot: Slot, options: CycleOptions = {}) {
  return runSkillTasks(TASKS, { slot }, answer(memory, slot, options), undefined, {
    campaign: CAMPAIGN,
  });
}

/**
 * A day whose pre_market cycle opened aapl-long and msft-long, whose open
 * cycle resolved msft-long and whose after_close cycle resolved aapl-long.
 */
function closedDay(afterClose: CycleOptions = {}) {
  const memory: Memory = new Map();
  runCycle(memory, 'pre_market');
  runCycle(memory, 'open');
  const run = runCycle(memory, 'after_close', afterClose);
  return { memory, run, reflectInput: run.inputs.get(REFLECT_TASK_ID)! };
}

/** The reflect contract as delegation derives it from the run's own reads. */
function reflectSchema(reflectInput: Record<string, unknown>, slot: Slot = 'after_close') {
  const sources: Record<string, unknown> = {
    $campaign: CAMPAIGN,
    'resolve-theses': resolveOutput(slot),
    [READ_CLOSE_CYCLE_DOC_TASK_ID]: { cycleDoc: reflectInput['cycleDoc'] },
    [READ_DAY_RESOLUTIONS_TASK_ID]: {
      tradingDay: reflectInput['tradingDay'],
      resolutions: reflectInput['dayResolutions'],
    },
  };
  const t = task(REFLECT_TASK_ID);
  const patches = (t.outputContract?.derivedFrom ?? []).map((b) => {
    const m = /^(enum|value|count):(.+)$/.exec(b.binding)!;
    const path = compileRestrictedPath(m[2]!);
    const kind = m[1] as 'enum' | 'value' | 'count';
    const source = sources[b.from];
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

const refuses = (schema: Record<string, unknown>, output: unknown) => !ajv.compile(schema)(output);

/** Each close report section by its heading, its JSON block parsed. */
function reportSections(text: string): Record<string, unknown> {
  return Object.fromEntries(
    text
      .split('\n## ')
      .slice(1)
      .map((part) => {
        const heading = part.slice(0, part.indexOf('\n'));
        const block = /```json\n([\s\S]*?)\n```/.exec(part)![1]!;
        return [heading, JSON.parse(block) as unknown];
      }),
  );
}

const reportOf = (memory: Memory) => reportSections(String(memory.get(REPORT_PATH)));

const [RESOLVED, METRICS, ARMS, COST, CHANGES_SECTION] = CLOSE_REPORT_SECTIONS;

describe('daily-trading-cycle close report', () => {
  it('runs only on after_close: every other slot skips the close report tasks', () => {
    for (const slot of ['pre_market', 'open', 'intraday'] as const) {
      const memory: Memory = new Map();
      const run = runCycle(memory, slot);
      expect(run.statuses.get('write-cycle-doc'), slot).toBe('succeeded');
      for (const id of CLOSE_REPORT_TASK_IDS) {
        expect(run.statuses.get(id), `${slot} ${id}`).toBe('skipped');
        expect(run.ran, `${slot} ${id}`).not.toContain(id);
      }
      expect(
        [...memory.keys()].filter(
          (path) =>
            path.startsWith('/portfolio/close-reports/') ||
            path.startsWith('/portfolio/theses/reflections/'),
        ),
        slot,
      ).toEqual([]);
    }
    const memory: Memory = new Map();
    const run = runCycle(memory, 'after_close');
    for (const id of CLOSE_REPORT_TASK_IDS) expect(run.statuses.get(id), id).toBe('succeeded');
    expect(run.ran.indexOf(READ_CLOSE_CYCLE_DOC_TASK_ID)).toBeGreaterThan(
      run.ran.indexOf('write-cycle-doc'),
    );
  });

  it('covers the whole trading day: a thesis the open cycle resolved appears with its slot', () => {
    const { memory, reflectInput } = closedDay();
    // The reflection's inputs carry every resolution of the day, keyed by the
    // cycle doc that recorded it.
    expect(reflectInput['dayResolutions']).toEqual([
      {
        cycleDocPath: `${CYCLES}${TRADING_DAY}-after_close.json`,
        slotKey: 'after_close',
        thesisId: 'aapl-long',
        hypothesisId: 'breakout',
        outcome: 'falsified',
      },
      {
        cycleDocPath: `${CYCLES}${TRADING_DAY}-open.json`,
        slotKey: 'open',
        thesisId: 'msft-long',
        hypothesisId: 'gap-fade',
        outcome: 'confirmed',
      },
    ]);
    const report = reportOf(memory);
    expect(report[RESOLVED]).toEqual([
      {
        thesisId: 'aapl-long',
        hypothesisId: 'breakout',
        outcome: 'falsified',
        slotKey: 'after_close',
        reason: REASON_OF['aapl-long'],
      },
      {
        thesisId: 'msft-long',
        hypothesisId: 'gap-fade',
        outcome: 'confirmed',
        slotKey: 'open',
        reason: REASON_OF['msft-long'],
      },
    ]);
    expect(report[METRICS]).toMatchObject({ thesesResolved: 2 });
  });

  it('a duplicate after_close trigger reuses the recorded reflection and runs no agent', () => {
    const { memory } = closedDay();
    const report = memory.get(REPORT_PATH);
    const reflection = memory.get(REFLECTION_PATH);
    expect(typeof report).toBe('string');
    expect(reflection).toMatchObject({ tradingDay: TRADING_DAY, slot: 'after_close' });

    // The duplicate trigger finds the cycle recorded: it decides, orders and
    // records nothing, and it finds the reflection recorded too. Its
    // resolve-theses answers other openings, and the report holds none of them.
    const rerun = runCycle(memory, 'after_close', {
      proceed: false,
      thesesOpenedToday: ['aapl-long', 'msft-long', 'nvda-long', 'tsla-short'],
    });
    for (const id of ['decide', 'execute-orders', 'record', 'write-cycle-doc']) {
      expect(rerun.statuses.get(id), id).toBe('skipped');
    }
    for (const id of [...CLOSE_REPORT_AGENT_TASK_IDS, RECORD_REFLECTION_TASK_ID]) {
      expect(rerun.statuses.get(id), id).toBe('skipped');
      expect(rerun.ran, id).not.toContain(id);
    }
    expect(rerun.statuses.get(WRITE_CLOSE_REPORT_TASK_ID)).toBe('succeeded');
    expect(rerun.inputs.get(WRITE_CLOSE_REPORT_TASK_ID)!['writeMode']).toBe('upsert');
    expect(memory.get(REPORT_PATH)).toBe(report);
    expect(memory.get(REFLECTION_PATH)).toBe(reflection);
    expect(
      [...memory.keys()].filter((path) => path.startsWith('/portfolio/close-reports/')),
    ).toEqual([REPORT_PATH]);
  });

  it('the close report carries five sections, every metric bound from the docs', () => {
    const { memory, run } = closedDay();
    const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_CLOSE_REPORT_TASK_ID));
    expect(put.path).toBe(REPORT_PATH);
    expect(put.docType).toBe('markdown');
    const text = put.content.inlineText!;
    expect(text.startsWith(`# Close report ${TRADING_DAY}\n`)).toBe(true);
    const cycleDoc = memory.get(`${CYCLES}${TRADING_DAY}-after_close.json`) as Record<
      string,
      unknown
    >;
    const report = reportSections(text);
    expect(Object.keys(report)).toEqual([...CLOSE_REPORT_SECTIONS]);
    expect(report).toEqual({
      [RESOLVED]: reflectionFor(run.inputs.get(REFLECT_TASK_ID)!).reasons,
      [METRICS]: {
        thesesFormed: 2,
        maxThesesPerDay: 3,
        thesesResolved: 2,
        grossExposurePct: 5,
        maxGrossExposurePct: 60,
        marketState: cycleDoc['marketState'],
        approvedSetFault: null,
        decisionFault: null,
        preMarketFault: null,
      },
      [ARMS]: ARM_TABLE,
      [COST]: {
        submittedCount: 1,
        deferredCount: 0,
        failedCount: 0,
        projectedGrossExposurePct: 4.2,
      },
      [CHANGES_SECTION]: CHANGES,
    });
    // The reflection carries only the reasons and the candidate changes.
    expect(
      Object.keys(task(REFLECT_TASK_ID).outputContract!.schema!['properties'] as object),
    ).toEqual(['tradingDay', 'slot', 'reasons', 'candidateChanges']);
  });

  it('counts the theses formed from the cycle docs, whatever resolve-theses answers', () => {
    const { memory } = closedDay({
      thesesOpenedToday: ['aapl-long', 'msft-long', 'nvda-long', 'tsla-short', 'amzn-long'],
    });
    const recorded = readDayResolutions(cycleDocsOf(memory), TRADING_DAY);
    expect(recorded.opened.map((o) => o.thesisId)).toEqual(['aapl-long', 'msft-long']);
    expect(reportOf(memory)[METRICS]).toMatchObject({
      thesesFormed: recorded.opened.length,
      thesesResolved: recorded.resolutions.length,
    });
    // No figure of the report comes from resolve-theses.
    const write = task(WRITE_CLOSE_REPORT_TASK_ID);
    for (const binding of Object.values(write.inputBindings ?? {})) {
      if ('taskId' in binding) expect(binding.taskId).not.toBe('resolve-theses');
    }
    expect(JSON.stringify(task(REFLECT_TASK_ID).inputBindings)).not.toContain('thesesOpenedToday');
  });

  it('writes the close report with a 4000-character fault string in the cycle doc', () => {
    const fault = `decide failed: ${'x'.repeat(3985)}`;
    expect(fault).toHaveLength(4000);
    const memory: Memory = new Map();
    const run = runCycle(memory, 'after_close', { decideFault: fault });
    const cycleDoc = memory.get(`${CYCLES}${TRADING_DAY}-after_close.json`) as Record<
      string,
      unknown
    >;
    expect(cycleDoc['decisionFault']).toBe(fault);
    expect(run.statuses.get(WRITE_CLOSE_REPORT_TASK_ID)).toBe('succeeded');
    expect(reportOf(memory)[METRICS]).toMatchObject({ decisionFault: fault });
  });

  it('the reflect contract pins its day and slot and holds one reason per resolution', () => {
    const { reflectInput } = closedDay();
    const schema = reflectSchema(reflectInput);
    const reflection = reflectionFor(reflectInput);
    expect(refuses(schema, reflection)).toBe(false);
    expect(refuses(schema, { ...reflection, tradingDay: '2026-07-13' })).toBe(true);
    expect(refuses(schema, { ...reflection, reasons: reflection.reasons.slice(1) })).toBe(true);
    expect(
      refuses(schema, { ...reflection, reasons: [...reflection.reasons, reflection.reasons[0]] }),
    ).toBe(true);
    // A reflection carries no metric for an agent to copy.
    expect(refuses(schema, { ...reflection, processMetrics: {} })).toBe(true);
    // A candidate change is an observation tied to a ledger doc.
    const change = CHANGES[0]!;
    expect(
      refuses(schema, { ...reflection, candidateChanges: [{ ...change, evidence: [] }] }),
    ).toBe(true);
    expect(
      refuses(schema, {
        ...reflection,
        candidateChanges: [
          { ...change, evidence: [{ ...change.evidence[0]!, path: '/notes/x.md' }] },
        ],
      }),
    ).toBe(true);
    expect(
      refuses(schema, {
        ...reflection,
        candidateChanges: [{ ...change, decision: 'raise the cap' }],
      }),
    ).toBe(true);
    for (const slot of ['pre_market', 'open', 'intraday'] as const) {
      expect(() => reflectSchema(reflectInput, slot), slot).toThrow(DerivedSchemaMergeError);
    }
  });

  it('the reflect contract pins each reason to a resolution of the day', () => {
    const { memory, reflectInput } = closedDay();
    expect(task(REFLECT_TASK_ID).outputContract?.validatorRefs).toEqual([
      CLOSE_REASONS_VALIDATOR_REF,
    ]);
    const docs = cycleDocsOf(memory);
    const reflection = reflectionFor(reflectInput);
    expect(closeReasonIssues(reflection, docs)).toEqual([]);
    const withReason = (i: number, patch: Record<string, unknown>) => ({
      ...reflection,
      reasons: reflection.reasons.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });
    const refusal = (output: unknown) => closeReasonIssues(output, docs).map((issue) => issue.path);

    // A thesis no cycle doc of the day resolved is refused, and the one left out is named.
    expect(refusal(withReason(1, { thesisId: 'nvda-long' }))).toEqual([
      ['reasons', 1, 'thesisId'],
      ['reasons'],
    ]);
    // An outcome other than the one its cycle doc records is refused.
    expect(refusal(withReason(1, { outcome: 'falsified' }))).toEqual([['reasons', 1, 'outcome']]);
    // So is the slot of another cycle.
    expect(refusal(withReason(1, { slotKey: 'after_close' }))).toEqual([
      ['reasons', 1, 'slotKey'],
      ['reasons'],
    ]);
    // And a resolution left out.
    expect(refusal({ ...reflection, reasons: reflection.reasons.slice(0, 1) })).toEqual([
      ['reasons'],
    ]);
    const [unknown] = closeReasonIssues(withReason(1, { thesisId: 'nvda-long' }), docs);
    expect(unknown?.message).toContain(`No cycle doc of ${TRADING_DAY} records thesis "nvda-long"`);
  });

  it('the ledger read lists every resolution and opening of the day and nothing else', () => {
    const { memory, reflectInput } = closedDay();
    expect(task(READ_DAY_RESOLUTIONS_TASK_ID).outputContract?.validatorRefs).toEqual([
      DAY_RESOLUTIONS_VALIDATOR_REF,
    ]);
    const read = {
      tradingDay: TRADING_DAY,
      resolutions: reflectInput['dayResolutions'],
      thesesOpened: reflectInput['thesesOpened'],
    };
    const docs = cycleDocsOf(memory);
    expect(dayResolutionIssues(read, docs)).toEqual([]);
    // Another day's cycle docs are no part of this day.
    const earlier: CycleLedgerDoc = {
      path: `${CYCLES}2026-07-13-open.json`,
      content: JSON.stringify({ thesesResolved: [RESOLVED_BY.open[0]], thesesOpened: ['x'] }),
    };
    expect(dayResolutionIssues(read, [...docs, earlier])).toEqual([]);
    const resolutions = read.resolutions as Array<Record<string, unknown>>;
    expect(
      dayResolutionIssues(
        { ...read, resolutions: [{ ...resolutions[0], outcome: 'expired' }, resolutions[1]] },
        docs,
      ).map((issue) => issue.path),
    ).toEqual([['resolutions', 0, 'outcome']]);
    // The openings are held to the docs as the resolutions are: a thesis no
    // cycle doc opened is refused, and the opening left out is named.
    const opened = read.thesesOpened as Array<Record<string, unknown>>;
    expect(opened.map((o) => o['thesisId'])).toEqual(['aapl-long', 'msft-long']);
    const misread = (thesesOpened: unknown[]) =>
      dayResolutionIssues({ ...read, thesesOpened }, docs).map((issue) => issue.path);
    expect(misread([opened[0], { ...opened[1], thesisId: 'nvda-long' }])).toEqual([
      ['thesesOpened', 1, 'thesisId'],
      ['thesesOpened'],
    ]);
    expect(misread([...opened, { ...opened[0], slotKey: 'open' }])).toEqual([
      ['thesesOpened', 2, 'slotKey'],
    ]);
    expect(misread(opened.slice(1))).toEqual([['thesesOpened']]);
    // A cycle doc of the day that cannot be read refuses every list.
    const [unreadable] = dayResolutionIssues(read, [
      ...docs,
      { path: `${CYCLES}${TRADING_DAY}-intraday-2.json`, content: null },
    ]);
    expect(unreadable?.message).toContain('cannot be read');
  });

  it('the close report feeds nothing and changes no config', () => {
    const reportIds = new Set<string>(CLOSE_REPORT_TASK_IDS);
    for (const t of wf.tasks) {
      // Nothing outside the close report binds, pins or gates on its tasks.
      if (reportIds.has(t.taskId)) continue;
      for (const binding of Object.values(t.inputBindings ?? {})) {
        if ('taskId' in binding) expect(reportIds.has(binding.taskId), t.taskId).toBe(false);
      }
      for (const b of t.outputContract?.derivedFrom ?? []) {
        expect(reportIds.has(b.from), t.taskId).toBe(false);
      }
      for (const id of CLOSE_REPORT_TASK_IDS) {
        expect(JSON.stringify(t.when ?? null), t.taskId).not.toContain(`tasks.${id}.`);
        expect(t.dependsOn ?? [], t.taskId).not.toContain(id);
      }
    }
    const consumersOf = (producer: string) =>
      wf.tasks
        .filter((t) =>
          Object.values(t.inputBindings ?? {}).some((b) => 'taskId' in b && b.taskId === producer),
        )
        .map((t) => t.taskId);
    // The write step's output is the report path alone, and no task reads it.
    const write = task(WRITE_CLOSE_REPORT_TASK_ID);
    expect(write.outputContract?.schema).toMatchObject({
      required: ['closeReportPath'],
      additionalProperties: false,
    });
    expect(Object.keys(write.outputProjection ?? {})).toEqual(['closeReportPath']);
    expect(consumersOf(WRITE_CLOSE_REPORT_TASK_ID)).toEqual([]);
    // The reflection reaches the ledger record alone, and the report takes it
    // from the ledger.
    expect(consumersOf(REFLECT_TASK_ID)).toEqual([RECORD_REFLECTION_TASK_ID]);
    expect(consumersOf(READ_REFLECTION_TASK_ID)).toEqual([WRITE_CLOSE_REPORT_TASK_ID]);
    for (const id of CLOSE_REPORT_TASK_IDS) {
      const t = task(id);
      // No run state, campaign or skill field is derived from the close report.
      expect(t.promoteOutputs ?? [], id).toEqual([]);
      // It places no order and calls no API.
      expect(t.context?.capabilities?.integrations ?? [], id).toEqual([]);
      expect(t.operation === undefined || t.operation.startsWith('memory.store.'), id).toBe(true);
      // A close report that cannot be written never fails the cycle it records.
      expect(t.optional, id).toBe(true);
    }
    expect(task(REFLECT_TASK_ID).context?.capabilities?.operations).toEqual(['memory.store.get']);
    expect(task(READ_DAY_RESOLUTIONS_TASK_ID).context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
    const writers = (folder: string) =>
      wf.tasks
        .filter(
          (t) =>
            t.operation === 'memory.store.put' &&
            JSON.stringify(t.inputTemplate ?? {}).includes(folder),
        )
        .map((t) => t.taskId);
    expect(writers('/portfolio/close-reports/')).toEqual([WRITE_CLOSE_REPORT_TASK_ID]);
    expect(writers('/portfolio/theses/reflections/')).toEqual([RECORD_REFLECTION_TASK_ID]);
  });

  it('names each artifact once: the close report is never called the day’s journal', () => {
    const text = [JSON.stringify(ALPACA_THESIS_TRADING), entry.description].join('\n');
    expect(text).not.toMatch(/the day['’]s journal/i);
    // The Memory root holds no journal of the cycle's.
    expect(text).not.toContain('`/journal/');
    expect(text).toContain(CLOSE_REPORT_PATH_TEMPLATE);
    expect(ALPACA_THESIS_TRADING.description).toContain('a record only that no desk reads');
    expect(entry.description).toContain(
      'The Strategy Desk reads the Trading Reflection journal, never the close report.',
    );
  });
});
