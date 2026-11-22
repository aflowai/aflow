/**
 * The close report of a Daily Trading Cycle. On the after_close slot alone,
 * after the cycle doc is written, the cycle reads that doc, the after_close
 * snapshot, and every resolution and opening the day's cycle docs record,
 * back from the ledger. A reflection gives one reason per resolution and
 * candidate changes for the next campaign boundary. The cycle records it in
 * the ledger once per trading day, with the day's resolutions and openings as
 * their contract held them to the cycle docs. A write step then writes the
 * close report from that record and the docs. Every metric, the per-arm table
 * and the cost come from the docs and the campaign, and the counts from the
 * recorded lists, never from the reflection or from resolve-theses. The
 * report is a record only: no task reads it, and it changes no campaign,
 * skill or config.
 *
 * The reads key on the trading day and the slot, never on proceed. A duplicate
 * after_close trigger finds the reflection recorded, runs no agent and writes
 * the same report from the same record and docs.
 */
import { DECIDE_MARKET_STATES } from './dailyTradingCycleRegime.js';
import {
  CYCLE_DOC_PATH_PATTERN,
  RESOLUTION_OUTCOMES,
  SLOT_KEY_PATTERN,
} from './dailyTradingCycleSlots.js';
import {
  CLOSE_REASONS_VALIDATOR_REF,
  DAY_RESOLUTIONS_VALIDATOR_REF,
} from './dailyTradingCycleDayResolutions.js';

export const READ_CLOSE_CYCLE_DOC_TASK_ID = 'read-close-cycle-doc';
export const READ_CLOSE_SNAPSHOT_TASK_ID = 'read-close-snapshot';
export const READ_RECORDED_REFLECTION_TASK_ID = 'read-recorded-reflection';
export const READ_DAY_RESOLUTIONS_TASK_ID = 'read-day-resolutions';
export const REFLECT_TASK_ID = 'reflect';
export const RECORD_REFLECTION_TASK_ID = 'record-reflection';
export const READ_REFLECTION_TASK_ID = 'read-reflection';
export const WRITE_CLOSE_REPORT_TASK_ID = 'write-close-report';

/** The tasks the close report adds to the cycle, in task order. */
export const CLOSE_REPORT_TASK_IDS = [
  READ_CLOSE_CYCLE_DOC_TASK_ID,
  READ_CLOSE_SNAPSHOT_TASK_ID,
  READ_RECORDED_REFLECTION_TASK_ID,
  READ_DAY_RESOLUTIONS_TASK_ID,
  REFLECT_TASK_ID,
  RECORD_REFLECTION_TASK_ID,
  READ_REFLECTION_TASK_ID,
  WRITE_CLOSE_REPORT_TASK_ID,
] as const;

/** The close report tasks an agent runs. A recorded reflection runs neither again. */
export const CLOSE_REPORT_AGENT_TASK_IDS = [READ_DAY_RESOLUTIONS_TASK_ID, REFLECT_TASK_ID] as const;

export const CLOSE_REPORT_PATH_TEMPLATE = '/portfolio/close-reports/{tradingDay}.md';
export const CLOSE_REPORT_PATH_PATTERN =
  '^/portfolio/close-reports/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$';
export const REFLECTION_PATH_TEMPLATE =
  '/portfolio/theses/reflections/{tradingDay}-after_close.json';

/** The close report's sections, as its headings name them, in order. */
export const CLOSE_REPORT_SECTIONS = [
  'What resolved and why',
  'Layer-1 process metrics',
  'Per-arm table',
  'Cost',
  'Candidate changes for the next campaign boundary',
] as const;

/** The after_close slot alone carries the close report. Every other slot skips it. */
export const AFTER_CLOSE_GATE = {
  expression: "tasks.resolve-theses.output.slot == 'after_close'",
  onMissingRef: 'skip' as const,
};

const CYCLE_DOC_READ = `tasks.${READ_CLOSE_CYCLE_DOC_TASK_ID}.output.cycleDoc != null`;
const SNAPSHOT_READ = `tasks.${READ_CLOSE_SNAPSHOT_TASK_ID}.output.snapshot != null`;
const NONE_RECORDED = `tasks.${READ_RECORDED_REFLECTION_TASK_ID}.output.reflection == null`;

/** The docs a candidate change may cite: cycle docs, snapshots and thesis docs. */
const LEDGER_DOC_PATH_PATTERN =
  '^/portfolio/(theses/(cycles|resolved|open)|snapshots)/[A-Za-z0-9_.-]+\\.json$';

const COUNT = { type: 'integer', minimum: 0 };
const FAULT = { type: ['string', 'null'] };
const TEXT_ID = { type: 'string', minLength: 1, maxLength: 128 };
const SLOT_KEY = { type: 'string', pattern: `^${SLOT_KEY_PATTERN}$` };

/** The ledger docs the close report reads are read whole, up to the largest read the store gives. */
const LEDGER_READ_MAX_BYTES = 1_048_576;

const bind = (name: string) => ({ $bind: name });
const output = (taskId: string, path?: string) => ({
  kind: 'task_output' as const,
  taskId,
  ...(path === undefined ? {} : { path }),
});
const campaign = (path: string) => ({ kind: 'campaign_input' as const, path });

const RESOLVED_TRADING_DAY = output('resolve-theses', 'tradingDay');

interface LedgerRead {
  taskId: string;
  name: string;
  goal: string;
  folder: string;
  field: 'cycleDoc' | 'snapshot' | 'reflection';
  dependsOn: string[];
  docSchema: Record<string, unknown>;
}

function readAfterCloseDoc(read: LedgerRead) {
  return {
    taskId: read.taskId,
    name: read.name,
    goal: read.goal,
    type: 'operation' as const,
    operation: 'memory.store.get',
    dependsOn: read.dependsOn,
    when: AFTER_CLOSE_GATE,
    // The cycle is complete before this read. A close report that cannot be
    // written must not fail the cycle it records.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { tradingDay: RESOLVED_TRADING_DAY },
    inputTemplate: {
      target: { path: { $concat: [read.folder, bind('tradingDay'), '-after_close.json'] } },
      view: 'content',
      ifMissing: 'absent',
      maxBytes: LEDGER_READ_MAX_BYTES,
    },
    outputProjection: { [read.field]: { path: 'dataJson', onMissing: 'null' as const } },
    outputContract: {
      schema: {
        type: 'object',
        required: [read.field],
        additionalProperties: false,
        properties: { [read.field]: read.docSchema },
      },
    },
  };
}

const READ_CLOSE_CYCLE_DOC_TASK = readAfterCloseDoc({
  taskId: READ_CLOSE_CYCLE_DOC_TASK_ID,
  name: 'Read the after-close cycle doc',
  goal: 'Read the trading day’s after_close cycle doc back from the ledger, as written. The close report takes its metrics, faults and cost from it. A day with no after_close cycle doc writes no close report.',
  folder: '/portfolio/theses/cycles/',
  field: 'cycleDoc',
  dependsOn: ['write-cycle-doc'],
  docSchema: {
    type: ['object', 'null'],
    description: 'The after_close cycle doc as the ledger holds it, or null where there is none.',
    required: [
      'tradingDay',
      'slot',
      'thesesResolved',
      'submittedCount',
      'deferredCount',
      'failedCount',
      'projectedGrossExposurePct',
      'approvedSetFault',
      'marketState',
      'decisionFault',
      'preMarketFault',
    ],
    additionalProperties: true,
    properties: {
      tradingDay: { type: 'string' },
      slot: { const: 'after_close' },
      thesesResolved: { type: 'array', items: { type: 'object' } },
      submittedCount: COUNT,
      deferredCount: COUNT,
      failedCount: COUNT,
      projectedGrossExposurePct: { type: 'number' },
      approvedSetFault: FAULT,
      marketState: { enum: [...DECIDE_MARKET_STATES] },
      decisionFault: FAULT,
      preMarketFault: FAULT,
    },
  },
});

const READ_CLOSE_SNAPSHOT_TASK = readAfterCloseDoc({
  taskId: READ_CLOSE_SNAPSHOT_TASK_ID,
  name: 'Read the after-close snapshot',
  goal: 'Read the trading day’s after_close snapshot back from the ledger, as written: its per-arm table, counted from the thesis ledger, and its gross exposure.',
  folder: '/portfolio/snapshots/',
  field: 'snapshot',
  dependsOn: ['write-cycle-doc'],
  docSchema: {
    type: ['object', 'null'],
    description: 'The after_close snapshot as the ledger holds it, or null where there is none.',
    required: ['grossExposurePct', 'armTable'],
    additionalProperties: true,
    properties: {
      grossExposurePct: { type: 'number' },
      armTable: { type: 'object' },
    },
  },
});

const CYCLE_DOC_PATH = {
  type: 'string',
  pattern: CYCLE_DOC_PATH_PATTERN,
  description: 'The cycle doc that records the entry.',
};
const DOC_SLOT_KEY = {
  ...SLOT_KEY,
  description:
    'The slot key the cycle doc’s name carries: pre_market, open, intraday-{n} or after_close.',
};

/** One resolution a cycle doc of the day records in its thesesResolved. */
const DAY_RESOLUTION_SCHEMA = {
  type: 'object',
  required: ['cycleDocPath', 'slotKey', 'thesisId', 'hypothesisId', 'outcome'],
  additionalProperties: false,
  properties: {
    cycleDocPath: CYCLE_DOC_PATH,
    slotKey: DOC_SLOT_KEY,
    thesisId: TEXT_ID,
    hypothesisId: TEXT_ID,
    outcome: { enum: [...RESOLUTION_OUTCOMES] },
  },
};

/** One thesis a cycle doc of the day lists in its thesesOpened. */
const DAY_OPENING_SCHEMA = {
  type: 'object',
  required: ['cycleDocPath', 'slotKey', 'thesisId'],
  additionalProperties: false,
  properties: { cycleDocPath: CYCLE_DOC_PATH, slotKey: DOC_SLOT_KEY, thesisId: TEXT_ID },
};

const DAY_RESOLUTIONS_LIST = {
  type: 'array',
  description:
    'Every resolution the day’s cycle docs record, one entry per item of each doc’s thesesResolved. The contract reads the docs and holds the list to them. The close report counts its theses resolved from it.',
  items: DAY_RESOLUTION_SCHEMA,
};

const DAY_OPENINGS_LIST = {
  type: 'array',
  description:
    'Every thesis the day’s cycle docs list as opened, one entry per item of each doc’s thesesOpened. The contract reads the docs and holds the list to them. The close report counts its theses formed from it.',
  items: DAY_OPENING_SCHEMA,
};

/** One reason of the reflection: a resolution of the day, and why it resolved. */
const REASON_SCHEMA = {
  type: 'object',
  required: ['thesisId', 'hypothesisId', 'outcome', 'slotKey', 'reason'],
  additionalProperties: false,
  properties: {
    thesisId: { ...TEXT_ID, description: 'The thesisId of one entry of dayResolutions.' },
    hypothesisId: { ...TEXT_ID, description: 'The hypothesisId that entry carries.' },
    outcome: {
      enum: [...RESOLUTION_OUTCOMES],
      description: 'The outcome that entry carries.',
    },
    slotKey: {
      ...SLOT_KEY,
      description: 'The slotKey that entry carries: the slot whose cycle resolved the thesis.',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description:
        'Your account of why the thesis resolved, grounded in the resolutionEvidence its resolved doc records: the prices against the written criterion, or the order facts of an entry_failed. No contract compares it to that evidence.',
    },
  },
};

const CANDIDATE_CHANGES_SCHEMA = {
  type: 'array',
  maxItems: 10,
  description:
    'Observations for the next campaign boundary, each tied to the docs it rests on. None is a decision, and nothing applies them.',
  items: {
    type: 'object',
    required: ['observation', 'evidence'],
    additionalProperties: false,
    properties: {
      observation: { type: 'string', minLength: 1, maxLength: 2000 },
      evidence: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          required: ['path', 'field', 'value'],
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              pattern: LEDGER_DOC_PATH_PATTERN,
              description: 'The cycle doc, snapshot or thesis doc the observation rests on.',
            },
            field: { type: 'string', minLength: 1, maxLength: 200 },
            value: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
              description: 'The field’s value as the doc holds it.',
            },
          },
        },
      },
    },
  },
};

/**
 * The reflection as the ledger records it, read before the agents run and
 * again after the record. It holds the day's resolutions and openings as the
 * ledger read listed them, so a duplicate trigger counts from the same lists.
 */
const REFLECTION_DOC_SCHEMA = {
  type: ['object', 'null'],
  description: 'The reflection the ledger holds for the trading day, or null where there is none.',
  required: ['tradingDay', 'slot', 'resolutions', 'thesesOpened', 'reasons', 'candidateChanges'],
  additionalProperties: false,
  properties: {
    tradingDay: { type: 'string' },
    slot: { const: 'after_close' },
    resolutions: DAY_RESOLUTIONS_LIST,
    thesesOpened: DAY_OPENINGS_LIST,
    reasons: { type: 'array', items: REASON_SCHEMA },
    candidateChanges: CANDIDATE_CHANGES_SCHEMA,
  },
};

const READ_RECORDED_REFLECTION_TASK = readAfterCloseDoc({
  taskId: READ_RECORDED_REFLECTION_TASK_ID,
  name: 'Read the recorded reflection',
  goal: `Read the reflection an earlier after_close run of the trading day recorded at ${REFLECTION_PATH_TEMPLATE}. Where one is recorded, the cycle runs no agent and writes the close report from it.`,
  folder: '/portfolio/theses/reflections/',
  field: 'reflection',
  dependsOn: ['write-cycle-doc'],
  docSchema: REFLECTION_DOC_SCHEMA,
});

export const READ_DAY_RESOLUTIONS_PROMPT = `List every resolution and every opening the trading day's cycle docs record, across every slot of the day. You write no doc and change nothing.

Input (already in your task context):
- \`tradingDay\` — the trading day.

List /portfolio/theses/cycles/ and read each cycle doc whose name starts with \`{tradingDay}-\`: the pre_market, open, intraday and after_close cycles. Give one entry in \`resolutions\` per item of each doc's \`thesesResolved\`, and one entry in \`thesesOpened\` per item of its \`thesesOpened\`. Each entry carries that doc's path and the slot key its name carries.

Your output contract reads the same docs. It refuses an entry they do not record, a field they record otherwise and an entry you leave out.`;

const READ_DAY_RESOLUTIONS_TASK = {
  taskId: READ_DAY_RESOLUTIONS_TASK_ID,
  name: 'Read the day’s resolutions and openings',
  goal: READ_DAY_RESOLUTIONS_PROMPT,
  type: 'agent' as const,
  dependsOn: [READ_CLOSE_CYCLE_DOC_TASK_ID, READ_RECORDED_REFLECTION_TASK_ID],
  when: { allOf: [CYCLE_DOC_READ, NONE_RECORDED], onMissingRef: 'skip' as const },
  optional: true,
  inputBindings: { tradingDay: RESOLVED_TRADING_DAY },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: { operations: ['memory.store.query', 'memory.store.get'], integrations: [] },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['tradingDay', 'resolutions', 'thesesOpened'],
      additionalProperties: false,
      properties: {
        tradingDay: {
          type: 'string',
          pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
          description: 'The trading day. It is pinned.',
        },
        resolutions: DAY_RESOLUTIONS_LIST,
        thesesOpened: DAY_OPENINGS_LIST,
      },
    },
    derivedFrom: [
      {
        bindingId: 'day-resolutions-trading-day-pin',
        from: 'resolve-theses',
        binding: 'value:$.tradingDay',
        target: '$.tradingDay.const',
      },
    ],
    validatorRefs: [DAY_RESOLUTIONS_VALIDATOR_REF],
  },
};

export const REFLECT_PROMPT = `Reflect on the trading day. The cycle records your output in the ledger and writes the close report from it and the docs. You write no doc and change nothing.

Inputs (already in your task context):
- \`dayResolutions\` — every resolution the day's cycle docs record, across every slot, each with its cycle doc and slot key.
- \`cycleDoc\` — the after_close cycle doc as the ledger holds it.
- \`snapshot\` — the after_close snapshot, with the per-arm table counted from the ledger.
- \`thesesOpened\` — every thesis the day's cycle docs list as opened, each with its cycle doc and slot key.
- \`hypotheses\`, \`maxThesesPerDay\`, \`maxGrossExposurePct\` — the campaign's arms and caps.

For each entry of \`dayResolutions\`, read /portfolio/theses/resolved/{thesisId}.json. Give one reason per entry, with that entry's thesisId, hypothesisId, outcome and slotKey. The reason is your account of why the thesis resolved, grounded in the doc's \`resolutionEvidence\`.

The cycle takes every metric, the per-arm table and the cost from the docs, so your output holds none of them. Each candidate change is an observation for the next campaign boundary, never a decision. Cite the doc fields it rests on. An empty list is an answer.`;

const REFLECT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['tradingDay', 'slot', 'reasons', 'candidateChanges'],
  additionalProperties: false,
  properties: {
    tradingDay: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      description: 'The cycle doc’s tradingDay. It is pinned, and the close report path takes it.',
    },
    slot: {
      const: 'after_close',
      description:
        'after_close. The close report is the after_close cycle’s alone, and the contract refuses any other slot.',
    },
    reasons: {
      type: 'array',
      description:
        'One entry per entry of dayResolutions: why that thesis resolved. The contract reads the day’s cycle docs and refuses an unknown thesis, a wrong outcome or slot, and a resolution left out.',
      items: REASON_SCHEMA,
    },
    candidateChanges: CANDIDATE_CHANGES_SCHEMA,
  },
};

const REFLECT_TASK = {
  taskId: REFLECT_TASK_ID,
  name: 'Reflect on the day',
  goal: REFLECT_PROMPT,
  type: 'agent' as const,
  dependsOn: [
    READ_CLOSE_CYCLE_DOC_TASK_ID,
    READ_CLOSE_SNAPSHOT_TASK_ID,
    READ_DAY_RESOLUTIONS_TASK_ID,
  ],
  when: {
    allOf: [
      CYCLE_DOC_READ,
      SNAPSHOT_READ,
      `tasks.${READ_DAY_RESOLUTIONS_TASK_ID}.output.tradingDay != null`,
    ],
    onMissingRef: 'skip' as const,
  },
  optional: true,
  inputBindings: {
    tradingDay: RESOLVED_TRADING_DAY,
    dayResolutions: output(READ_DAY_RESOLUTIONS_TASK_ID, 'resolutions'),
    thesesOpened: output(READ_DAY_RESOLUTIONS_TASK_ID, 'thesesOpened'),
    cycleDoc: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc'),
    snapshot: output(READ_CLOSE_SNAPSHOT_TASK_ID, 'snapshot'),
    hypotheses: campaign('hypotheses'),
    maxThesesPerDay: campaign('maxThesesPerDay'),
    maxGrossExposurePct: campaign('maxGrossExposurePct'),
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    // Reads only. The record step writes the one doc this reflection lands in.
    capabilities: { operations: ['memory.store.get'], integrations: [] },
  },
  outputContract: {
    schema: REFLECT_OUTPUT_SCHEMA,
    derivedFrom: [
      {
        bindingId: 'reflect-trading-day-pin',
        from: READ_CLOSE_CYCLE_DOC_TASK_ID,
        binding: 'value:$.cycleDoc.tradingDay',
        target: '$.tradingDay.const',
      },
      // The static const is after_close, so any other slot conflicts and the
      // contract refuses to derive.
      {
        bindingId: 'reflect-slot-pin',
        from: 'resolve-theses',
        binding: 'value:$.slot',
        target: '$.slot.const',
      },
      ...(['minItems', 'maxItems'] as const).map((bound) => ({
        bindingId: `reflect-reasons-${bound === 'minItems' ? 'floor' : 'ceiling'}`,
        from: READ_DAY_RESOLUTIONS_TASK_ID,
        binding: 'count:$.resolutions',
        target: `$.reasons.${bound}`,
      })),
    ],
    validatorRefs: [CLOSE_REASONS_VALIDATOR_REF],
  },
};

const REFLECTION_PATH = {
  $concat: ['/portfolio/theses/reflections/', bind('tradingDay'), '-after_close.json'],
};

const RECORD_REFLECTION_TASK = {
  taskId: RECORD_REFLECTION_TASK_ID,
  name: 'Record the reflection',
  goal: `Record the reflection in the ledger at ${REFLECTION_PATH_TEMPLATE}, once per trading day, with the day's resolutions and openings as the ledger read listed them. A duplicate after_close trigger reads it back and runs no agent.`,
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [READ_DAY_RESOLUTIONS_TASK_ID, REFLECT_TASK_ID],
  when: {
    expression: `tasks.${REFLECT_TASK_ID}.output.tradingDay != null`,
    onMissingRef: 'skip' as const,
  },
  optional: true,
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: output(REFLECT_TASK_ID, 'tradingDay'),
    slot: output(REFLECT_TASK_ID, 'slot'),
    resolutions: output(READ_DAY_RESOLUTIONS_TASK_ID, 'resolutions'),
    thesesOpened: output(READ_DAY_RESOLUTIONS_TASK_ID, 'thesesOpened'),
    reasons: output(REFLECT_TASK_ID, 'reasons'),
    candidateChanges: output(REFLECT_TASK_ID, 'candidateChanges'),
  },
  inputTemplate: {
    path: REFLECTION_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        tradingDay: bind('tradingDay'),
        slot: bind('slot'),
        resolutions: bind('resolutions'),
        thesesOpened: bind('thesesOpened'),
        reasons: bind('reasons'),
        candidateChanges: bind('candidateChanges'),
      },
    },
    // The first reflection of the day stands. A second write is refused.
    writeMode: 'create',
    indexing: 'disabled',
  },
};

const READ_REFLECTION_TASK = readAfterCloseDoc({
  taskId: READ_REFLECTION_TASK_ID,
  name: 'Read the reflection',
  goal: `Read the trading day’s reflection back from the ledger at ${REFLECTION_PATH_TEMPLATE}, as recorded. Every run writes the close report from this read, so a duplicate trigger writes the same report.`,
  folder: '/portfolio/theses/reflections/',
  field: 'reflection',
  dependsOn: [RECORD_REFLECTION_TASK_ID, READ_RECORDED_REFLECTION_TASK_ID],
  docSchema: REFLECTION_DOC_SCHEMA,
});

const fenced = (value: unknown) => ['```json\n', { $json: [value] }, '\n```\n'];

const section = (heading: string, note: string, value: unknown) => [
  `\n## ${heading}\n\n${note}\n\n`,
  ...fenced(value),
];

const [RESOLVED, METRICS, ARMS, COST, CHANGES] = CLOSE_REPORT_SECTIONS;

const fromCycleDoc = (field: string) => output(READ_CLOSE_CYCLE_DOC_TASK_ID, `cycleDoc.${field}`);
const fromSnapshot = (field: string) => output(READ_CLOSE_SNAPSHOT_TASK_ID, `snapshot.${field}`);
const fromReflection = (field: string) => output(READ_REFLECTION_TASK_ID, `reflection.${field}`);

const CYCLE_DOC_FIELDS = [
  'marketState',
  'approvedSetFault',
  'decisionFault',
  'preMarketFault',
  'submittedCount',
  'deferredCount',
  'failedCount',
  'projectedGrossExposurePct',
] as const;

/**
 * The close report, as Markdown. Each section holds its value written as JSON.
 * The reasons and the candidate changes are the recorded reflection's. Every
 * metric, the per-arm table and the cost are bound from the docs, and the
 * day's counts from the lists the record holds, so no agent copies them and
 * no fault string can break the write.
 */
const CLOSE_REPORT_TEXT = {
  $concat: [
    '# Close report ',
    bind('tradingDay'),
    '\n\nThe after_close cycle wrote this report from the day’s cycle docs, its snapshot and the reflection it recorded in the ledger. It is a record only. No task reads it, and it changes no campaign, skill or config.\n',
    ...section(
      RESOLVED,
      'Each thesis the day’s cycles resolved, the slot whose cycle resolved it, and the reflection’s account of why. Each account rests on the resolutionEvidence its resolved doc records, and no contract compares the two.',
      bind('reasons'),
    ),
    ...section(
      METRICS,
      'Theses formed and resolved over the day, counted from the day’s cycle docs, against the theses-per-day cap. Then the after_close gross exposure against its cap, the regime state and the faults the after_close cycle doc names.',
      {
        thesesFormed: { $length: [bind('thesesOpened')] },
        maxThesesPerDay: bind('maxThesesPerDay'),
        thesesResolved: { $length: [bind('resolutions')] },
        grossExposurePct: bind('grossExposurePct'),
        maxGrossExposurePct: bind('maxGrossExposurePct'),
        marketState: bind('marketState'),
        approvedSetFault: bind('approvedSetFault'),
        decisionFault: bind('decisionFault'),
        preMarketFault: bind('preMarketFault'),
      },
    ),
    ...section(
      ARMS,
      'Each arm’s theses formed, open and resolved by outcome, as the after_close snapshot counts them from the ledger. The ledger records no R for a resolution, so the table holds no expectancy in R.',
      bind('armTable'),
    ),
    ...section(
      COST,
      'What the after_close cycle doc records: orders submitted, deferred and failed, and the projected gross exposure. The cycle doc records no spend.',
      {
        submittedCount: bind('submittedCount'),
        deferredCount: bind('deferredCount'),
        failedCount: bind('failedCount'),
        projectedGrossExposurePct: bind('projectedGrossExposurePct'),
      },
    ),
    ...section(
      CHANGES,
      'Observations for the next campaign boundary, each tied to the docs it rests on. None is a decision, and nothing applies them.',
      bind('candidateChanges'),
    ),
  ],
};

const WRITE_CLOSE_REPORT_TASK = {
  taskId: WRITE_CLOSE_REPORT_TASK_ID,
  name: 'Write the close report',
  goal: `Write the day’s close report at ${CLOSE_REPORT_PATH_TEMPLATE} from the recorded reflection and the after_close docs. One path per trading day, upserted, so a duplicate trigger writes the same report.`,
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [READ_REFLECTION_TASK_ID, READ_CLOSE_CYCLE_DOC_TASK_ID, READ_CLOSE_SNAPSHOT_TASK_ID],
  when: {
    allOf: [
      `tasks.${READ_REFLECTION_TASK_ID}.output.reflection != null`,
      CYCLE_DOC_READ,
      SNAPSHOT_READ,
    ],
    onMissingRef: 'skip' as const,
  },
  optional: true,
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: fromCycleDoc('tradingDay'),
    reasons: fromReflection('reasons'),
    candidateChanges: fromReflection('candidateChanges'),
    resolutions: fromReflection('resolutions'),
    thesesOpened: fromReflection('thesesOpened'),
    maxThesesPerDay: campaign('maxThesesPerDay'),
    maxGrossExposurePct: campaign('maxGrossExposurePct'),
    grossExposurePct: fromSnapshot('grossExposurePct'),
    armTable: fromSnapshot('armTable'),
    ...Object.fromEntries(CYCLE_DOC_FIELDS.map((field) => [field, fromCycleDoc(field)])),
  },
  inputTemplate: {
    path: { $concat: ['/portfolio/close-reports/', bind('tradingDay'), '.md'] },
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: { inlineText: CLOSE_REPORT_TEXT },
    writeMode: 'upsert',
  },
  outputProjection: { closeReportPath: { path: 'path', onMissing: 'error' as const } },
  // The report path and nothing else. No task binds it.
  outputContract: {
    schema: {
      type: 'object',
      required: ['closeReportPath'],
      additionalProperties: false,
      properties: { closeReportPath: { type: 'string', pattern: CLOSE_REPORT_PATH_PATTERN } },
    },
  },
};

/** The close report tasks, after the cycle doc in the cycle's task order. */
export const CLOSE_REPORT_TASKS = [
  READ_CLOSE_CYCLE_DOC_TASK,
  READ_CLOSE_SNAPSHOT_TASK,
  READ_RECORDED_REFLECTION_TASK,
  READ_DAY_RESOLUTIONS_TASK,
  REFLECT_TASK,
  RECORD_REFLECTION_TASK,
  READ_REFLECTION_TASK,
  WRITE_CLOSE_REPORT_TASK,
];
