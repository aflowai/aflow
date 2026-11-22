/**
 * The context a Daily Trading Cycle gathers after resolution and decides on:
 * the day's calendar from a calendar source the space may bind, the market
 * regime from the market-data binding, and the day's pre-market research
 * note. Each is optional to the cycle: a cycle whose regime cannot be
 * gathered decides under the state `unavailable` and still closes, records
 * and completes. The persistence steps write the state, the regime or null,
 * and the calendar or null onto the cycle doc and the snapshot from the tasks
 * that produced them, so no agent copies them into the record.
 */
import { DAILY_CYCLE_GATHER_REGIME_PROMPT } from './dailyTradingCycleProse.js';
import {
  CALENDAR_SOURCE_API_ID,
  CALENDAR_SOURCE_ENDPOINT_ID,
  DECIDE_MARKET_STATES,
  GATHER_REGIME_OUTPUT_SCHEMA,
  GATHER_REGIME_PINS,
  MARKET_REGIME_VALIDATOR_REF,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  INDEX_LOOKBACK_SESSIONS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
  READ_INDEX_BARS_TASK_ID,
  READ_UNIVERSE_BARS_TASK_ID,
  REGIME_INDEXES,
  REGIME_READ_BINDING_ID,
  REGIME_STATES,
  REGIME_UNAVAILABLE,
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

/** 100 calendar days of daily bars hold the 50 completed sessions a 50-day average needs. */
const INDEX_BARS_LOOKBACK_MS = 100 * 24 * 60 * 60_000;

const INDEX_BARS_SCHEMA = {
  type: 'array',
  minItems: INDEX_LOOKBACK_SESSIONS,
  items: {
    type: 'object',
    required: ['t', 'c'],
    additionalProperties: true,
    properties: {
      t: { type: 'string', minLength: 10 },
      c: { type: 'number', exclusiveMinimum: 0 },
    },
  },
};

/**
 * The index closes the regime computes from, read through the market-data
 * binding by the platform rather than by an agent. The read is one page: a
 * paged answer fails this optional task, and the cycle decides unavailable.
 */
export const READ_INDEX_BARS_TASK = {
  taskId: READ_INDEX_BARS_TASK_ID,
  name: 'Read the index bars',
  goal: `Read the daily bars of ${REGIME_INDEXES.join(', ')} over the last 100 calendar days through the market-data binding, for the regime. A read that fails leaves the cycle without a regime: it decides under ${REGIME_UNAVAILABLE}, and its closes still run.`,
  type: 'operation' as const,
  operation: 'api.http.call',
  dependsOn: ['resolve-theses'],
  when: CYCLE_PROCEED_GATE,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: {
    start: { kind: 'clock' as const, offsetMs: -INDEX_BARS_LOOKBACK_MS, format: 'iso' as const },
  },
  inputTemplate: {
    apiId: 'alpaca-market-data',
    bindingId: REGIME_READ_BINDING_ID,
    endpointId: 'get_v2_stocks_bars',
    params: {
      symbols: REGIME_INDEXES.join(','),
      timeframe: '1Day',
      start: bind('start'),
      limit: 1000,
      feed: 'iex',
      adjustment: 'all',
      sort: 'asc',
    },
    response: { format: 'json' },
  },
  outputProjection: {
    bars: { path: 'data.bars', onMissing: 'error' as const },
    nextPageToken: { path: 'data.next_page_token', onMissing: 'null' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['bars', 'nextPageToken'],
      additionalProperties: false,
      properties: {
        bars: {
          type: 'object',
          required: [...REGIME_INDEXES],
          additionalProperties: true,
          properties: Object.fromEntries(REGIME_INDEXES.map((i) => [i, INDEX_BARS_SCHEMA])),
        },
        nextPageToken: {
          type: 'null',
          description: 'null: the read holds every bar. A paged read fails this task.',
        },
      },
    },
  },
};

/**
 * The limit counts bars across every symbol. Thirty members over the index
 * lookback stay far under it, and that lookback leaves room for a member the
 * feed has no bar for on some sessions.
 */
const UNIVERSE_BARS_LIMIT = 10_000;

/**
 * The member closes the breadth share computes from, read through the
 * market-data binding by the platform rather than by an agent, so no member
 * close is the agent's own. The read is one page: a paged answer fails this
 * optional task, and the cycle decides unavailable.
 */
export const READ_UNIVERSE_BARS_TASK = {
  taskId: READ_UNIVERSE_BARS_TASK_ID,
  name: 'Read the universe bars',
  goal: `Read the daily bars of every campaign universe member over the last 100 calendar days through the market-data binding, for the regime's breadth. A read that fails leaves the cycle without a regime: it decides under ${REGIME_UNAVAILABLE}, and its closes still run.`,
  type: 'operation' as const,
  operation: 'api.http.call',
  dependsOn: ['resolve-theses'],
  when: CYCLE_PROCEED_GATE,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: {
    start: {
      kind: 'clock' as const,
      offsetMs: -INDEX_BARS_LOOKBACK_MS,
      format: 'iso' as const,
    },
    universe: { kind: 'campaign_input' as const, path: 'universe' },
  },
  inputTemplate: {
    apiId: 'alpaca-market-data',
    bindingId: REGIME_READ_BINDING_ID,
    endpointId: 'get_v2_stocks_bars',
    params: {
      symbols: { $join: [bind('universe'), ','] },
      timeframe: '1Day',
      start: bind('start'),
      limit: UNIVERSE_BARS_LIMIT,
      feed: 'iex',
      adjustment: 'all',
      sort: 'asc',
    },
    response: { format: 'json' },
  },
  outputProjection: {
    bars: { path: 'data.bars', onMissing: 'error' as const },
    nextPageToken: { path: 'data.next_page_token', onMissing: 'null' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['bars', 'nextPageToken'],
      additionalProperties: false,
      properties: {
        bars: {
          type: 'object',
          description:
            'Each member’s daily bars by symbol, oldest first. A member the feed has no bars for is absent.',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              required: ['t', 'c'],
              additionalProperties: true,
              properties: {
                t: { type: 'string', minLength: 10 },
                c: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
        nextPageToken: {
          type: 'null',
          description: 'null: the read holds every bar. A paged read fails this task.',
        },
      },
    },
  },
};

export const GATHER_REGIME_TASK = {
  taskId: 'gather-regime',
  name: 'Gather the market regime',
  goal: DAILY_CYCLE_GATHER_REGIME_PROMPT,
  type: 'agent' as const,
  dependsOn: ['ingest-calendar', READ_INDEX_BARS_TASK_ID, READ_UNIVERSE_BARS_TASK_ID],
  when: CYCLE_PROCEED_GATE,
  // A regime that cannot be gathered must not stop the cycle's closes, its
  // record or its completion marker. regime-state names it unavailable.
  optional: true,
  inputBindings: {
    tradingDay: RESOLVED_TRADING_DAY,
    slot: { kind: 'task_output' as const, taskId: 'resolve-theses', path: 'slot' },
    clockTimestamp: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'timestamp' },
    marketIsOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'isOpen' },
    nextOpen: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'nextOpen' },
    nextClose: { kind: 'task_output' as const, taskId: 'ingest-clock', path: 'nextClose' },
    indexBars: { kind: 'task_output' as const, taskId: READ_INDEX_BARS_TASK_ID, path: 'bars' },
    memberBars: {
      kind: 'task_output' as const,
      taskId: READ_UNIVERSE_BARS_TASK_ID,
      path: 'bars',
    },
    universe: { kind: 'campaign_input' as const, path: 'universe' },
  },
  // Every close comes from the platform's reads, so the agent reads no feed.
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: { operations: ['memory.store.get', 'memory.store.query'], integrations: [] },
  },
  outputContract: {
    schema: GATHER_REGIME_OUTPUT_SCHEMA,
    derivedFrom: GATHER_REGIME_PINS,
    validatorRefs: [MARKET_REGIME_VALIDATOR_REF],
  },
};

/**
 * The state decide is pinned to: the gathered regime's, or `unavailable`
 * where gather-regime failed. A rule step always succeeds, so decide's pin
 * has a producer on every cycle.
 */
export const REGIME_STATE_TASK = {
  taskId: 'regime-state',
  name: 'Name the regime state',
  goal: `Name the market-regime state this cycle decides under: the gathered regime's state, or ${REGIME_UNAVAILABLE} when gather-regime produced no regime.`,
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: ['gather-regime'],
  when: CYCLE_PROCEED_GATE,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    regimeState: {
      kind: 'task_output' as const,
      taskId: 'gather-regime',
      path: 'marketRegime.state',
    },
  },
  inputTemplate: {
    state: { regimeState: bind('regimeState') },
    rules: REGIME_STATES.map((state) => ({
      when: { expression: `state.regimeState == '${state}'` },
      decision: state,
      reason: `The gathered regime is ${state}. Its regimeCaps entry holds the decision.`,
    })),
    otherwise: {
      decision: REGIME_UNAVAILABLE,
      reason:
        'gather-regime produced no regime, so the decision opens no new thesis. Its closes still run.',
    },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['decision'],
      additionalProperties: true,
      properties: { decision: { enum: [...DECIDE_MARKET_STATES] } },
    },
  },
};

/**
 * The state the cycle decided under: decide's marketState, or `unavailable`
 * where decide failed. decide is optional, so a decision that cannot be made
 * or checked, a validator fault included, never stops the closes after it. A
 * rule step always succeeds, so the record and the docs have a state on every
 * cycle.
 */
export const DECISION_STATE_TASK = {
  taskId: 'decision-state',
  name: 'Name the decided state',
  goal: `Name the market-regime state this cycle decided under: decide's marketState, or ${REGIME_UNAVAILABLE} when decide produced no decision.`,
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: ['decide'],
  when: CYCLE_PROCEED_GATE,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    decidedState: { kind: 'task_output' as const, taskId: 'decide', path: 'marketState' },
  },
  inputTemplate: {
    state: { decidedState: bind('decidedState') },
    rules: DECIDE_MARKET_STATES.map((state) => ({
      when: { expression: `state.decidedState == '${state}'` },
      decision: state,
      reason: `decide decided under ${state}.`,
    })),
    otherwise: {
      decision: REGIME_UNAVAILABLE,
      reason:
        'decide produced no decision, so this cycle opened no thesis. Its closes, repair closes and orphan flattens still ran.',
    },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['decision'],
      additionalProperties: true,
      properties: { decision: { enum: [...DECIDE_MARKET_STATES] } },
    },
  },
};

/**
 * Why decide produced no decision: the failure its task recorded, whatever
 * failed it. It is absent where decide decided.
 */
export const DECISION_FAULT_BINDING = { kind: 'task_failure' as const, taskId: 'decide' };

/** The record's view of the decision: the state it was made under, and the fault where decide failed. */
export const DECISION_STATE_BINDINGS = {
  marketState: {
    kind: 'task_output' as const,
    taskId: DECISION_STATE_TASK.taskId,
    path: 'decision',
  },
  decisionFault: DECISION_FAULT_BINDING,
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

/** The context tasks between resolution and decide, in the cycle's task order. */
export const REGIME_CONTEXT_TASKS = [
  INGEST_CALENDAR_TASK,
  READ_INDEX_BARS_TASK,
  READ_UNIVERSE_BARS_TASK,
  GATHER_REGIME_TASK,
  REGIME_STATE_TASK,
  READ_PRE_MARKET_TASK,
];

// ── Persistence: the record's docs with the regime they were decided under ──

interface TaskOutputBinding {
  kind: 'task_output';
  taskId: string;
  path: string;
}

type DocBinding = TaskOutputBinding | typeof DECISION_FAULT_BINDING;

const output = (taskId: string, path: string): TaskOutputBinding => ({
  kind: 'task_output',
  taskId,
  path,
});

const MARKET_REGIME_BINDINGS: Record<string, TaskOutputBinding> = {
  marketState: output(DECISION_STATE_TASK.taskId, 'decision'),
  marketRegime: output('gather-regime', 'marketRegime'),
  calendar: output('ingest-calendar', 'calendar'),
};

/**
 * The regime as the docs hold it: the state the cycle decided under, the
 * gathered regime or null where it was unavailable, and the calendar or null.
 */
const MARKET_REGIME_TEMPLATE = {
  marketState: bind('marketState'),
  marketRegime: { $firstOf: [bind('marketRegime'), null] },
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
  nullable: Record<string, DocBinding> = {},
) {
  const inputBindings: Record<string, DocBinding> = {
    ...Object.fromEntries(fields.map((field) => [field, output('record', `${docField}.${field}`)])),
    ...extra,
    ...nullable,
    ...MARKET_REGIME_BINDINGS,
  };
  return {
    inputBindings,
    content: {
      ...Object.fromEntries(fields.map((field) => [field, bind(field)])),
      ...Object.fromEntries(Object.keys(extra).map((field) => [field, bind(field)])),
      ...Object.fromEntries(
        Object.keys(nullable).map((field) => [field, { $firstOf: [bind(field), null] }]),
      ),
      ...MARKET_REGIME_TEMPLATE,
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
    goal: 'Persist the validated snapshot at its contract path, with the regime state, the market regime and the calendar the cycle gathered. A regime or calendar the cycle could not gather is written as null.',
    dependsOn: ['record'],
    ...writeDoc('snapshotDocPath', docWithRegime('snapshotDoc', snapshotFields)),
  };
}

export function writeCycleDocTask(cycleDocFields: readonly string[]) {
  return {
    taskId: 'write-cycle-doc',
    name: 'Write cycle doc',
    goal: 'Persist the validated cycle doc at its contract path, with decide’s bias, the regime state, market regime and calendar it decided under, the provenance of the read the regime was computed from, and the decision fault. A regime, read, calendar or bias the cycle could not produce is written as null, and the decision fault is null where decide decided. Its existence marks the cycle complete, so it is written last, after every other persistence step.',
    dependsOn: ['write-snapshot', 'record-learnings'],
    ...writeDoc(
      'cycleDocPath',
      docWithRegime(
        'cycleDoc',
        cycleDocFields,
        {},
        {
          // Null where decide produced no decision.
          bias: output('decide', 'bias'),
          // The provenance of the closes the regime was computed from, or null
          // where it could not be gathered.
          regimeRead: output('gather-regime', 'read'),
          // The failure decide recorded when it failed, whatever failed it, or null.
          decisionFault: DECISION_FAULT_BINDING,
        },
      ),
    ),
  };
}
