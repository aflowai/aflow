import type { SkillCatalogEntry } from '@aflow/schemas';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  DESK_REVIEW_TASKS,
  LENS_FINDING_BINDINGS,
  LENS_FINDINGS,
  REVIEWING,
} from './strategyDeskLenses.js';
import {
  DESK_INDEX_SYMBOLS,
  DESK_READ_LEDGER_PROMPT,
  DESK_STRATEGIST_TASK,
} from './strategyDeskProse.js';
import {
  barsTaskId,
  DESK_RECORD_PATH,
  DESK_REVIEW_TASK_ID,
  FRAME_OTHERWISE,
  FRAME_RULES,
  FRAME_TASK_ID,
  MEMO_FOLDER_PATH,
  MEMO_MEMORY_PATH,
  PROPOSAL_OTHERWISE,
  PROPOSAL_RULES,
  PROPOSAL_TASK_ID,
  READ_CAMPAIGN_TASK_ID,
  READ_LEDGER_TASK_ID,
  READ_SET_TASK_ID,
  REVIEW_STATE_OTHERWISE,
  REVIEW_STATE_TASK_ID,
  reviewStateRules,
  SET_PATH,
  STRATEGIST_RESULT_SCHEMA,
  STRATEGIST_TASK_ID,
  STRATEGY_DESK_SLUG,
  WRITE_FOLDER_MEMO_TASK_ID,
  WRITE_MEMO_TASK_ID,
  WRITE_RECORD_TASK_ID,
  WRITE_SET_TASK_ID,
} from './strategyDeskRules.js';
import { DESK_TALLY_RULE } from './strategyDeskTally.js';
import {
  CAMPAIGN_CONTRACT_INPUT,
  CAMPAIGN_CONTRACT_PROJECTION,
  campaignContractBindings,
} from './tradingCampaignRead.js';
import {
  DEFAULT_GOALS_PATH,
  DEFAULT_PRINCIPLES_PATH,
  readStrategyFileTasks,
  STRATEGY_FILE_INPUTS,
} from './strategyPrinciples.js';

/**
 * The Strategy Desk: one run that writes the day's approved set. A
 * strategist on the harness proposes candidates, seven lenses review them
 * side by side, and a desk reviewer reads the lens findings and may veto a
 * candidate with a stated reason. The set keeps every candidate, finding and
 * veto, and `tallyReview` decides what is approved wherever the set is read.
 * A cycle that finds no set for its day starts this skill and waits for it,
 * so a desk and a cycle run in one firing and neither waits on a schedule.
 */

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      "The connected folder holding the desk's journals, strategy records, boundary rules and operator notes. Every harness run works in a checkout of it. The research memo is also written into it where the folder allows writes.",
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'tradingDay',
    required: true,
    description:
      'The trading day the desk prepares, YYYY-MM-DD in exchange time. A schedule passes { "$now": "date" }. A cycle that starts the desk passes its own trading day.',
    schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
  {
    id: 'harness',
    required: false,
    description:
      "Which coding agent runs the strategist, by the id the operator configured on the machine. Absent, the space's preferred coding agent, else the machine's default.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'model',
    required: false,
    description:
      'The model the strategist runs, spelled as its coding agent names it. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewHarness',
    required: false,
    description:
      "Which coding agent runs the lenses and the desk reviewer. Name one other than the strategist's where the machine has a second, so the review is a second opinion. Absent, the space's preferred coding agent.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewModel',
    required: false,
    description:
      'The model the lenses and the desk reviewer run. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
  ...STRATEGY_FILE_INPUTS,
];

const FRAMED = {
  expression: `tasks.${FRAME_TASK_ID}.output.decision == 'desk'`,
  onMissingRef: SKIP,
};

const HARNESS_TIMEOUT_MS = 40 * 60_000;

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign contract',
  goal: 'Read the active Daily Trading Cycle campaign: its id and its contract, whose arms and universe define what a trade is.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: {
    campaignId: { path: 'campaigns[0].campaign.campaignId', onMissing: 'null' as const },
    ...CAMPAIGN_CONTRACT_PROJECTION,
    universe: { path: 'campaigns[0].campaign.config.universe', onMissing: 'null' as const },
  },
};

const FRAME_TASK = {
  taskId: FRAME_TASK_ID,
  name: 'Frame the desk',
  goal: 'Decide by rule whether a campaign is active. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_CAMPAIGN_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId') },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { campaignId: bind('campaignId') },
    rules: FRAME_RULES,
    otherwise: FRAME_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'reason', toState: 'frameReason' },
    { kind: 'output_path' as const, path: 'decision', toState: 'deskOutcome' },
  ],
};

/** 320 calendar days of daily bars hold the 200 sessions a 200-day average needs. */
const INDEX_LOOKBACK_MS = 320 * 24 * 60 * 60_000;

function barsTask(symbol: string) {
  return {
    taskId: barsTaskId(symbol),
    name: `Read ${symbol} daily bars`,
    goal: `Read about 220 sessions of ${symbol} daily bars from the market-data feed, for the strategist's regime read. A read that fails leaves the strategist without them.`,
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: [FRAME_TASK_ID],
    when: FRAMED,
    optional: true,
    retryability: 'safe' as const,
    inputBindings: {
      start: { kind: 'clock' as const, offsetMs: -INDEX_LOOKBACK_MS, format: 'iso' as const },
    },
    inputTemplate: {
      apiId: 'alpaca-market-data',
      endpointId: 'get_v2_stocks_symbol_bars',
      params: {
        symbol,
        timeframe: '1Day',
        start: bind('start'),
        limit: 1000,
        feed: 'iex',
        adjustment: 'all',
      },
      response: { format: 'json' },
    },
    outputProjection: { bars: { path: 'data.bars', onMissing: 'null' as const } },
  };
}

const LEDGER_ITEM = (required: string[]) => ({
  type: 'object',
  required: ['path', ...required],
  additionalProperties: true,
  properties: { path: { type: 'string', minLength: 1 } },
});

const FEED_ITEM = (required: string[]) => ({
  type: 'object',
  required: ['source', ...required],
  additionalProperties: true,
  properties: { source: { type: 'string', minLength: 1 } },
});

const READ_LEDGER_TASK = {
  taskId: READ_LEDGER_TASK_ID,
  name: 'Read the ledger',
  goal: DESK_READ_LEDGER_PROMPT,
  type: 'agent' as const,
  dependsOn: [FRAME_TASK_ID],
  when: FRAMED,
  // The strategist reads the folder either way, and says what it lacked.
  optional: true,
  inputBindings: {
    tradingDay: runInput('tradingDay'),
    hypotheses: out(READ_CAMPAIGN_TASK_ID, 'config_hypotheses'),
    universe: out(READ_CAMPAIGN_TASK_ID, 'universe'),
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: {
      // Reads only: the desk writes through its own operation tasks.
      operations: ['memory.store.query', 'memory.store.get'],
      integrations: [
        {
          capabilityId: 'alpaca-market-data-default',
          binding: { kind: 'binding' as const, bindingId: 'alpaca-market-data-default' },
          sourceKind: 'api' as const,
          integrationId: 'alpaca-market-data',
          toolNames: [{ toolName: 'get_v2_stocks_snapshots' }, { toolName: 'get_v1beta1_news' }],
          allTools: false,
        },
      ],
    },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: [
        'openTheses',
        'resolvedTheses',
        'recentCycles',
        'priorDesk',
        'operatorNotes',
        'universeSnapshots',
        'news',
        'journal',
        'hypothesisIds',
        'ledgerNote',
      ],
      additionalProperties: false,
      properties: {
        openTheses: { type: 'array', items: LEDGER_ITEM(['thesisId', 'instrument', 'direction']) },
        resolvedTheses: {
          type: 'array',
          items: LEDGER_ITEM(['thesisId', 'instrument', 'direction', 'outcome']),
        },
        recentCycles: { type: 'array', items: LEDGER_ITEM(['tradingDay', 'slot']) },
        priorDesk: { type: 'array', items: LEDGER_ITEM(['tradingDay', 'outcome']) },
        operatorNotes: { type: 'array', items: LEDGER_ITEM(['text']) },
        universeSnapshots: { type: 'array', items: FEED_ITEM(['symbol']) },
        news: { type: 'array', items: FEED_ITEM(['headline']) },
        journal: { type: 'array', items: LEDGER_ITEM(['tradingDay', 'text']) },
        hypothesisIds: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string' },
          description:
            'The id of every hypothesis arm of the campaign, copied from campaign.hypotheses.',
        },
        ledgerNote: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'What was read, and every read that failed or found nothing.',
        },
      },
    },
    // The arm ids are the campaign's, so the strategist's schema takes them as the arms a candidate may name.
    derivedFrom: [
      {
        bindingId: 'hypothesis-arm-ids',
        from: READ_CAMPAIGN_TASK_ID,
        binding: 'enum:$.config_hypotheses[*].id',
        target: '$.hypothesisIds.items.enum',
      },
    ],
  },
};

/** The set the desk wrote earlier today, which this run refreshes. None reads as null. */
const READ_SET_TASK = {
  taskId: READ_SET_TASK_ID,
  name: 'Read the current set',
  goal: "Read the day's approved set as it stands, so the strategist carries forward what still holds. No set reads as absent.",
  type: 'operation' as const,
  operation: 'memory.store.get',
  dependsOn: [FRAME_TASK_ID],
  when: FRAMED,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { tradingDay: runInput('tradingDay') },
  context: ctx('memory.store.get'),
  inputTemplate: { target: { path: SET_PATH }, view: 'content', ifMissing: 'absent' },
  outputProjection: { content: { path: 'data', onMissing: 'null' as const } },
};

const LEDGER_FIELDS = [
  'openTheses',
  'resolvedTheses',
  'recentCycles',
  'priorDesk',
  'operatorNotes',
  'universeSnapshots',
  'news',
  'journal',
  'ledgerNote',
] as const;

const STRATEGIST_TASK = {
  taskId: STRATEGIST_TASK_ID,
  name: 'Propose candidates',
  goal: "Run the strategist on the harness over the folder: read the journals, strategy records, the ledger and the day's current set, read the regime, and propose the day's candidate theses with a research memo.",
  type: 'operation' as const,
  operation: 'host.harness.run',
  dependsOn: [
    READ_CAMPAIGN_TASK_ID,
    READ_LEDGER_TASK_ID,
    READ_SET_TASK_ID,
    ...DESK_INDEX_SYMBOLS.map(barsTaskId),
  ],
  when: FRAMED,
  // A strategist with no result writes no set, and the next cycle runs the desk again.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    tradingDay: runInput('tradingDay'),
    harness: runInput('harness'),
    model: runInput('model'),
    ...campaignContractBindings(READ_CAMPAIGN_TASK_ID),
    universe: out(READ_CAMPAIGN_TASK_ID, 'universe'),
    hypothesisIds: out(READ_LEDGER_TASK_ID, 'hypothesisIds'),
    currentSet: out(READ_SET_TASK_ID, 'content'),
    ...Object.fromEntries(
      LEDGER_FIELDS.map((field) => [`ledger_${field}`, out(READ_LEDGER_TASK_ID, field)]),
    ),
    ...Object.fromEntries(
      DESK_INDEX_SYMBOLS.map((symbol) => [`bars${symbol}`, out(barsTaskId(symbol), 'bars')]),
    ),
  },
  context: ctx('host.harness.run'),
  inputTemplate: {
    bindingId: bind('bindingId'),
    harness: bind('harness'),
    model: bind('model'),
    task: DESK_STRATEGIST_TASK,
    inputs: {
      tradingDay: bind('tradingDay'),
      campaign: CAMPAIGN_CONTRACT_INPUT,
      currentSet: bind('currentSet'),
      ledger: Object.fromEntries(LEDGER_FIELDS.map((field) => [field, bind(`ledger_${field}`)])),
      indexBars: Object.fromEntries(
        DESK_INDEX_SYMBOLS.map((symbol) => [symbol, bind(`bars${symbol}`)]),
      ),
    },
    outputSchema: STRATEGIST_RESULT_SCHEMA,
    resultRetries: 2,
    timeoutMs: HARNESS_TIMEOUT_MS,
  },
  outputProjection: {
    bias: { path: 'result.bias', onMissing: 'error' as const },
    regimeRead: { path: 'result.regimeRead', onMissing: 'error' as const },
    candidates: { path: 'result.candidates', onMissing: 'error' as const },
    memo: { path: 'result.memo', onMissing: 'error' as const },
    harness: { path: 'harness.id', onMissing: 'null' as const },
  },
};

const PROPOSAL_TASK = {
  taskId: PROPOSAL_TASK_ID,
  name: 'Count the proposal',
  goal: 'Decide by rule whether there is anything to review: the strategist proposed candidates, proposed none, or returned no result. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [FRAME_TASK_ID, STRATEGIST_TASK_ID],
  when: FRAMED,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { candidates: out(STRATEGIST_TASK_ID, 'candidates') },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A strategist that failed binds nothing, so the count reads null.
    state: { candidateCount: { $length: [bind('candidates')] } },
    rules: PROPOSAL_RULES,
    otherwise: PROPOSAL_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'deskOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'deskReason' },
  ],
};

const LENS_TASK_IDS = DESK_REVIEW_TASKS.map((t) => t.taskId).filter(
  (taskId) => taskId !== DESK_REVIEW_TASK_ID,
);

const answeredKey = (taskId: string) => `answered_${taskId.replace(/-/g, '_')}`;

/**
 * Whether any lens answered. A lens that failed binds nothing, so its
 * summary reads null. When every one reads null the desk writes no set.
 */
const REVIEW_STATE_TASK = {
  taskId: REVIEW_STATE_TASK_ID,
  name: 'Count the review',
  goal: 'Decide by rule whether any lens returned a result. A review no lens answered writes no set. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [PROPOSAL_TASK_ID, ...LENS_TASK_IDS],
  when: REVIEWING,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: Object.fromEntries(
    LENS_TASK_IDS.map((taskId) => [answeredKey(taskId), out(taskId, 'summary')]),
  ),
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: Object.fromEntries(
      LENS_TASK_IDS.map((taskId) => [answeredKey(taskId), bind(answeredKey(taskId))]),
    ),
    rules: reviewStateRules(LENS_TASK_IDS.map(answeredKey)),
    otherwise: REVIEW_STATE_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'deskOutcome' },
    { kind: 'output_path' as const, path: 'reason', toState: 'deskReason' },
  ],
};

/** An empty proposal writes the empty set. A proposal writes its set only once a lens answered. */
const SET_WRITTEN = {
  anyOf: [
    `tasks.${PROPOSAL_TASK_ID}.output.decision == 'no_candidates'`,
    `tasks.${REVIEW_STATE_TASK_ID}.output.decision == 'review'`,
  ],
  onMissingRef: SKIP,
};

/**
 * The set holds what the strategist, the lenses and the desk reviewer said,
 * each bound from its own task. A lens that failed binds nothing and its key
 * is left out, which the tally reads as silence. This task is the desk run's
 * worker, so the cycle accepts the set as this run's.
 */
const WRITE_SET_TASK = {
  taskId: WRITE_SET_TASK_ID,
  name: 'Write the approved set',
  goal: "Write the day's set to memory: every candidate, every lens finding and the desk's vetoes. It replaces the set the desk wrote earlier today.",
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [
    PROPOSAL_TASK_ID,
    ...DESK_REVIEW_TASKS.map((task) => task.taskId),
    REVIEW_STATE_TASK_ID,
  ],
  when: SET_WRITTEN,
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: runInput('tradingDay'),
    reviewRunId: { kind: 'run_id' as const },
    candidates: out(STRATEGIST_TASK_ID, 'candidates'),
    vetoes: out(DESK_REVIEW_TASK_ID, 'vetoes'),
    deskSummary: out(DESK_REVIEW_TASK_ID, 'summary'),
    ...LENS_FINDING_BINDINGS,
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: SET_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        tradingDay: bind('tradingDay'),
        reviewRunId: bind('reviewRunId'),
        rule: DESK_TALLY_RULE,
        candidates: bind('candidates'),
        lenses: LENS_FINDINGS,
        vetoes: { $firstOf: [bind('vetoes'), []] },
        deskSummary: { $firstOf: [bind('deskSummary'), null] },
      },
    },
    writeMode: 'upsert',
    indexing: 'disabled',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'approvedSetPath' }],
};

const HAS_MEMO = {
  expression: `tasks.${STRATEGIST_TASK_ID}.output.memo != null`,
  onMissingRef: SKIP,
};

const MEMO_BINDINGS = {
  tradingDay: runInput('tradingDay'),
  deskRunId: { kind: 'run_id' as const },
  memo: out(STRATEGIST_TASK_ID, 'memo'),
};

const WRITE_MEMO_TASK = {
  taskId: WRITE_MEMO_TASK_ID,
  name: 'Mirror the research memo to memory',
  goal: 'Write the research memo to memory beside the set, under the research path of the trading day.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [STRATEGIST_TASK_ID],
  when: HAS_MEMO,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: MEMO_BINDINGS,
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: MEMO_MEMORY_PATH,
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: { inlineText: bind('memo') },
    writeMode: 'upsert',
  },
};

const WRITE_FOLDER_MEMO_TASK = {
  taskId: WRITE_FOLDER_MEMO_TASK_ID,
  name: 'Write the research memo to the folder',
  goal: 'Write the research memo into the folder, under research/{tradingDay}/. A folder that allows no writes keeps the folder as it is.',
  type: 'operation' as const,
  operation: 'host.file.put',
  dependsOn: [STRATEGIST_TASK_ID],
  when: HAS_MEMO,
  optional: true,
  // Create-only: a second attempt would meet the file the first wrote.
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: { bindingId: runInput('bindingId'), ...MEMO_BINDINGS },
  context: ctx('host.file.put'),
  inputTemplate: { bindingId: bind('bindingId'), path: MEMO_FOLDER_PATH, content: bind('memo') },
};

const WRITE_RECORD_TASK = {
  taskId: WRITE_RECORD_TASK_ID,
  name: 'Record the desk run',
  goal: 'Write the record of this desk run to memory: how it ended and why, with each lens summary and the desk reviewer summary.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [
    FRAME_TASK_ID,
    PROPOSAL_TASK_ID,
    WRITE_SET_TASK_ID,
    ...DESK_REVIEW_TASKS.map((t) => t.taskId),
    REVIEW_STATE_TASK_ID,
  ],
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: runInput('tradingDay'),
    deskRunId: { kind: 'run_id' as const },
    frame: out(FRAME_TASK_ID, 'decision'),
    frameReason: out(FRAME_TASK_ID, 'reason'),
    outcome: out(PROPOSAL_TASK_ID, 'decision'),
    reason: out(PROPOSAL_TASK_ID, 'reason'),
    reviewOutcome: out(REVIEW_STATE_TASK_ID, 'decision'),
    reviewReason: out(REVIEW_STATE_TASK_ID, 'reason'),
    approvedSetPath: out(WRITE_SET_TASK_ID, 'path'),
    strategistHarness: out(STRATEGIST_TASK_ID, 'harness'),
    deskSummary: out(DESK_REVIEW_TASK_ID, 'summary'),
    ...Object.fromEntries(
      LENS_TASK_IDS.map((taskId) => [`summary_${taskId}`, out(taskId, 'summary')]),
    ),
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: DESK_RECORD_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        tradingDay: bind('tradingDay'),
        deskRunId: bind('deskRunId'),
        outcome: { $firstOf: [bind('reviewOutcome'), bind('outcome'), bind('frame')] },
        reason: { $firstOf: [bind('reviewReason'), bind('reason'), bind('frameReason')] },
        approvedSetPath: { $firstOf: [bind('approvedSetPath'), null] },
        strategistHarness: { $firstOf: [bind('strategistHarness'), null] },
        deskSummary: { $firstOf: [bind('deskSummary'), null] },
        lensSummaries: Object.fromEntries(
          LENS_TASK_IDS.map((taskId) => [taskId, { $firstOf: [bind(`summary_${taskId}`), null] }]),
        ),
      },
    },
    writeMode: 'upsert',
    indexing: 'disabled',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'deskRecordPath' }],
};

export const STRATEGY_DESK_TASKS = [
  READ_CAMPAIGN_TASK,
  FRAME_TASK,
  ...DESK_INDEX_SYMBOLS.map(barsTask),
  READ_LEDGER_TASK,
  READ_SET_TASK,
  ...readStrategyFileTasks({ dependsOn: [FRAME_TASK_ID], when: FRAMED }),
  STRATEGIST_TASK,
  PROPOSAL_TASK,
  ...DESK_REVIEW_TASKS,
  REVIEW_STATE_TASK,
  WRITE_SET_TASK,
  WRITE_MEMO_TASK,
  WRITE_FOLDER_MEMO_TASK,
  WRITE_RECORD_TASK,
];

const stateVariable = (
  variableId: string,
  name: string,
  description: string,
  writers?: 'alternatives' | 'append',
) => ({
  variableId,
  name,
  description,
  required: false,
  sensitive: false,
  immutable: false,
  ...(writers !== undefined ? { writers } : {}),
});

const DESK_PITFALLS: string[] = [
  'What it needs: the connected folder and the trading day. A schedule passes tradingDay as { "$now": "date" }. A Daily Trading Cycle whose schedule passes bindingId starts the desk itself when its day has no set, and waits for it.',
  `One run writes one set for the whole trading day. A later desk run replaces it with its own view, and its strategist reads the current set to carry forward what still holds. ${DESK_TALLY_RULE}`,
  'A strategist with no result writes no set, so the next cycle runs the desk again. A strategist that proposes nothing writes an empty set, and the day opens nothing from it until a desk runs again. A review where no lens returned a result writes no set either, and the desk ends review_failed.',
  'reviewHarness and reviewModel name a second opinion. Name a coding agent or a model other than the strategist’s where the machine has one.',
  `The principles lens reads ${DEFAULT_GOALS_PATH} and ${DEFAULT_PRINCIPLES_PATH} in the folder, or the goalsPath and principlesPath inputs. The Desk Charter skill writes both files.`,
];

const STRATEGY_DESK: SkillCatalogEntry = {
  catalogId: STRATEGY_DESK_SLUG,
  version: 9,
  name: 'Strategy Desk',
  tagline:
    'A strategist, seven review lenses and a desk reviewer on the harness write the day’s approved set.',
  description: `Writes the day's approved set for the Daily Trading Cycle. A **strategist** on the machine’s coding agent reads the journals and strategy records in the connected folder, the campaign ledger and the day's current set, reads the regime, and proposes candidate theses with a research memo. Seven **review lenses** review the candidates side by side: fundamentals, macro, technical, prior learnings, prior decisions, risk and principles. A **desk reviewer** reads every lens finding and may veto a candidate with a stated reason. ${DESK_TALLY_RULE}

The set at \`/research/{tradingDay}/approved-theses.json\` keeps every candidate, finding and veto, and the tally is computed wherever the set is read. A cycle of any slot reads the current set when it decides, and a cycle that finds none starts the desk and waits for it.`,
  tags: ['alpaca', 'trading', 'paper', 'theses', 'research', 'review'],
  bundle: {
    workflow: {
      slug: STRATEGY_DESK_SLUG,
      name: 'Strategy Desk',
      description:
        'One review pass for a trading day: a strategist harness run proposes candidates, seven lens harness runs review them, a desk reviewer may veto with a stated reason, and the day’s set is written with every finding.',
      usage: {
        whenToUse: [
          'Writing or refreshing the day’s approved set: on a schedule before the open, on new information during the session, or started by a Daily Trading Cycle that found no set',
        ],
        whenNotToUse: [
          'Resolving, deciding or executing a cycle — that is the Daily Trading Cycle',
          'Changing the campaign — it changes at a campaign boundary',
        ],
        next: [
          {
            skill: CYCLE_WORKFLOW_SLUG,
            when: 'Every cycle reads the current set when it decides, so nothing waits on the desk to start one.',
          },
        ],
        pitfalls: DESK_PITFALLS,
      },
      goal: 'Write the day’s approved set: every candidate the strategist proposed, what each lens said and the desk reviewer’s vetoes.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'desk-settled',
          name: 'Desk settled',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The desk wrote the day’s set naming its run, or recorded why it wrote none.',
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: STRATEGY_DESK_TASKS,
      stateVariables: [
        stateVariable(
          'deskOutcome',
          'Desk outcome',
          'review when the set holds reviewed candidates, no_candidates when the strategist proposed none, strategist_failed when it returned no result, review_failed when no lens returned a result, unframed when no campaign is active.',
          'alternatives',
        ),
        stateVariable(
          'deskReason',
          'Desk reason',
          'Why the desk ended as deskOutcome says.',
          'alternatives',
        ),
        stateVariable('approvedSetPath', 'Approved set', 'Where the day’s set was written.'),
        stateVariable(
          'deskRecordPath',
          'Desk record',
          'The record of this desk run: its outcome, each lens summary and the desk reviewer summary.',
        ),
        stateVariable('frameReason', 'Frame', 'Whether a campaign is active.'),
      ],
      output: {
        primary: 'deskOutcome',
        guidance:
          'Report deskOutcome and deskReason, and the approved set path where the desk wrote one.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: STRATEGY_DESK_SLUG,
      name: 'Strategy Desk',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'reviewed-before-trading',
            description:
              'Every candidate a cycle may open was proposed by the strategist and reviewed by the lenses and the desk reviewer, and the set names the desk run that wrote it.',
          },
          {
            id: 'veto-reasoned',
            description: 'Every veto names who raised it and states its reason.',
          },
        ],
      },
      mode: 'process' as const,
      // A scheduled desk and a desk a cycle started may run side by side. The
      // last to finish writes the day's set.
      concurrency: {
        maxParallelTasksPerRun: 8,
        maxConcurrentRuns: 2,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: [
        'strategy desk',
        'run the strategy desk',
        'approve the theses',
        'refresh the approved set',
      ],
      activationHint:
        'Writes the day’s approved set with inputs { bindingId, tradingDay }. A schedule may run it before the open or on new information, and a cycle that finds no set runs it itself.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Critical judgements go to the harness: the strategist, the seven lenses and the desk reviewer are host.harness.run tasks. Review catches mistakes: a lens that says nothing approves, a candidate needs a majority of lenses against it to fail, and the one veto is the desk reviewer’s, with a stated reason. The tally is code run where the set is read, so no model folds verdicts. A cycle starts the desk when its day has no set, so no schedule has to win a race.',
  },
};

export { STRATEGY_DESK };
