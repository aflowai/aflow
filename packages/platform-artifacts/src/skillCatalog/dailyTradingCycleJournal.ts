/**
 * The after-close journal of a Daily Trading Cycle. On the after_close slot
 * alone, after the cycle doc is written, the cycle reads that doc and the
 * after_close snapshot back from the ledger. A reflection agent states why
 * each thesis resolved, the Layer-1 process metrics and candidate changes for
 * the next campaign boundary, under a contract that pins every number to the
 * two docs. A write step then writes /journal/{tradingDay}.md from the
 * reflection and the docs, upserting one path per trading day. The journal is
 * a record only: no task reads it, and it changes no campaign, skill or config.
 *
 * The reads key on the trading day and the slot, never on proceed. A re-run of
 * the after_close cycle that finds its cycle doc written therefore rewrites
 * the same journal from the same docs.
 */
import { DECIDE_MARKET_STATES } from './dailyTradingCycleRegime.js';
import { RESOLUTION_OUTCOMES } from './dailyTradingCycleSlots.js';

export const READ_CLOSE_CYCLE_DOC_TASK_ID = 'read-close-cycle-doc';
export const READ_CLOSE_SNAPSHOT_TASK_ID = 'read-close-snapshot';
export const REFLECT_TASK_ID = 'reflect';
export const WRITE_JOURNAL_TASK_ID = 'write-journal';

/** The tasks the after-close journal adds to the cycle, in task order. */
export const JOURNAL_TASK_IDS = [
  READ_CLOSE_CYCLE_DOC_TASK_ID,
  READ_CLOSE_SNAPSHOT_TASK_ID,
  REFLECT_TASK_ID,
  WRITE_JOURNAL_TASK_ID,
] as const;

export const JOURNAL_PATH_TEMPLATE = '/journal/{tradingDay}.md';
export const JOURNAL_PATH_PATTERN = '^/journal/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$';

/** The journal's sections, as its headings name them, in order. */
export const JOURNAL_SECTIONS = [
  'What resolved and why',
  'Layer-1 process metrics',
  'Per-arm table',
  'Cost',
  'Candidate changes for the next campaign boundary',
] as const;

/** The after_close slot alone carries the journal. Every other slot skips it. */
export const AFTER_CLOSE_GATE = {
  expression: "tasks.resolve-theses.output.slot == 'after_close'",
  onMissingRef: 'skip' as const,
};

/** The docs a candidate change may cite: cycle docs, snapshots and thesis docs. */
const LEDGER_DOC_PATH_PATTERN =
  '^/portfolio/(theses/(cycles|resolved|open)|snapshots)/[A-Za-z0-9_.-]+\\.json$';

const THESIS_ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,63}$' };
const COUNT = { type: 'integer', minimum: 0 };
const FAULT = { type: ['string', 'null'] };

/** The ledger docs the journal reads are read whole, up to the largest read the store gives. */
const LEDGER_READ_MAX_BYTES = 1_048_576;

const bind = (name: string) => ({ $bind: name });
const output = (taskId: string, path: string) => ({
  kind: 'task_output' as const,
  taskId,
  path,
});

const RESOLVED_TRADING_DAY = output('resolve-theses', 'tradingDay');

function readAfterCloseDoc(
  taskId: string,
  name: string,
  goal: string,
  folder: string,
  field: 'cycleDoc' | 'snapshot',
  docSchema: Record<string, unknown>,
) {
  return {
    taskId,
    name,
    goal,
    type: 'operation' as const,
    operation: 'memory.store.get',
    dependsOn: ['write-cycle-doc'],
    when: AFTER_CLOSE_GATE,
    // The cycle is complete before this read. A journal that cannot be
    // written must not fail the cycle it records.
    optional: true,
    retryability: 'safe' as const,
    inputBindings: { tradingDay: RESOLVED_TRADING_DAY },
    inputTemplate: {
      target: { path: { $concat: [folder, bind('tradingDay'), '-after_close.json'] } },
      view: 'content',
      ifMissing: 'absent',
      maxBytes: LEDGER_READ_MAX_BYTES,
    },
    outputProjection: { [field]: { path: 'dataJson', onMissing: 'null' as const } },
    outputContract: {
      schema: {
        type: 'object',
        required: [field],
        additionalProperties: false,
        properties: { [field]: docSchema },
      },
    },
  };
}

const READ_CLOSE_CYCLE_DOC_TASK = readAfterCloseDoc(
  READ_CLOSE_CYCLE_DOC_TASK_ID,
  'Read the after-close cycle doc',
  'Read the trading day’s after_close cycle doc back from the ledger, as written. The journal is written from it. A day with no after_close cycle doc writes no journal.',
  '/portfolio/theses/cycles/',
  'cycleDoc',
  {
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
);

const READ_CLOSE_SNAPSHOT_TASK = readAfterCloseDoc(
  READ_CLOSE_SNAPSHOT_TASK_ID,
  'Read the after-close snapshot',
  'Read the trading day’s after_close snapshot back from the ledger, as written: its per-arm table, counted from the thesis ledger, and its gross exposure.',
  '/portfolio/snapshots/',
  'snapshot',
  {
    type: ['object', 'null'],
    description: 'The after_close snapshot as the ledger holds it, or null where there is none.',
    required: ['grossExposurePct', 'armTable'],
    additionalProperties: true,
    properties: {
      grossExposurePct: { type: 'number' },
      armTable: { type: 'object' },
    },
  },
);

export const REFLECT_PROMPT = `Reflect on the trading day's after_close cycle. The run writes the journal from your output. You write no doc and change nothing.

Inputs (already in your task context):
- \`cycleDoc\` — the after_close cycle doc as the ledger holds it.
- \`snapshot\` — the after_close snapshot, with the per-arm table counted from the ledger.
- \`thesesOpenedToday\` — every thesis the day's cycle docs list as opened.
- \`hypotheses\`, \`maxThesesPerDay\`, \`maxGrossExposurePct\` — the campaign's arms and caps.

Read each thesis in \`cycleDoc.thesesResolved\` at /portfolio/theses/resolved/{thesisId}.json. Its \`resolutionEvidence\` is the reason it resolved.

Your output contract pins every number and fault to these docs. Copy each value as the docs hold it. Each candidate change is an observation for the next campaign boundary, never a decision. Cite the doc fields it rests on. An empty list is an answer.`;

const REFLECT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['tradingDay', 'slot', 'reasons', 'processMetrics', 'candidateChanges'],
  additionalProperties: false,
  properties: {
    tradingDay: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      description: 'The cycle doc’s tradingDay. It is pinned, and the journal path takes it.',
    },
    slot: {
      const: 'after_close',
      description:
        'after_close. The journal is the after_close cycle’s alone, and the contract refuses any other slot.',
    },
    reasons: {
      type: 'array',
      description:
        'One entry per thesis in cycleDoc.thesesResolved: why it resolved. The contract holds the count to that list.',
      items: {
        type: 'object',
        required: ['thesisId', 'outcome', 'reason'],
        additionalProperties: false,
        properties: {
          thesisId: THESIS_ID,
          outcome: { enum: [...RESOLUTION_OUTCOMES] },
          reason: {
            type: 'string',
            minLength: 1,
            maxLength: 8000,
            description:
              'The resolutionEvidence its resolved doc records, quoted. It names the prices against the written criterion, or the order facts of an entry_failed.',
          },
        },
      },
    },
    processMetrics: {
      type: 'object',
      description:
        'The Layer-1 process metrics the record computes, as the docs hold them. Each is pinned. A cap is hit where its value reaches the cap.',
      required: [
        'thesesFormed',
        'maxThesesPerDay',
        'thesesResolved',
        'grossExposurePct',
        'maxGrossExposurePct',
        'marketState',
        'approvedSetFault',
        'decisionFault',
        'preMarketFault',
      ],
      additionalProperties: false,
      properties: {
        thesesFormed: { ...COUNT, description: 'The length of thesesOpenedToday.' },
        maxThesesPerDay: { type: 'integer', description: 'The campaign’s theses-per-day cap.' },
        thesesResolved: {
          ...COUNT,
          description: 'The length of cycleDoc.thesesResolved.',
        },
        grossExposurePct: { type: 'number', description: 'The snapshot’s grossExposurePct.' },
        maxGrossExposurePct: { type: 'number', description: 'The campaign’s gross exposure cap.' },
        marketState: {
          enum: [...DECIDE_MARKET_STATES],
          description: 'The cycle doc’s marketState.',
        },
        approvedSetFault: { ...FAULT, description: 'The cycle doc’s approvedSetFault.' },
        decisionFault: { ...FAULT, description: 'The cycle doc’s decisionFault.' },
        preMarketFault: { ...FAULT, description: 'The cycle doc’s preMarketFault.' },
      },
    },
    candidateChanges: {
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
    },
  },
};

const fromCycleDoc = (bindingId: string, binding: string, target: string) => ({
  bindingId,
  from: READ_CLOSE_CYCLE_DOC_TASK_ID,
  binding,
  target,
});

const countPin = (bindingId: string, from: string, binding: string, target: string) =>
  (['minimum', 'maximum'] as const).map((bound) => ({
    bindingId: `${bindingId}-${bound === 'minimum' ? 'floor' : 'ceiling'}`,
    from,
    binding,
    target: `${target}.${bound}`,
  }));

/** Every number and fault of the reflection, pinned to the docs it reads. */
const REFLECT_PINS = [
  fromCycleDoc('journal-trading-day-pin', 'value:$.cycleDoc.tradingDay', '$.tradingDay.const'),
  // The static const is after_close, so any other slot conflicts and the
  // contract refuses to derive.
  {
    bindingId: 'journal-slot-pin',
    from: 'resolve-theses',
    binding: 'value:$.slot',
    target: '$.slot.const',
  },
  fromCycleDoc('journal-reasons-floor', 'count:$.cycleDoc.thesesResolved', '$.reasons.minItems'),
  fromCycleDoc('journal-reasons-ceiling', 'count:$.cycleDoc.thesesResolved', '$.reasons.maxItems'),
  ...countPin(
    'journal-theses-formed',
    'resolve-theses',
    'count:$.thesesOpenedToday',
    '$.processMetrics.thesesFormed',
  ),
  ...countPin(
    'journal-theses-resolved',
    READ_CLOSE_CYCLE_DOC_TASK_ID,
    'count:$.cycleDoc.thesesResolved',
    '$.processMetrics.thesesResolved',
  ),
  {
    bindingId: 'journal-gross-pin',
    from: READ_CLOSE_SNAPSHOT_TASK_ID,
    binding: 'value:$.snapshot.grossExposurePct',
    target: '$.processMetrics.grossExposurePct.const',
  },
  {
    bindingId: 'journal-gross-cap-pin',
    from: '$campaign',
    binding: 'value:$.maxGrossExposurePct',
    target: '$.processMetrics.maxGrossExposurePct.const',
  },
  {
    bindingId: 'journal-theses-cap-pin',
    from: '$campaign',
    binding: 'value:$.maxThesesPerDay',
    target: '$.processMetrics.maxThesesPerDay.const',
  },
  ...(
    [
      ['marketState', 'market-state'],
      ['approvedSetFault', 'approved-set-fault'],
      ['decisionFault', 'decision-fault'],
      ['preMarketFault', 'pre-market-fault'],
    ] as const
  ).map(([field, slug]) =>
    fromCycleDoc(
      `journal-${slug}-pin`,
      `value:$.cycleDoc.${field}`,
      `$.processMetrics.${field}.const`,
    ),
  ),
];

const REFLECT_TASK = {
  taskId: REFLECT_TASK_ID,
  name: 'Reflect on the day',
  goal: REFLECT_PROMPT,
  type: 'agent' as const,
  dependsOn: [READ_CLOSE_CYCLE_DOC_TASK_ID, READ_CLOSE_SNAPSHOT_TASK_ID],
  when: {
    allOf: [
      `tasks.${READ_CLOSE_CYCLE_DOC_TASK_ID}.output.cycleDoc != null`,
      `tasks.${READ_CLOSE_SNAPSHOT_TASK_ID}.output.snapshot != null`,
    ],
    onMissingRef: 'skip' as const,
  },
  optional: true,
  inputBindings: {
    tradingDay: RESOLVED_TRADING_DAY,
    thesesOpenedToday: output('resolve-theses', 'thesesOpenedToday'),
    cycleDoc: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc'),
    snapshot: output(READ_CLOSE_SNAPSHOT_TASK_ID, 'snapshot'),
    hypotheses: { kind: 'campaign_input' as const, path: 'hypotheses' },
    maxThesesPerDay: { kind: 'campaign_input' as const, path: 'maxThesesPerDay' },
    maxGrossExposurePct: { kind: 'campaign_input' as const, path: 'maxGrossExposurePct' },
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    // Reads only. The reflection writes nothing, and the journal step writes
    // the one doc this reflection lands in.
    capabilities: { operations: ['memory.store.get'], integrations: [] },
  },
  outputContract: { schema: REFLECT_OUTPUT_SCHEMA, derivedFrom: REFLECT_PINS },
};

const fenced = (value: unknown) => ['```json\n', { $json: [value] }, '\n```\n'];

const section = (heading: string, note: string, value: unknown) => [
  `\n## ${heading}\n\n${note}\n\n`,
  ...fenced(value),
];

const [RESOLVED, METRICS, ARMS, COST, CHANGES] = JOURNAL_SECTIONS;

/**
 * The journal, as Markdown. Each section holds its validated value written as
 * JSON: the reflection's for the reasons, the metrics and the candidate
 * changes, the docs' own for the resolved theses, the per-arm table and the
 * cost.
 */
const JOURNAL_TEXT = {
  $concat: [
    '# Journal ',
    bind('tradingDay'),
    '\n\nThe after_close cycle wrote this record from its cycle doc and the thesis ledger. It is a record only. No task reads it, and it changes no campaign, skill or config.\n',
    ...section(
      RESOLVED,
      'Each thesis the after_close cycle resolved, as its cycle doc records it, and the reason its resolved doc records.',
      { resolved: bind('thesesResolved'), reasons: bind('reasons') },
    ),
    ...section(
      METRICS,
      'Theses formed over the day against the theses-per-day cap, theses resolved by the after_close cycle, gross exposure against its cap, the regime state and the faults the cycle doc names.',
      bind('processMetrics'),
    ),
    ...section(
      ARMS,
      'Each arm’s theses formed, open and resolved by outcome, as the after_close snapshot counts them from the ledger. The ledger records no R for a resolution, so the table holds no expectancy in R.',
      bind('armTable'),
    ),
    ...section(
      COST,
      'What the cycle doc records: orders submitted, deferred and failed, and the projected gross exposure. The cycle doc records no spend.',
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

const WRITE_JOURNAL_TASK = {
  taskId: WRITE_JOURNAL_TASK_ID,
  name: 'Write the journal',
  goal: `Write the day’s journal at ${JOURNAL_PATH_TEMPLATE} from the reflection and the after_close docs. One path per trading day, upserted, so a re-run rewrites the same journal.`,
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [REFLECT_TASK_ID],
  when: {
    expression: `tasks.${REFLECT_TASK_ID}.output.tradingDay != null`,
    onMissingRef: 'skip' as const,
  },
  optional: true,
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: output(REFLECT_TASK_ID, 'tradingDay'),
    reasons: output(REFLECT_TASK_ID, 'reasons'),
    processMetrics: output(REFLECT_TASK_ID, 'processMetrics'),
    candidateChanges: output(REFLECT_TASK_ID, 'candidateChanges'),
    thesesResolved: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc.thesesResolved'),
    submittedCount: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc.submittedCount'),
    deferredCount: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc.deferredCount'),
    failedCount: output(READ_CLOSE_CYCLE_DOC_TASK_ID, 'cycleDoc.failedCount'),
    projectedGrossExposurePct: output(
      READ_CLOSE_CYCLE_DOC_TASK_ID,
      'cycleDoc.projectedGrossExposurePct',
    ),
    armTable: output(READ_CLOSE_SNAPSHOT_TASK_ID, 'snapshot.armTable'),
  },
  inputTemplate: {
    path: { $concat: ['/journal/', bind('tradingDay'), '.md'] },
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: { inlineText: JOURNAL_TEXT },
    writeMode: 'upsert',
  },
  outputProjection: { journalPath: { path: 'path', onMissing: 'error' as const } },
  // The journal path and nothing else. No task binds it.
  outputContract: {
    schema: {
      type: 'object',
      required: ['journalPath'],
      additionalProperties: false,
      properties: { journalPath: { type: 'string', pattern: JOURNAL_PATH_PATTERN } },
    },
  },
};

/** The after-close journal tasks, after the cycle doc in the cycle's task order. */
export const JOURNAL_TASKS = [
  READ_CLOSE_CYCLE_DOC_TASK,
  READ_CLOSE_SNAPSHOT_TASK,
  REFLECT_TASK,
  WRITE_JOURNAL_TASK,
];
