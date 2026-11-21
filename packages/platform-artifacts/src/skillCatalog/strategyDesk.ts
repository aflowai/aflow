import type { SkillCatalogEntry } from '@aflow/schemas';
import { CYCLE_WORKFLOW_SLUG } from './dailyTradingCycleApproved.js';
import { SLOT_INDEX_INPUT_SCHEMA } from './dailyTradingCycleSlots.js';
import { entryContract } from './localBrowserRule.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  DESK_INDEX_SYMBOLS,
  DESK_READ_LEDGER_PROMPT,
  DESK_REVIEWER_TASK,
  DESK_STRATEGIST_TASK,
} from './strategyDeskProse.js';
import {
  barsTaskId,
  DESK_RECORD_PATH,
  DESK_REVIEWS_MAX,
  DESK_ROUNDS,
  DESK_STAGES,
  FRAME_OTHERWISE,
  FRAME_RULES,
  FRAME_TASK_ID,
  HAND_OFF_TASK_ID,
  DESK_OUTCOME_OTHERWISE,
  DESK_OUTCOME_RULES,
  DESK_RUN_RECORD_PATH,
  REVIEW_SET_WRITTEN,
  SETTLE_DESK_TASK_ID,
  WRITE_DESK_RUN_TASK_ID,
  MEMO_FOLDER_PATH,
  MEMO_MEMORY_PATH,
  READ_CAMPAIGN_TASK_ID,
  READ_LEDGER_TASK_ID,
  REVIEW_RESULT_SCHEMA,
  REVIEW_RUN_TASK_ID,
  reviewTaskId,
  roundOtherwise,
  roundRules,
  roundTaskId,
  SET_PATH,
  SETTLE_OTHERWISE,
  SETTLE_RULES,
  SETTLE_TASK_ID,
  SLOT_KEY,
  STRATEGIST_RESULT_SCHEMA,
  strategistTaskId,
  STRATEGY_DESK_SLUG,
  WRITE_FOLDER_MEMO_TASK_ID,
  WRITE_MEMO_TASK_ID,
  WRITE_RECORD_TASK_ID,
  WRITE_SET_TASK_ID,
} from './strategyDeskRules.js';

/**
 * The Strategy Desk (Plan 343 Part B): a strategist and a reviewer, each a
 * harness run on the space's folder, produce the approved set a Daily
 * Trading Cycle slot opens theses from, and the desk then starts that slot.
 *
 * A desk is two runs of this skill. The desk run starts one review run and
 * waits for it to end. The review run reads, proposes, reviews in rounds and
 * writes the set with an operation task of its own, so the set's writer is a
 * worker that run minted and every entry names it. Only then does the desk
 * run start the cycle. One run cannot do both: a workflow task waits for the
 * run it starts to end, and the cycle refuses a set from a run that has not.
 *
 * Only the strategist and the reviewer run on the harness. The frame, the
 * revise-round counter, the settlement, the writes and the hand-off are
 * operation tasks, decided by rule. The ledger read is a Runner that copies
 * what memory and the feed hold, because no operation reads a directory of
 * documents whole.
 */

const RUN_INPUTS = [
  {
    id: 'bindingId',
    required: true,
    description:
      "The connected folder holding the desk's journals, strategy records, boundary rules and operator notes. Both harness runs work in a checkout of it. The research memo is also written into it where the folder allows writes.",
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  },
  {
    id: 'tradingDay',
    required: true,
    description:
      'The trading day the desk prepares, YYYY-MM-DD in exchange time. A schedule passes { "$now": "date" }, which names the exchange date at any firing before 19:00 New York time.',
    schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
  {
    id: 'slot',
    required: true,
    description:
      'The cycle slot the desk prepares and then starts: pre_market, open or intraday. after_close opens no thesis, so its cycle needs no desk.',
    schema: { enum: ['pre_market', 'open', 'intraday'] },
  },
  {
    id: 'slotIndex',
    required: false,
    description:
      'Which intraday firing this is, counted from the 09:30 open as the cycle counts it. Required on intraday, refused on any other slot.',
    schema: SLOT_INDEX_INPUT_SCHEMA,
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
      "Which coding agent runs the reviewer. Name one other than the strategist's where the machine has a second, so the review is a second opinion. Absent, the space's preferred coding agent.",
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'reviewModel',
    required: false,
    description:
      'The model the reviewer runs. Name one other than the strategist’s where the reviewer runs the same coding agent. Absent, the model configured on the machine.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    id: 'stage',
    required: false,
    description:
      'Set by the desk on the review run it starts. Leave it out: a run without it is the desk, which starts the review run and hands its set to the cycle.',
    schema: { enum: [...DESK_STAGES] },
  },
];

const SLOT_BINDINGS = {
  tradingDay: runInput('tradingDay'),
  slot: runInput('slot'),
  slotIndex: runInput('slotIndex'),
};

/** The campaign caps both harness schemas take as values. */
const ENTRY_CAPS = [
  'universe',
  'maxThesesPerDay',
  'maxPositionSizePct',
  'minHorizonTradingDays',
  'maxHorizonTradingDays',
];

/** The strategist also proposes the working gross cap, under the campaign's. */
const STRATEGIST_CAPS = [...ENTRY_CAPS, 'maxGrossExposurePct'];

function campaignCapBindings(fields: readonly string[]) {
  return Object.fromEntries(
    fields.map((field) => [field, out(READ_CAMPAIGN_TASK_ID, `config.${field}`)]),
  );
}

const stageIs = (stage: (typeof DESK_STAGES)[number]) => ({
  expression: `tasks.${FRAME_TASK_ID}.output.decision == '${stage}'`,
  onMissingRef: SKIP,
});

const REVIEW_STAGE = stageIs('review');
const DESK_STAGE = stageIs('desk');

const HARNESS_TIMEOUT_MS = 40 * 60_000;

// ── Shared by both stages ─────────────────────────────────────────────────

const READ_CAMPAIGN_TASK = {
  taskId: READ_CAMPAIGN_TASK_ID,
  name: 'Read the campaign contract',
  goal: 'Read the active Daily Trading Cycle campaign: its id and its contract, whose caps are frozen for the window. The desk proposes within them and never changes them.',
  type: 'operation' as const,
  operation: 'workflow.campaign.list',
  retryability: 'safe' as const,
  // The entry task's contract is the skill's input surface.
  inputContract: entryContract(RUN_INPUTS),
  context: ctx('workflow.campaign.list'),
  inputTemplate: { slug: CYCLE_WORKFLOW_SLUG, status: 'active' },
  outputProjection: {
    campaignId: { path: 'campaigns[0].campaign.campaignId', onMissing: 'null' as const },
    config: { path: 'campaigns[0].campaign.config', onMissing: 'null' as const },
  },
};

const FRAME_TASK = {
  taskId: FRAME_TASK_ID,
  name: 'Frame the desk',
  goal: 'Decide by rule which stage this run is and whether it can run: a campaign is active, and slotIndex is given exactly on an intraday slot. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_CAMPAIGN_TASK_ID],
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId'),
    slot: runInput('slot'),
    slotIndex: runInput('slotIndex'),
    stage: runInput('stage'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      campaignId: bind('campaignId'),
      slot: bind('slot'),
      slotIndex: bind('slotIndex'),
      stage: bind('stage'),
    },
    rules: FRAME_RULES,
    otherwise: FRAME_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'reason', toState: 'frameReason' }],
};

// ── The desk run ──────────────────────────────────────────────────────────

const REVIEW_RUN_TASK = {
  taskId: REVIEW_RUN_TASK_ID,
  name: 'Run the review',
  goal: 'Start the review run of this desk as a run of its own, and wait for it to end: it forms candidates, reviews them in rounds and writes the approved set, or records why it wrote none.',
  type: 'operation' as const,
  operation: 'workflow.run.start',
  dependsOn: [FRAME_TASK_ID],
  when: DESK_STAGE,
  // A review run that could not start, such as one refused beside another
  // desk in flight, reports no output. The desk settles it as review_refused
  // and records it, so the firing never ends without a reason.
  optional: true,
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: runInput('bindingId'),
    ...SLOT_BINDINGS,
    harness: runInput('harness'),
    model: runInput('model'),
    reviewHarness: runInput('reviewHarness'),
    reviewModel: runInput('reviewModel'),
  },
  context: ctx('workflow.run.start'),
  inputTemplate: {
    slug: STRATEGY_DESK_SLUG,
    catalogId: STRATEGY_DESK_SLUG,
    inputs: {
      bindingId: bind('bindingId'),
      tradingDay: bind('tradingDay'),
      slot: bind('slot'),
      slotIndex: bind('slotIndex'),
      harness: bind('harness'),
      model: bind('model'),
      reviewHarness: bind('reviewHarness'),
      reviewModel: bind('reviewModel'),
      stage: 'review',
    },
    wait: 'until_complete',
  },
  outputProjection: {
    outcome: { path: 'outcome', onMissing: 'error' as const },
    reviewRunId: { path: 'runId', onMissing: 'error' as const },
    reviewDecision: { path: 'result.output.deskOutcome', onMissing: 'null' as const },
    stoppedAt: { path: 'result.output.stoppedAt', onMissing: 'null' as const },
    approvedSetPath: { path: 'result.output.approvedSetPath', onMissing: 'null' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'reviewRunId', toState: 'reviewRunId' },
    { kind: 'output_path' as const, path: 'stoppedAt', toState: 'stoppedAt' },
    { kind: 'output_path' as const, path: 'approvedSetPath', toState: 'approvedSetPath' },
  ],
};

/**
 * The gate the cycle opens through: the review run completed, it decided to
 * hand off, and its write of the set landed. A run that completed has every
 * task behind it, so the set exists and its writer's run is complete.
 */
export const HAND_OFF_GATE = [
  `tasks.${REVIEW_RUN_TASK_ID}.output.outcome == 'completed'`,
  `tasks.${REVIEW_RUN_TASK_ID}.output.reviewDecision == '${REVIEW_SET_WRITTEN}'`,
  `tasks.${REVIEW_RUN_TASK_ID}.output.approvedSetPath != null`,
];

const HAND_OFF_TASK = {
  taskId: HAND_OFF_TASK_ID,
  name: 'Start the cycle slot',
  goal: 'Where the review run completed with the approved set written, start the Daily Trading Cycle for this slot under the active campaign, and wait for it to end. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.start',
  dependsOn: [REVIEW_RUN_TASK_ID, READ_CAMPAIGN_TASK_ID],
  when: { allOf: HAND_OFF_GATE, onMissingRef: SKIP },
  // A cycle that could not start, such as one refused while another cycle
  // runs, reports no run id. The desk settles it as hand_off_failed.
  optional: true,
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    campaignId: out(READ_CAMPAIGN_TASK_ID, 'campaignId'),
    slot: runInput('slot'),
    slotIndex: runInput('slotIndex'),
  },
  context: ctx('workflow.run.start'),
  inputTemplate: {
    slug: CYCLE_WORKFLOW_SLUG,
    catalogId: CYCLE_WORKFLOW_SLUG,
    campaignId: bind('campaignId'),
    inputs: { slot: bind('slot'), slotIndex: bind('slotIndex') },
    wait: 'until_complete',
  },
  outputProjection: {
    cycleRunId: { path: 'runId', onMissing: 'error' as const },
    cycleOutcome: { path: 'outcome', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'cycleRunId', toState: 'cycleRunId' }],
};

/** Every run that is not a review run settles as a desk, an unframed one included. */
const NOT_REVIEW_STAGE = {
  expression: `tasks.${FRAME_TASK_ID}.output.decision != 'review'`,
  onMissingRef: SKIP,
};

const DESK_OUTCOME_BINDINGS = {
  framed: out(FRAME_TASK_ID, 'decision'),
  reviewOutcome: out(REVIEW_RUN_TASK_ID, 'outcome'),
  reviewDecision: out(REVIEW_RUN_TASK_ID, 'reviewDecision'),
  approvedSetPath: out(REVIEW_RUN_TASK_ID, 'approvedSetPath'),
  cycleRunId: out(HAND_OFF_TASK_ID, 'cycleRunId'),
};

const SETTLE_DESK_TASK = {
  taskId: SETTLE_DESK_TASK_ID,
  name: 'Settle the desk run',
  goal: 'Decide by rule how this desk run ends: the cycle started, or why it did not — the review run could not start or did not complete, it approved nothing, the cycle start failed, or the desk could not run. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [FRAME_TASK_ID, REVIEW_RUN_TASK_ID, HAND_OFF_TASK_ID],
  when: NOT_REVIEW_STAGE,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: DESK_OUTCOME_BINDINGS,
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A task that skipped or failed binds nothing, and its value reads null.
    state: Object.fromEntries(Object.keys(DESK_OUTCOME_BINDINGS).map((name) => [name, bind(name)])),
    rules: DESK_OUTCOME_RULES,
    otherwise: DESK_OUTCOME_OTHERWISE,
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

const WRITE_DESK_RUN_TASK = {
  taskId: WRITE_DESK_RUN_TASK_ID,
  name: 'Record the desk run',
  goal: 'Write the record of this desk run to memory: how it ended and why, with the review run, the set and the cycle run where there are any. A desk that starts no cycle says why here.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [SETTLE_DESK_TASK_ID],
  when: { expression: `tasks.${SETTLE_DESK_TASK_ID}.output.decision != null`, onMissingRef: SKIP },
  retryability: 'safe' as const,
  inputBindings: {
    ...SLOT_BINDINGS,
    deskRunId: { kind: 'run_id' as const },
    outcome: out(SETTLE_DESK_TASK_ID, 'decision'),
    reason: out(SETTLE_DESK_TASK_ID, 'reason'),
    frameReason: out(FRAME_TASK_ID, 'reason'),
    reviewRunId: out(REVIEW_RUN_TASK_ID, 'reviewRunId'),
    reviewOutcome: out(REVIEW_RUN_TASK_ID, 'outcome'),
    stoppedAt: out(REVIEW_RUN_TASK_ID, 'stoppedAt'),
    approvedSetPath: out(REVIEW_RUN_TASK_ID, 'approvedSetPath'),
    cycleRunId: out(HAND_OFF_TASK_ID, 'cycleRunId'),
    cycleOutcome: out(HAND_OFF_TASK_ID, 'cycleOutcome'),
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: DESK_RUN_RECORD_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        tradingDay: bind('tradingDay'),
        slot: bind('slot'),
        slotIndex: bind('slotIndex'),
        deskRunId: bind('deskRunId'),
        outcome: bind('outcome'),
        reason: bind('reason'),
        frameReason: bind('frameReason'),
        reviewRunId: bind('reviewRunId'),
        reviewOutcome: bind('reviewOutcome'),
        stoppedAt: bind('stoppedAt'),
        approvedSetPath: bind('approvedSetPath'),
        cycleRunId: bind('cycleRunId'),
        cycleOutcome: bind('cycleOutcome'),
      },
    },
    writeMode: 'upsert',
    indexing: 'disabled',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'deskRunRecordPath' }],
};

// ── The review run: what it reads ─────────────────────────────────────────

/** 320 calendar days of daily bars hold the 200 sessions a 200-day average needs. */
const INDEX_LOOKBACK_MS = 320 * 24 * 60 * 60_000;

function barsTask(symbol: string) {
  return {
    taskId: barsTaskId(symbol),
    name: `Read ${symbol} daily bars`,
    goal: `Read about 220 sessions of ${symbol} daily bars from the market-data feed, for the regime read. A read that fails leaves the strategist without them, and it says so.`,
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: [FRAME_TASK_ID],
    when: REVIEW_STAGE,
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
  when: REVIEW_STAGE,
  // A failed read stops the desk through the settlement, which names it.
  optional: true,
  inputBindings: { ...SLOT_BINDINGS, campaign: out(READ_CAMPAIGN_TASK_ID, 'config') },
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
        'ledgerNote',
      ],
      additionalProperties: false,
      properties: {
        openTheses: {
          type: 'array',
          maxItems: 60,
          items: LEDGER_ITEM(['thesisId', 'instrument', 'direction']),
        },
        resolvedTheses: {
          type: 'array',
          maxItems: 40,
          items: LEDGER_ITEM(['thesisId', 'instrument', 'direction', 'outcome']),
        },
        recentCycles: { type: 'array', maxItems: 12, items: LEDGER_ITEM(['tradingDay', 'slot']) },
        priorDesk: { type: 'array', maxItems: 12, items: LEDGER_ITEM(['tradingDay', 'outcome']) },
        operatorNotes: { type: 'array', maxItems: 20, items: LEDGER_ITEM(['text']) },
        universeSnapshots: { type: 'array', maxItems: 30, items: FEED_ITEM(['symbol']) },
        news: { type: 'array', maxItems: 30, items: FEED_ITEM(['headline']) },
        ledgerNote: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'What was read, and every read that failed or found nothing.',
        },
      },
    },
  },
};

// ── The review run: the rounds ────────────────────────────────────────────

const LEDGER_FIELDS = [
  'openTheses',
  'resolvedTheses',
  'recentCycles',
  'priorDesk',
  'operatorNotes',
  'universeSnapshots',
  'news',
  'ledgerNote',
] as const;

const ledgerBindAs = (field: string) => `ledger_${field}`;

/** What both harness runs of a round read beside the proposal. */
const CONTEXT_BINDINGS = {
  bindingId: runInput('bindingId'),
  ...SLOT_BINDINGS,
  campaign: out(READ_CAMPAIGN_TASK_ID, 'config'),
  ...Object.fromEntries(
    LEDGER_FIELDS.map((field) => [ledgerBindAs(field), out(READ_LEDGER_TASK_ID, field)]),
  ),
};

const CONTEXT_INPUTS = {
  tradingDay: bind('tradingDay'),
  slot: bind('slot'),
  slotKey: SLOT_KEY,
  campaign: bind('campaign'),
  ledger: Object.fromEntries(LEDGER_FIELDS.map((field) => [field, bind(ledgerBindAs(field))])),
};

function strategistTask(round: number) {
  const previous = round - 1;
  const bars = Object.fromEntries(
    DESK_INDEX_SYMBOLS.map((symbol) => [`bars${symbol}`, out(barsTaskId(symbol), 'bars')]),
  );
  return {
    taskId: strategistTaskId(round),
    name: round === 1 ? 'Propose candidates' : `Revise candidates, round ${String(previous)}`,
    goal:
      round === 1
        ? 'Run the strategist on the harness over the folder: read the journals, strategy records and the ledger, read the regime, set the bias and the working gross cap under the campaign caps, and propose candidate theses with a research memo.'
        : `Where review ${String(previous)} asked for a revision, run the strategist again with the reasons: revise each candidate marked revise, keep each approved one, drop each rejected one.`,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [
      READ_CAMPAIGN_TASK_ID,
      READ_LEDGER_TASK_ID,
      ...DESK_INDEX_SYMBOLS.map(barsTaskId),
      ...(round === 1
        ? []
        : [strategistTaskId(previous), reviewTaskId(previous), roundTaskId(previous)]),
    ],
    when:
      round === 1
        ? {
            allOf: [
              `tasks.${FRAME_TASK_ID}.output.decision == 'review'`,
              `tasks.${READ_LEDGER_TASK_ID}.output.ledgerNote != null`,
            ],
            onMissingRef: SKIP,
          }
        : {
            expression: `tasks.${roundTaskId(previous)}.output.decision == 'revise'`,
            onMissingRef: SKIP,
          },
    // A strategist with no result ends the desk through the settlement.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...CONTEXT_BINDINGS,
      ...campaignCapBindings(STRATEGIST_CAPS),
      harness: runInput('harness'),
      model: runInput('model'),
      ...bars,
      ...(round === 1
        ? {}
        : {
            priorCandidates: out(strategistTaskId(previous), 'candidates'),
            priorReviews: out(reviewTaskId(previous), 'reviews'),
            priorSummary: out(reviewTaskId(previous), 'summary'),
          }),
    },
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('harness'),
      model: bind('model'),
      task: DESK_STRATEGIST_TASK,
      inputs: {
        ...CONTEXT_INPUTS,
        indexBars: Object.fromEntries(
          DESK_INDEX_SYMBOLS.map((symbol) => [symbol, bind(`bars${symbol}`)]),
        ),
        ...(round === 1
          ? {}
          : {
              revision: {
                round: previous,
                candidates: bind('priorCandidates'),
                review: bind('priorReviews'),
                summary: bind('priorSummary'),
              },
            }),
      },
      outputSchema: STRATEGIST_RESULT_SCHEMA,
      resultRetries: 2,
      timeoutMs: HARNESS_TIMEOUT_MS,
    },
    outputProjection: {
      bias: { path: 'result.bias', onMissing: 'error' as const },
      workingGrossCapPct: { path: 'result.workingGrossCapPct', onMissing: 'error' as const },
      regime: { path: 'result.regime', onMissing: 'error' as const },
      candidates: { path: 'result.candidates', onMissing: 'error' as const },
      memo: { path: 'result.memo', onMissing: 'error' as const },
      harness: { path: 'harness.id', onMissing: 'null' as const },
    },
  };
}

function reviewTask(round: number) {
  const strategist = strategistTaskId(round);
  return {
    taskId: reviewTaskId(round),
    name: `Review the candidates, round ${String(round)}`,
    goal: `Run the reviewer on the harness over the folder: review every candidate of strategist round ${String(round)} through the fundamentals, macro, technical, prior-learnings, prior-decisions and risk lenses, give each a verdict with its reason, and write the approved entries as the set, each naming this review run.`,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [READ_CAMPAIGN_TASK_ID, READ_LEDGER_TASK_ID, strategist],
    when: { expression: `tasks.${strategist}.output.bias != null`, onMissingRef: SKIP },
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      ...CONTEXT_BINDINGS,
      ...campaignCapBindings(ENTRY_CAPS),
      reviewHarness: runInput('reviewHarness'),
      reviewModel: runInput('reviewModel'),
      reviewRunId: { kind: 'run_id' as const },
      bias: out(strategist, 'bias'),
      workingGrossCapPct: out(strategist, 'workingGrossCapPct'),
      regime: out(strategist, 'regime'),
      candidates: out(strategist, 'candidates'),
    },
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('reviewHarness'),
      model: bind('reviewModel'),
      task: DESK_REVIEWER_TASK,
      inputs: {
        ...CONTEXT_INPUTS,
        round,
        revisesLeft: DESK_REVIEWS_MAX - round,
        reviewRunId: bind('reviewRunId'),
        proposal: {
          bias: bind('bias'),
          workingGrossCapPct: bind('workingGrossCapPct'),
          regime: bind('regime'),
          candidates: bind('candidates'),
        },
      },
      outputSchema: REVIEW_RESULT_SCHEMA,
      resultRetries: 2,
      timeoutMs: HARNESS_TIMEOUT_MS,
    },
    outputProjection: {
      anyApproved: { path: 'result.anyApproved', onMissing: 'error' as const },
      anyRevise: { path: 'result.anyRevise', onMissing: 'error' as const },
      reviews: { path: 'result.reviews', onMissing: 'error' as const },
      approvedSet: { path: 'result.approvedSet', onMissing: 'error' as const },
      summary: { path: 'result.summary', onMissing: 'error' as const },
      harness: { path: 'harness.id', onMissing: 'null' as const },
    },
  };
}

function roundTask(round: number) {
  const strategist = strategistTaskId(round);
  const review = reviewTaskId(round);
  return {
    taskId: roundTaskId(round),
    name: `Count review round ${String(round)}`,
    goal: `Decide by rule what review ${String(round)} leads to: a revise round while revise rounds remain, the set where a candidate is approved, or no cycle. No model is asked.${round === DESK_REVIEWS_MAX ? ' Both revise rounds are spent here, so a revise verdict trades nothing.' : ''}`,
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [strategist, review],
    when: { expression: `tasks.${strategist}.output.bias != null`, onMissingRef: SKIP },
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      anyApproved: out(review, 'anyApproved'),
      anyRevise: out(review, 'anyRevise'),
      reviews: out(review, 'reviews'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        round,
        anyApproved: bind('anyApproved'),
        anyRevise: bind('anyRevise'),
        reviews: bind('reviews'),
      },
      rules: roundRules(round),
      otherwise: roundOtherwise(round),
    },
    outputProjection: {
      decision: { path: 'decision', onMissing: 'error' as const },
      reason: { path: 'reason', onMissing: 'error' as const },
      round: { fromInput: 'state' },
    },
    promoteOutputs: [{ kind: 'output_path' as const, path: 'round', toState: 'rounds' }],
  };
}

const ROUND_TASKS = DESK_ROUNDS.flatMap((round) => [
  strategistTask(round),
  reviewTask(round),
  roundTask(round),
]);

// ── The review run: the settlement and the writes ─────────────────────────

const SETTLE_BINDINGS = {
  ledger: out(READ_LEDGER_TASK_ID, 'ledgerNote'),
  ...Object.fromEntries(
    DESK_ROUNDS.flatMap((round) => [
      [`strategist${String(round)}`, out(strategistTaskId(round), 'bias')],
      [`decision${String(round)}`, out(roundTaskId(round), 'decision')],
    ]),
  ),
};

const SETTLE_TASK = {
  taskId: SETTLE_TASK_ID,
  name: 'Settle the desk',
  goal: 'Decide by rule whether the cycle starts: a review approved a candidate, or why not — every candidate rejected, both revise rounds spent, or a ledger read, strategist or review with no result. No model is asked.',
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [READ_LEDGER_TASK_ID, ...ROUND_TASKS.map((task) => task.taskId)],
  when: REVIEW_STAGE,
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: SETTLE_BINDINGS,
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    // A task that skipped or failed binds nothing, and its value reads null.
    state: Object.fromEntries(Object.keys(SETTLE_BINDINGS).map((name) => [name, bind(name)])),
    rules: SETTLE_RULES,
    otherwise: SETTLE_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    stoppedAt: { path: 'value', onMissing: 'error' as const },
  },
  promoteOutputs: [
    { kind: 'output_path' as const, path: 'decision', toState: 'deskOutcome' },
    { kind: 'output_path' as const, path: 'stoppedAt', toState: 'stoppedAt' },
  ],
};

/** The set the last review wrote: a later review runs only where the one before it asked for a revision. */
const LATEST_SET = {
  $firstOf: [...DESK_ROUNDS].reverse().map((round) => bind(`set${String(round)}`)),
};

const WRITE_SET_TASK = {
  taskId: WRITE_SET_TASK_ID,
  name: 'Write the approved set',
  goal: 'Where the desk settled on a hand-off, write the approved set the last review wrote to its path in memory. This task is the worker of this review run, so the cycle accepts the set: its writer is this run, and every entry names it.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [SETTLE_TASK_ID, ...DESK_ROUNDS.map(reviewTaskId)],
  when: {
    expression: `tasks.${SETTLE_TASK_ID}.output.decision == '${REVIEW_SET_WRITTEN}'`,
    onMissingRef: SKIP,
  },
  retryability: 'safe' as const,
  inputBindings: {
    tradingDay: runInput('tradingDay'),
    ...Object.fromEntries(
      DESK_ROUNDS.map((round) => [`set${String(round)}`, out(reviewTaskId(round), 'approvedSet')]),
    ),
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: SET_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: { inlineJson: LATEST_SET },
    writeMode: 'upsert',
    indexing: 'disabled',
  },
  outputProjection: { path: { path: 'path', onMissing: 'error' as const } },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'path', toState: 'approvedSetPath' }],
};

const LATEST_MEMO = {
  $firstOf: [...DESK_ROUNDS].reverse().map((round) => bind(`memo${String(round)}`)),
};
const MEMO_BINDINGS = Object.fromEntries(
  DESK_ROUNDS.map((round) => [`memo${String(round)}`, out(strategistTaskId(round), 'memo')]),
);
const HAS_MEMO = {
  expression: `tasks.${strategistTaskId(1)}.output.memo != null`,
  onMissingRef: SKIP,
};

const WRITE_MEMO_TASK = {
  taskId: WRITE_MEMO_TASK_ID,
  name: 'Mirror the research memo to memory',
  goal: 'Write the research memo of the last strategist round to memory beside the set, under the research path of the trading day.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [SETTLE_TASK_ID, ...DESK_ROUNDS.map(strategistTaskId)],
  when: HAS_MEMO,
  optional: true,
  retryability: 'safe' as const,
  inputBindings: { ...SLOT_BINDINGS, ...MEMO_BINDINGS },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: MEMO_MEMORY_PATH,
    docType: 'markdown',
    mimeType: 'text/markdown',
    content: { inlineText: LATEST_MEMO },
    writeMode: 'upsert',
  },
};

const WRITE_FOLDER_MEMO_TASK = {
  taskId: WRITE_FOLDER_MEMO_TASK_ID,
  name: 'Write the research memo to the folder',
  goal: 'Write the research memo of the last strategist round into the folder, under research/{tradingDay}/. A folder that allows no writes, or a memo already there, keeps the folder as it is.',
  type: 'operation' as const,
  operation: 'host.file.put',
  dependsOn: [SETTLE_TASK_ID, ...DESK_ROUNDS.map(strategistTaskId)],
  when: HAS_MEMO,
  optional: true,
  // Create-only: a second attempt would meet the file the first wrote.
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: { bindingId: runInput('bindingId'), ...SLOT_BINDINGS, ...MEMO_BINDINGS },
  context: ctx('host.file.put'),
  inputTemplate: { bindingId: bind('bindingId'), path: MEMO_FOLDER_PATH, content: LATEST_MEMO },
};

const RECORD_ROUND_BINDINGS = Object.fromEntries(
  DESK_ROUNDS.flatMap((round) => {
    const n = String(round);
    return [
      [`decision${n}`, out(roundTaskId(round), 'decision')],
      [`reason${n}`, out(roundTaskId(round), 'reason')],
      [`reviews${n}`, out(reviewTaskId(round), 'reviews')],
      [`summary${n}`, out(reviewTaskId(round), 'summary')],
      [`strategistHarness${n}`, out(strategistTaskId(round), 'harness')],
      [`reviewerHarness${n}`, out(reviewTaskId(round), 'harness')],
    ];
  }),
);

const WRITE_RECORD_TASK = {
  taskId: WRITE_RECORD_TASK_ID,
  name: 'Record the desk',
  goal: 'Write the desk record for this slot to memory: whether the cycle starts and why, and what every round reviewed and decided. A desk that starts no cycle says why here.',
  type: 'operation' as const,
  operation: 'memory.store.put',
  dependsOn: [SETTLE_TASK_ID, WRITE_SET_TASK_ID, ...ROUND_TASKS.map((task) => task.taskId)],
  when: REVIEW_STAGE,
  retryability: 'safe' as const,
  inputBindings: {
    ...SLOT_BINDINGS,
    reviewRunId: { kind: 'run_id' as const },
    outcome: out(SETTLE_TASK_ID, 'decision'),
    stoppedAt: out(SETTLE_TASK_ID, 'stoppedAt'),
    approvedSetPath: out(WRITE_SET_TASK_ID, 'path'),
    ...RECORD_ROUND_BINDINGS,
  },
  context: ctx('memory.store.put'),
  inputTemplate: {
    path: DESK_RECORD_PATH,
    docType: 'json',
    mimeType: 'application/json',
    content: {
      inlineJson: {
        tradingDay: bind('tradingDay'),
        slot: bind('slot'),
        slotKey: SLOT_KEY,
        reviewRunId: bind('reviewRunId'),
        outcome: bind('outcome'),
        stoppedAt: bind('stoppedAt'),
        approvedSetPath: bind('approvedSetPath'),
        rounds: Object.fromEntries(
          DESK_ROUNDS.map((round) => {
            const n = String(round);
            return [
              `round${n}`,
              {
                decision: bind(`decision${n}`),
                reason: bind(`reason${n}`),
                reviews: bind(`reviews${n}`),
                summary: bind(`summary${n}`),
                strategistHarness: bind(`strategistHarness${n}`),
                reviewerHarness: bind(`reviewerHarness${n}`),
              },
            ];
          }),
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
  REVIEW_RUN_TASK,
  HAND_OFF_TASK,
  SETTLE_DESK_TASK,
  WRITE_DESK_RUN_TASK,
  ...DESK_INDEX_SYMBOLS.map(barsTask),
  READ_LEDGER_TASK,
  ...ROUND_TASKS,
  SETTLE_TASK,
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
  'What it needs: the connected folder holding the journals and strategy records, the trading day, and the slot. An intraday desk also needs slotIndex, so give each hourly schedule its own index. A schedule passes tradingDay as { "$now": "date" }.',
  'A desk is two runs. The desk run starts a review run of this skill, waits for it, then starts the Daily Trading Cycle for the slot. The review run writes the approved set, and every entry names it. Read the outcome from deskOutcome and deskReason on the desk run. Each desk run also writes its record at /research/{tradingDay}/desk-runs/{slotKey}-{runId}.json.',
  'A desk holds two active runs, its own and its review run, and the skill allows two. A desk that fires while another is in flight cannot start its review run, so it ends review_refused, with its record. A firing past that is refused at its start.',
  `No cycle starts when the review rejects every candidate, or when ${String(DESK_REVIEWS_MAX - 1)} revise rounds are spent without an approved one. stoppedAt says which, and the desk record at /research/{tradingDay}/desk-{slotKey}.json keeps every round. The next cycle that runs resolves what this slot did not.`,
  'Never write the approved set yourself, and never form theses for the desk. A set a conversation writes is refused, and opens nothing. To change what trades, change the campaign at its boundary or the notes the desk reads.',
  'reviewHarness and reviewModel name a second opinion. Name a coding agent or a model other than the strategist’s where the machine has one.',
];

const STRATEGY_DESK: SkillCatalogEntry = {
  catalogId: STRATEGY_DESK_SLUG,
  version: 1,
  name: 'Strategy Desk',
  tagline:
    'A strategist and a reviewer on the harness produce the approved theses, then start the cycle slot.',
  description: `Fits the step before each Daily Trading Cycle slot that may open a thesis. A **strategist** on the machine’s coding agent reads the journals and strategy records in the connected folder and the campaign ledger, reads the regime, sets a bias and a working gross cap under the frozen campaign caps, and proposes candidate theses with a research memo. A **reviewer**, on a second coding agent or model where one is named, reviews each candidate through the fundamentals, macro, technical, prior-learnings, prior-decisions and risk lenses, and approves, revises or rejects it. A revise goes back to the strategist for at most two rounds.

The approved candidates become the approved set at \`/research/{tradingDay}/approved-theses.json\`, the only theses a cycle may open. Once the set is written, the desk starts the cycle for its slot. When nothing is approved, no cycle starts, and the desk record says why. The frame, the round counter, the writes and the hand-off are decided by rule: only the strategist and the reviewer run on the harness.`,
  tags: ['alpaca', 'trading', 'paper', 'theses', 'research', 'review'],
  bundle: {
    workflow: {
      slug: STRATEGY_DESK_SLUG,
      name: 'Strategy Desk',
      description:
        'Before a Daily Trading Cycle slot: a strategist harness run proposes candidate theses under the campaign caps, a reviewer harness run approves, revises or rejects each through six lenses, at most two revise rounds, and the approved set is written for the slot. Then the desk starts the cycle. No approved candidate means no cycle, with the reason recorded.',
      usage: {
        whenToUse: [
          'Preparing a Daily Trading Cycle slot that may open theses — pre_market, open or an intraday firing: the desk writes the approved set the cycle opens theses from, then starts the cycle',
          'The scheduled pass before each such slot, with { tradingDay: { "$now": "date" }, slot } and slotIndex on intraday',
        ],
        whenNotToUse: [
          'The after_close slot — it opens no thesis, so its cycle runs on its own schedule',
          'Resolving or recording a cycle — that is the Daily Trading Cycle',
          'Changing the campaign caps — they are frozen for the window, and change only at a campaign boundary',
        ],
        next: [
          {
            skill: CYCLE_WORKFLOW_SLUG,
            when: 'The desk starts it itself once the set is written. Start a cycle by hand only for after_close, or when deskOutcome is hand_off_failed: the set is written and the cycle start failed.',
          },
        ],
        pitfalls: DESK_PITFALLS,
      },
      goal: 'Return, for one (tradingDay, slot), either an approved set every entry of which names its review run, with the cycle for the slot started, or the reason no cycle starts.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'desk-settled',
          name: 'Desk settled',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The desk reviewed the candidates and either wrote an approved set naming its review run and started the cycle slot, or recorded why no cycle starts.',
          },
        },
      ],
      runInputs: RUN_INPUTS,
      tasks: STRATEGY_DESK_TASKS,
      stateVariables: [
        stateVariable(
          'deskOutcome',
          'Desk outcome',
          'On a desk run: hand_off when the approved set is written and the cycle slot has started. Otherwise hand_off_failed, no_cycle, review_refused, review_failed or unframed, and deskReason says why. On a review run: set_written or no_cycle, and stoppedAt says why.',
          'alternatives',
        ),
        stateVariable(
          'deskReason',
          'Desk reason',
          'Why the desk run ended as deskOutcome says, in one sentence with what to do next.',
        ),
        stateVariable(
          'deskRunRecordPath',
          'Desk run record',
          'The record this desk run wrote: its outcome, the reason, and the review run, set and cycle run where there are any.',
        ),
        stateVariable(
          'stoppedAt',
          'Stopped at',
          'The round that settled the desk, and why: approved, rejected_all, rounds_spent, review_failed, strategist_failed or ledger_unread, with the reason.',
          'alternatives',
        ),
        stateVariable(
          'approvedSetPath',
          'Approved set',
          'Where the approved set was written. Absent when no candidate was approved.',
          'alternatives',
        ),
        stateVariable(
          'reviewRunId',
          'Review run',
          'The review run this desk started. Every entry of the set names it.',
        ),
        stateVariable(
          'cycleRunId',
          'Cycle run',
          'The Daily Trading Cycle run the desk started for its slot.',
        ),
        stateVariable(
          'deskRecordPath',
          'Desk record',
          'The desk record: the outcome, the reason and every round.',
        ),
        stateVariable(
          'frameReason',
          'Frame',
          'Which stage this run is, or why it could not run: no active campaign, or a slotIndex missing on intraday or given on another slot.',
        ),
        stateVariable(
          'rounds',
          'Rounds',
          'Every review round, oldest first: its approved and revise flags and the verdicts.',
          'append',
        ),
      ],
      output: {
        primary: 'deskOutcome',
        guidance:
          'Report deskOutcome and deskReason. On hand_off, report the approved set path and the cycle run. On hand_off_failed, report that the set is written and the cycle did not start. On no_cycle, report stoppedAt.reason, and that the next cycle resolves what this slot did not. Never write the set or form theses yourself.',
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
              'Every thesis a cycle slot may open was proposed by the strategist and approved by the reviewer, and every entry of the set names the review run that wrote it.',
          },
          {
            id: 'reason-recorded',
            description:
              'A slot that starts no cycle has a desk record that says why: every candidate rejected, both revise rounds spent, or a step with no result.',
          },
        ],
      },
      mode: 'process' as const,
      // A desk run and the one review run it starts. A second desk in that
      // window cannot start its review run and settles review_refused with a
      // record. A third is refused at its start, where the firing reports it.
      concurrency: {
        maxParallelTasksPerRun: 4,
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
        'prepare the trading slot',
      ],
      activationHint:
        'Runs before each Daily Trading Cycle slot that may open a thesis, from its schedule with inputs { bindingId, tradingDay, slot } and slotIndex on intraday. It writes the approved set and starts the cycle. Its usage says what it needs.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Critical and strategic decisions go to the harness, input-to-output decisions do not. The strategist and the reviewer are host.harness.run operation tasks whose outputSchemas are templates: the campaign caps, the slot key and the review run id land in them as values, so the harness answers inside the caps and every approved entry carries this run's id. The frame, the revise-round counter, the settlement and the hand-off are workflow.run.decide rules, unrolled to two revise rounds. The ledger read is a Runner, because no operation reads a directory of memory documents whole. A desk is two runs of this skill, because a workflow task waits for the run it starts to end and the cycle accepts a set only from a completed run: the review run writes the set with its own memory.store.put task and ends, and only then does the desk run start the cycle.",
  },
};

export { STRATEGY_DESK };
