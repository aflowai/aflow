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
import {
  JOURNAL_SECTIONS,
  JOURNAL_TASK_IDS,
  READ_CLOSE_CYCLE_DOC_TASK_ID,
  READ_CLOSE_SNAPSHOT_TASK_ID,
  REFLECT_TASK_ID,
  WRITE_JOURNAL_TASK_ID,
} from '../skillCatalog/dailyTradingCycleJournal.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = getSkillCatalogEntry('daily-trading-cycle')!.bundle.workflow;
type Task = (typeof wf.tasks)[number];
const task = (id: string): Task => wf.tasks.find((t) => t.taskId === id)!;
const TASKS = wf.tasks as unknown as WorkflowTask[];

const TRADING_DAY = '2026-07-14';
const JOURNAL_PATH = `/journal/${TRADING_DAY}.md`;
const CAMPAIGN = {
  regimeName: 'momentum-and-reversion-1',
  hypotheses: [{ id: 'breakout' }, { id: 'gap-fade' }],
  maxThesesPerDay: 3,
  maxGrossExposurePct: 60,
};

type Slot = 'pre_market' | 'open' | 'intraday' | 'after_close';

function resolveOutput(slot: Slot, proceed = true) {
  return {
    tradingDay: TRADING_DAY,
    slot,
    slotIndex: slot === 'intraday' ? 3 : null,
    proceed,
    noopReason: proceed ? null : 'This (tradingDay, slot) cycle is already recorded.',
    resolutions: [],
    openThesesAfter: ['msft-long'],
    pendingIntentions: [],
    repairCloses: [],
    orphanFlattens: [],
    maxThesesPerDay: 3,
    thesesOpenedToday: ['aapl-long', 'msft-long'],
    remainingThesesToday: slot === 'after_close' ? 0 : 1,
    coverageNote: 'No slot missed since the last cycle.',
  };
}

const ARM_TABLE = {
  regimeName: CAMPAIGN.regimeName,
  arms: [
    {
      hypothesisId: 'breakout',
      opened: 2,
      open: 1,
      resolved: { confirmed: 0, falsified: 1, expired: 0, entry_failed: 0, tactical_exit: 0 },
    },
    {
      hypothesisId: 'gap-fade',
      opened: 0,
      open: 0,
      resolved: { confirmed: 0, falsified: 0, expired: 0, entry_failed: 0, tactical_exit: 0 },
    },
  ],
};

const RESOLVED = [
  {
    thesisId: 'aapl-long',
    hypothesisId: 'breakout',
    outcome: 'falsified',
    statedConfidence: 'medium',
    lenses: null,
  },
];

function recordOutput(slot: Slot) {
  const slotKey = slot === 'intraday' ? 'intraday-3' : slot;
  return {
    runSummary: `${TRADING_DAY} ${slot}: one thesis falsified.`,
    cycleCompleted: 1,
    thesesOpened: 0,
    thesesResolved: 1,
    cycleDocPath: `/portfolio/theses/cycles/${TRADING_DAY}-${slotKey}.json`,
    snapshotDocPath: `/portfolio/snapshots/${TRADING_DAY}-${slotKey}.json`,
    cycleDoc: {
      tradingDay: TRADING_DAY,
      slot,
      slotIndex: slot === 'intraday' ? 3 : null,
      coverageNote: 'No slot missed since the last cycle.',
      thesesOpened: [],
      openedApprovals: [],
      approvedSetFault: null,
      thesesResolved: RESOLVED,
      submittedCount: 1,
      deferredCount: 0,
      failedCount: 0,
      projectedGrossExposurePct: 4.2,
      decisionRationale: 'After the close no thesis opens.',
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

/** The reflection the agent submits: every pinned value as the docs hold it. */
const REFLECTION = {
  tradingDay: TRADING_DAY,
  slot: 'after_close',
  reasons: [
    {
      thesisId: 'aapl-long',
      outcome: 'falsified',
      reason: 'Closed at 183.10, below the 184.00 falsification level.',
    },
  ],
  processMetrics: {
    thesesFormed: 2,
    maxThesesPerDay: 3,
    thesesResolved: 1,
    grossExposurePct: 5,
    maxGrossExposurePct: 60,
    marketState: 'unavailable',
    approvedSetFault: null,
    decisionFault: null,
    preMarketFault: null,
  },
  candidateChanges: [
    {
      observation: 'The only breakout thesis to resolve was falsified within one session.',
      evidence: [
        { path: '/portfolio/theses/resolved/aapl-long.json', field: 'outcome', value: 'falsified' },
      ],
    },
  ],
};

/** A space's memory: documents by path, as the put and get operations reach them. */
type Memory = Map<string, unknown>;

function answer(memory: Memory, slot: Slot, proceed = true) {
  return (taskId: string, input: Record<string, unknown>): TaskAnswer => {
    const operation = task(taskId).operation;
    if (operation === 'memory.store.put') {
      const content = input['content'] as { inlineJson?: unknown; inlineText?: unknown };
      memory.set(String(input['path']), content.inlineJson ?? content.inlineText);
      return { path: input['path'] };
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
        return resolveOutput(slot, proceed);
      case 'ingest-calendar':
      case 'read-index-bars':
      case 'read-universe-bars':
      case 'gather-regime':
        return 'fail';
      case 'decide':
        return { marketState: input['marketState'], slot, theses: [] };
      case 'execute-orders':
        return { orderResults: [], submittedCount: 1, deferredCount: 0, failedCount: 0 };
      case 'record':
        return recordOutput(slot);
      case REFLECT_TASK_ID:
        return REFLECTION;
      default:
        return {};
    }
  };
}

function runCycle(memory: Memory, slot: Slot, proceed = true) {
  return runSkillTasks(TASKS, { slot }, answer(memory, slot, proceed));
}

/** The reflect contract as delegation derives it from the run's own reads. */
function reflectSchema(reflectInput: Record<string, unknown>, slot: Slot = 'after_close') {
  const sources: Record<string, unknown> = {
    $campaign: CAMPAIGN,
    'resolve-theses': resolveOutput(slot),
    [READ_CLOSE_CYCLE_DOC_TASK_ID]: { cycleDoc: reflectInput['cycleDoc'] },
    [READ_CLOSE_SNAPSHOT_TASK_ID]: { snapshot: reflectInput['snapshot'] },
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

/** Each journal section by its heading, its JSON block parsed. */
function journalSections(text: string): Array<[string, unknown]> {
  return text
    .split('\n## ')
    .slice(1)
    .map((part) => {
      const heading = part.slice(0, part.indexOf('\n'));
      const block = /```json\n([\s\S]*?)\n```/.exec(part)![1]!;
      return [heading, JSON.parse(block) as unknown];
    });
}

describe('daily-trading-cycle after-close journal', () => {
  it('runs only on after_close: every other slot skips the journal tasks', () => {
    for (const slot of ['pre_market', 'open', 'intraday'] as const) {
      const memory: Memory = new Map();
      const run = runCycle(memory, slot);
      expect(run.statuses.get('write-cycle-doc'), slot).toBe('succeeded');
      for (const id of JOURNAL_TASK_IDS) {
        expect(run.statuses.get(id), `${slot} ${id}`).toBe('skipped');
        expect(run.ran, `${slot} ${id}`).not.toContain(id);
      }
      expect(
        [...memory.keys()].filter((path) => path.startsWith('/journal/')),
        slot,
      ).toEqual([]);
    }
    const memory: Memory = new Map();
    const run = runCycle(memory, 'after_close');
    for (const id of JOURNAL_TASK_IDS) expect(run.statuses.get(id), id).toBe('succeeded');
    expect(run.ran.indexOf(READ_CLOSE_CYCLE_DOC_TASK_ID)).toBeGreaterThan(
      run.ran.indexOf('write-cycle-doc'),
    );
  });

  it('the reflect contract refuses to derive on any slot but after_close', () => {
    const memory: Memory = new Map();
    const reflectInput = runCycle(memory, 'after_close').inputs.get(REFLECT_TASK_ID)!;
    expect(refuses(reflectSchema(reflectInput), REFLECTION)).toBe(false);
    for (const slot of ['pre_market', 'open', 'intraday'] as const) {
      expect(() => reflectSchema(reflectInput, slot), slot).toThrow(DerivedSchemaMergeError);
    }
  });

  it('a re-run of the after_close cycle rewrites the same journal, not a second entry', () => {
    const memory: Memory = new Map();
    const first = runCycle(memory, 'after_close');
    const written = memory.get(JOURNAL_PATH);
    expect(typeof written).toBe('string');
    // The duplicate trigger finds the cycle recorded: it decides, orders and
    // records nothing, and writes the journal again from the same docs.
    const rerun = runCycle(memory, 'after_close', false);
    for (const id of ['decide', 'execute-orders', 'record', 'write-cycle-doc']) {
      expect(rerun.statuses.get(id), id).toBe('skipped');
    }
    expect(rerun.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('succeeded');
    expect(rerun.inputs.get(REFLECT_TASK_ID)).toEqual(first.inputs.get(REFLECT_TASK_ID));
    expect(rerun.inputs.get(WRITE_JOURNAL_TASK_ID)).toEqual(
      first.inputs.get(WRITE_JOURNAL_TASK_ID),
    );
    expect(rerun.inputs.get(WRITE_JOURNAL_TASK_ID)!['writeMode']).toBe('upsert');
    expect(memory.get(JOURNAL_PATH)).toBe(written);
    expect([...memory.keys()].filter((path) => path.startsWith('/journal/'))).toEqual([
      JOURNAL_PATH,
    ]);
  });

  it('the journal carries all five sections from the cycle doc and the ledger', () => {
    const memory: Memory = new Map();
    const run = runCycle(memory, 'after_close');
    const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_JOURNAL_TASK_ID));
    expect(put.path).toBe(JOURNAL_PATH);
    expect(put.docType).toBe('markdown');
    const text = put.content.inlineText!;
    expect(text.startsWith(`# Journal ${TRADING_DAY}\n`)).toBe(true);
    const cycleDoc = memory.get(
      `/portfolio/theses/cycles/${TRADING_DAY}-after_close.json`,
    ) as Record<string, unknown>;
    const sections = journalSections(text);
    expect(sections.map(([heading]) => heading)).toEqual([...JOURNAL_SECTIONS]);
    expect(Object.fromEntries(sections)).toEqual({
      [JOURNAL_SECTIONS[0]]: { resolved: cycleDoc['thesesResolved'], reasons: REFLECTION.reasons },
      [JOURNAL_SECTIONS[1]]: REFLECTION.processMetrics,
      [JOURNAL_SECTIONS[2]]: ARM_TABLE,
      [JOURNAL_SECTIONS[3]]: {
        submittedCount: 1,
        deferredCount: 0,
        failedCount: 0,
        projectedGrossExposurePct: 4.2,
      },
      [JOURNAL_SECTIONS[4]]: REFLECTION.candidateChanges,
    });
  });

  it('the reflect contract pins every metric and fault to the docs', () => {
    const memory: Memory = new Map();
    const reflectInput = runCycle(memory, 'after_close').inputs.get(REFLECT_TASK_ID)!;
    const schema = reflectSchema(reflectInput);
    const metric = (patch: Record<string, unknown>) => ({
      ...REFLECTION,
      processMetrics: { ...REFLECTION.processMetrics, ...patch },
    });
    for (const wrong of [
      { thesesFormed: 1 },
      { thesesResolved: 2 },
      { grossExposurePct: 4 },
      { maxGrossExposurePct: 80 },
      { maxThesesPerDay: 5 },
      { marketState: 'risk_on' },
      { decisionFault: 'decide failed' },
      { approvedSetFault: 'the set did not parse' },
      { preMarketFault: 'the note could not be read' },
    ]) {
      expect(refuses(schema, metric(wrong)), JSON.stringify(wrong)).toBe(true);
    }
    expect(refuses(schema, { ...REFLECTION, tradingDay: '2026-07-13' })).toBe(true);
    // One reason per resolved thesis, no more and no fewer.
    expect(refuses(schema, { ...REFLECTION, reasons: [] })).toBe(true);
    expect(
      refuses(schema, { ...REFLECTION, reasons: [...REFLECTION.reasons, ...REFLECTION.reasons] }),
    ).toBe(true);
    // A candidate change is an observation tied to a ledger doc.
    const change = REFLECTION.candidateChanges[0]!;
    expect(
      refuses(schema, { ...REFLECTION, candidateChanges: [{ ...change, evidence: [] }] }),
    ).toBe(true);
    expect(
      refuses(schema, {
        ...REFLECTION,
        candidateChanges: [
          { ...change, evidence: [{ ...change.evidence[0]!, path: '/notes/x.md' }] },
        ],
      }),
    ).toBe(true);
    expect(
      refuses(schema, {
        ...REFLECTION,
        candidateChanges: [{ ...change, decision: 'raise the cap' }],
      }),
    ).toBe(true);
  });

  it('the reflection feeds nothing and changes no config', () => {
    const journalIds = new Set<string>(JOURNAL_TASK_IDS);
    for (const t of wf.tasks) {
      // Nothing outside the journal binds, pins or gates on a journal task.
      if (journalIds.has(t.taskId)) continue;
      for (const binding of Object.values(t.inputBindings ?? {})) {
        if ('taskId' in binding) expect(journalIds.has(binding.taskId), t.taskId).toBe(false);
      }
      for (const b of t.outputContract?.derivedFrom ?? []) {
        expect(journalIds.has(b.from), t.taskId).toBe(false);
      }
      for (const id of JOURNAL_TASK_IDS) {
        expect(JSON.stringify(t.when ?? null), t.taskId).not.toContain(`tasks.${id}.`);
        expect(t.dependsOn ?? [], t.taskId).not.toContain(id);
      }
    }
    // The write step's output is the journal path alone, and no task reads it.
    const write = task(WRITE_JOURNAL_TASK_ID);
    expect(write.outputContract?.schema).toMatchObject({
      required: ['journalPath'],
      additionalProperties: false,
    });
    expect(Object.keys(write.outputProjection ?? {})).toEqual(['journalPath']);
    expect(
      wf.tasks.filter((t) =>
        Object.values(t.inputBindings ?? {}).some(
          (b) => 'taskId' in b && b.taskId === WRITE_JOURNAL_TASK_ID,
        ),
      ),
    ).toEqual([]);
    // The reflection reaches the write step alone.
    expect(
      wf.tasks
        .filter((t) =>
          Object.values(t.inputBindings ?? {}).some(
            (b) => 'taskId' in b && b.taskId === REFLECT_TASK_ID,
          ),
        )
        .map((t) => t.taskId),
    ).toEqual([WRITE_JOURNAL_TASK_ID]);
    for (const id of JOURNAL_TASK_IDS) {
      const t = task(id);
      // No run state, campaign or skill field is derived from the journal.
      expect(t.promoteOutputs ?? [], id).toEqual([]);
      // It places no order and calls no API.
      expect(t.context?.capabilities?.integrations ?? [], id).toEqual([]);
      expect(t.operation === undefined || t.operation.startsWith('memory.store.'), id).toBe(true);
      // A journal that cannot be written never fails the cycle it records.
      expect(t.optional, id).toBe(true);
    }
    expect(task(REFLECT_TASK_ID).context?.capabilities?.operations).toEqual(['memory.store.get']);
    expect(
      wf.tasks
        .filter((t) => JSON.stringify(t.inputTemplate ?? {}).includes('/journal/'))
        .map((t) => t.taskId),
    ).toEqual([WRITE_JOURNAL_TASK_ID]);
  });
});
