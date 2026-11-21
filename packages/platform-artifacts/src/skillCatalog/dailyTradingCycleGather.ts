/**
 * The context a Daily Trading Cycle gathers after resolution and decides on:
 * the day's calendar from a calendar source the space may bind, the market
 * regime from the market-data binding, and the day's pre-market research
 * note. The persistence steps write the regime, with the calendar, onto the
 * cycle doc and the snapshot from the tasks that produced it, so no agent
 * copies it into the record.
 */
import { DAILY_CYCLE_GATHER_REGIME_PROMPT } from './dailyTradingCycleProse.js';
import {
  CALENDAR_SOURCE_API_ID,
  CALENDAR_SOURCE_ENDPOINT_ID,
  GATHER_REGIME_OUTPUT_SCHEMA,
  GATHER_REGIME_PINS,
  MARKET_REGIME_FIELDS,
  MARKET_REGIME_VALIDATOR_REF,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
} from './dailyTradingCycleRegime.js';

export const CYCLE_PROCEED_GATE = {
  expression: 'tasks.resolve-theses.output.proceed == true',
  onMissingRef: 'skip' as const,
};

/** What a calendar source answers for one date. */
export const CALENDAR_SCHEMA = {
  type: 'object',
  required: ['date', 'session', 'earlyCloseAt', 'holidayName', 'releases'],
  additionalProperties: true,
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    session: { enum: ['regular', 'half_day', 'holiday'] },
    earlyCloseAt: {
      type: ['string', 'null'],
      maxLength: 40,
      description: 'The exchange-local close time on a half day, else null.',
    },
    holidayName: { type: ['string', 'null'], maxLength: 200 },
    releases: {
      type: 'array',
      maxItems: 50,
      description: 'The known macro releases of the day, in exchange-local time.',
      items: {
        type: 'object',
        required: ['time', 'name'],
        additionalProperties: true,
        properties: {
          time: { type: 'string', maxLength: 40 },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          importance: { enum: ['low', 'medium', 'high', null] },
        },
      },
    },
  },
};

const RESOLVED_TRADING_DAY = {
  kind: 'task_output' as const,
  taskId: 'resolve-theses',
  path: 'tradingDay',
};

const bind = (name: string) => ({ $bind: name });

export const INGEST_CALENDAR_TASK = {
  taskId: 'ingest-calendar',
  name: 'Ingest the day’s calendar',
  goal: 'Read the trading day’s calendar from the calendar source the space binds: the session kind (regular, half day, holiday), an early close, and the known macro releases. A space that binds no calendar source fails this optional task, and the cycle runs without a calendar.',
  type: 'operation' as const,
  operation: 'api.http.call',
  dependsOn: ['resolve-theses'],
  when: CYCLE_PROCEED_GATE,
  // The source is the space's to bind. Without one the call fails, and a
  // failed optional producer reaches its consumers as an absent input.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { tradingDay: RESOLVED_TRADING_DAY },
  inputTemplate: {
    apiId: CALENDAR_SOURCE_API_ID,
    endpointId: CALENDAR_SOURCE_ENDPOINT_ID,
    params: { date: bind('tradingDay') },
    response: { format: 'json' },
  },
  outputProjection: { calendar: { path: 'data', onMissing: 'error' as const } },
  outputContract: {
    schema: {
      type: 'object',
      required: ['calendar'],
      additionalProperties: false,
      properties: { calendar: CALENDAR_SCHEMA },
    },
  },
};

export const GATHER_REGIME_TASK = {
  taskId: 'gather-regime',
  name: 'Gather the market regime',
  goal: DAILY_CYCLE_GATHER_REGIME_PROMPT,
  type: 'agent' as const,
  dependsOn: ['ingest-calendar'],
  when: CYCLE_PROCEED_GATE,
  inputBindings: {
    tradingDay: RESOLVED_TRADING_DAY,
    slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
    clockTimestamp: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'timestamp' },
    marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
    universe: { kind: 'campaign_input' as const, path: 'universe' },
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: {
      operations: ['memory.store.get', 'memory.store.query'],
      integrations: [
        {
          capabilityId: 'alpaca-market-data-default',
          binding: { kind: 'binding' as const, bindingId: 'alpaca-market-data-default' },
          sourceKind: 'api' as const,
          integrationId: 'alpaca-market-data',
          toolNames: [
            { toolName: 'get_v2_stocks_bars' },
            { toolName: 'get_v2_stocks_symbol_bars' },
          ],
          allTools: false,
        },
      ],
    },
  },
  outputContract: {
    schema: GATHER_REGIME_OUTPUT_SCHEMA,
    derivedFrom: GATHER_REGIME_PINS,
    validatorRefs: [MARKET_REGIME_VALIDATOR_REF],
  },
};

export const READ_PRE_MARKET_TASK = {
  taskId: 'read-pre-market',
  name: 'Read the pre-market note',
  goal: `Read the day’s pre-market research note at ${PRE_MARKET_NOTE_PATH_TEMPLATE}, at most ${String(PRE_MARKET_EVIDENCE_MAX_CHARS)} characters of it, as evidence for decide. A longer note arrives cut at the cap and marked truncated. No note reads as absent.`,
  type: 'operation' as const,
  operation: 'memory.store.get',
  dependsOn: ['resolve-theses'],
  when: CYCLE_PROCEED_GATE,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: RESOLVED_TRADING_DAY },
  inputTemplate: {
    target: { path: { $concat: ['/research/', bind('tradingDay'), '/pre-market.md'] } },
    view: 'content',
    ifMissing: 'absent',
    byteRange: { start: 0, end: PRE_MARKET_EVIDENCE_MAX_CHARS },
    maxBytes: PRE_MARKET_EVIDENCE_MAX_CHARS,
  },
  outputProjection: {
    path: { path: 'stat.path', onMissing: 'null' as const },
    text: { path: 'data', onMissing: 'null' as const },
    totalChars: { path: 'range.totalChars', onMissing: 'null' as const },
    truncated: { path: 'range.hasMore', onMissing: 'null' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['path', 'text', 'totalChars', 'truncated'],
      additionalProperties: false,
      properties: {
        path: {
          type: ['string', 'null'],
          description: 'The note read, or null when the day has none.',
        },
        text: {
          type: ['string', 'null'],
          maxLength: PRE_MARKET_EVIDENCE_MAX_CHARS,
          description: `The note’s first ${String(PRE_MARKET_EVIDENCE_MAX_CHARS)} characters at most.`,
        },
        totalChars: { type: ['integer', 'null'], minimum: 0 },
        truncated: {
          type: ['boolean', 'null'],
          description: 'true when the note is longer than the text holds.',
        },
      },
      allOf: [
        {
          if: { properties: { path: { type: 'null' } } },
          then: {
            properties: {
              text: { type: 'null' },
              totalChars: { type: 'null' },
              truncated: { type: 'null' },
            },
          },
        },
      ],
    },
  },
};

// ── Persistence: the record's docs with the regime they were decided under ──

const REGIME_BIND_PREFIX = 'regime_';

interface TaskOutputBinding {
  kind: 'task_output';
  taskId: string;
  path: string;
}

const output = (taskId: string, path: string): TaskOutputBinding => ({
  kind: 'task_output',
  taskId,
  path,
});

const MARKET_REGIME_BINDINGS: Record<string, TaskOutputBinding> = {
  ...Object.fromEntries(
    MARKET_REGIME_FIELDS.map((field) => [
      `${REGIME_BIND_PREFIX}${field}`,
      output('gather-regime', `marketRegime.${field}`),
    ]),
  ),
  calendar: output('ingest-calendar', 'calendar'),
};

/** The regime as the docs hold it: the gathered fields, and the calendar or null. */
const MARKET_REGIME_TEMPLATE = {
  ...Object.fromEntries(
    MARKET_REGIME_FIELDS.map((field) => [field, bind(`${REGIME_BIND_PREFIX}${field}`)]),
  ),
  calendar: { $firstOf: [bind('calendar'), null] },
};

/**
 * A doc the record task produced, written field by field with the regime
 * added from its producers. `fields` is the record contract's own list for
 * the doc, so the written doc holds exactly what the contract validated.
 */
function docWithRegime(
  docField: 'cycleDoc' | 'snapshotDoc',
  fields: readonly string[],
  extra: Record<string, TaskOutputBinding> = {},
) {
  const inputBindings: Record<string, TaskOutputBinding> = {
    ...Object.fromEntries(fields.map((field) => [field, output('record', `${docField}.${field}`)])),
    ...extra,
    ...MARKET_REGIME_BINDINGS,
  };
  return {
    inputBindings,
    content: {
      ...Object.fromEntries(fields.map((field) => [field, bind(field)])),
      ...Object.fromEntries(Object.keys(extra).map((field) => [field, bind(field)])),
      marketRegime: MARKET_REGIME_TEMPLATE,
    },
  };
}

function writeDoc(
  pathField: 'cycleDocPath' | 'snapshotDocPath',
  doc: ReturnType<typeof docWithRegime>,
) {
  return {
    type: 'operation' as const,
    operation: 'memory.store.put',
    when: CYCLE_PROCEED_GATE,
    retryability: 'safe' as const,
    inputBindings: { ...doc.inputBindings, [pathField]: output('record', pathField) },
    inputTemplate: {
      path: bind(pathField),
      docType: 'json',
      mimeType: 'application/json',
      content: { inlineJson: doc.content },
      writeMode: 'upsert',
      indexing: 'disabled',
    },
  };
}

export function writeSnapshotTask(snapshotFields: readonly string[]) {
  return {
    taskId: 'write-snapshot',
    name: 'Write snapshot',
    goal: 'Persist the validated snapshot at its contract path, with the market regime and calendar the cycle gathered.',
    dependsOn: ['record'],
    ...writeDoc('snapshotDocPath', docWithRegime('snapshotDoc', snapshotFields)),
  };
}

export function writeCycleDocTask(cycleDocFields: readonly string[]) {
  return {
    taskId: 'write-cycle-doc',
    name: 'Write cycle doc',
    goal: 'Persist the validated cycle doc at its contract path, with decide’s bias and the market regime and calendar it decided under. Its existence marks the cycle complete, so it is written last, after every other persistence step.',
    dependsOn: ['write-snapshot', 'record-learnings'],
    ...writeDoc(
      'cycleDocPath',
      docWithRegime('cycleDoc', cycleDocFields, {
        bias: output('decide', 'bias'),
      }),
    ),
  };
}
