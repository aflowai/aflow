/**
 * The strategy desk's contracts and rules: the shape its strategist answers
 * in, and the decisions the run makes without a model. The harness schema is
 * a task template, so the campaign caps and the slot key land in it as values
 * before the harness sees them. The lens reviews are in `strategyDeskLenses.ts`.
 */
import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { APPROVED_ID_PATTERN } from './dailyTradingCycleApproved.js';
import { bind } from './localPrShepherdWiring.js';

export const STRATEGY_DESK_SLUG = 'strategy-desk';

/** The revise rounds one desk allows: a review may send its candidates back at most this often. */
export const DESK_REVISE_ROUNDS_MAX = 2;

/** The reviews one desk makes: the first, and one after each revise round. */
export const DESK_REVIEWS_MAX = DESK_REVISE_ROUNDS_MAX + 1;

export const DESK_ROUNDS = Array.from({ length: DESK_REVIEWS_MAX }, (_, i) => i + 1);

/** The two stages of a desk. The desk run starts one review run and hands the set it wrote to the cycle. */
export const DESK_STAGES = ['desk', 'review'] as const;

export const FRAME_TASK_ID = 'frame';
export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const READ_LEDGER_TASK_ID = 'read-ledger';
export const SETTLE_TASK_ID = 'settle';
export const WRITE_SET_TASK_ID = 'write-set';
export const WRITE_RECORD_TASK_ID = 'write-desk-record';
export const WRITE_MEMO_TASK_ID = 'write-memo';
export const WRITE_FOLDER_MEMO_TASK_ID = 'write-folder-memo';
export const REVIEW_RUN_TASK_ID = 'review-run';
export const HAND_OFF_TASK_ID = 'hand-off';
export const SETTLE_DESK_TASK_ID = 'settle-desk';
export const READ_HAND_OFF_CLOCK_TASK_ID = 'read-hand-off-clock';
export const TIME_HAND_OFF_TASK_ID = 'time-hand-off';
export const WRITE_DESK_RUN_TASK_ID = 'write-desk-run-record';
export const strategistTaskId = (round: number) => `strategist-${String(round)}`;
export const reviewTaskId = (round: number) => `review-${String(round)}`;
export const roundTaskId = (round: number) => `round-${String(round)}`;
export const barsTaskId = (symbol: string) => `bars-${symbol.toLowerCase()}`;

// ── The slot key and the paths built from it ──────────────────────────────

/** `{slotKey}`: the slot, or `intraday-{slotIndex}`. The frame refuses an index on any other slot. */
export const SLOT_KEY = {
  $firstOf: [{ $concat: ['intraday-', { $text: [bind('slotIndex')] }] }, bind('slot')],
};

const researchPath = (...rest: unknown[]) => ({
  $concat: ['/research/', bind('tradingDay'), ...rest],
});

/** Part A's path for the set, built the way `approvedThesesPath` builds it. */
export const SET_PATH = researchPath('/approved-theses.json');
export const DESK_RECORD_PATH = researchPath('/desk-', SLOT_KEY, '.json');
/** One record per desk run, so a desk refused beside another for the same slot keeps its own. */
export const DESK_RUN_RECORD_PATH = researchPath(
  '/desk-runs/',
  SLOT_KEY,
  '-',
  bind('deskRunId'),
  '.json',
);
export const MEMO_MEMORY_PATH = researchPath('/strategy-memo-', SLOT_KEY, '.md');
export const MEMO_FOLDER_PATH = {
  $concat: ['research/', bind('tradingDay'), '/strategy-memo-', SLOT_KEY, '.md'],
};

// ── The frame: what every later task can rely on ──────────────────────────

export const FRAME_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.campaignId == null' },
    decision: 'unframed',
    reason:
      'No Daily Trading Cycle campaign is active in this space. The desk proposes within the caps of a campaign, so it forms no theses without one.',
  },
  {
    when: { allOf: ["state.slot == 'intraday'", 'state.slotIndex == null'] },
    decision: 'unframed',
    reason:
      'An intraday desk run needs its slotIndex, because the approved set is keyed by intraday-{slotIndex}. Give each hourly schedule its own index.',
  },
  {
    when: { allOf: ["state.slot != 'intraday'", 'state.slotIndex != null'] },
    decision: 'unframed',
    reason: 'slotIndex numbers intraday firings only. Leave it out on pre_market and open.',
  },
  {
    when: { expression: "state.stage == 'review'" },
    decision: 'review',
    reason: 'This is the review run of a desk: it forms, reviews and writes the approved set.',
  },
];

export const FRAME_OTHERWISE = {
  decision: 'desk',
  reason:
    'This is a desk run: it starts one review run and hands the set that run wrote to the cycle.',
};

// ── The strategist's result ───────────────────────────────────────────────

const LEVEL = { type: 'number', exclusiveMinimum: 0 };
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

/** Each campaign cap, bound from the campaign contract. An absent cap leaves its keyword out. */
const SIZE_CAP = { type: 'number', exclusiveMinimum: 0, maximum: bind('maxPositionSizePct') };
const HORIZON = {
  type: 'integer',
  minimum: { $firstOf: [bind('minHorizonTradingDays'), 1] },
  maximum: bind('maxHorizonTradingDays'),
};
const INSTRUMENT = { type: 'string', enum: bind('universe') };
/** The campaign arm a candidate tests, one of the ids the ledger read copied from the campaign. */
const HYPOTHESIS_ID = {
  type: 'string',
  enum: bind('hypothesisIds'),
  description: 'The id of the campaign hypothesis arm this tests.',
};

const INDEX_READ = {
  type: 'object',
  required: ['symbol', 'close', 'sma20', 'sma50', 'sma200', 'read'],
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    close: LEVEL,
    sma20: LEVEL,
    sma50: LEVEL,
    sma200: LEVEL,
    read: PROSE(2000),
  },
};

export const CANDIDATE_SCHEMA = {
  type: 'object',
  required: [
    'candidateId',
    'instrument',
    'direction',
    'hypothesisId',
    'hypothesis',
    'entryLevel',
    'invalidationLevel',
    'confirmationLevel',
    'sizePct',
    'horizonTradingDays',
    'evidence',
  ],
  additionalProperties: false,
  properties: {
    candidateId: { type: 'string', pattern: APPROVED_ID_PATTERN },
    instrument: INSTRUMENT,
    direction: { enum: ['long', 'short'] },
    hypothesisId: HYPOTHESIS_ID,
    hypothesis: PROSE(4000),
    entryLevel: LEVEL,
    invalidationLevel: LEVEL,
    confirmationLevel: LEVEL,
    sizePct: SIZE_CAP,
    horizonTradingDays: HORIZON,
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['claim', 'source'],
        additionalProperties: false,
        properties: { claim: PROSE(4000), source: PROSE(1000) },
      },
    },
  },
};

export const STRATEGIST_RESULT_SCHEMA = {
  type: 'object',
  required: [
    'tradingDay',
    'slotKey',
    'regime',
    'bias',
    'biasReason',
    'workingGrossCapPct',
    'candidates',
    'memo',
  ],
  additionalProperties: false,
  properties: {
    tradingDay: { const: bind('tradingDay') },
    slotKey: { const: SLOT_KEY },
    regime: {
      type: 'object',
      required: ['indices', 'realizedVol', 'breadth', 'eventRisk'],
      additionalProperties: false,
      properties: {
        indices: { type: 'array', minItems: 1, maxItems: 10, items: INDEX_READ },
        realizedVol: {
          type: 'object',
          required: ['symbol', 'windowSessions', 'annualizedPct', 'read'],
          additionalProperties: false,
          properties: {
            symbol: { type: 'string' },
            windowSessions: { type: 'integer', minimum: 1 },
            annualizedPct: { type: 'number', minimum: 0 },
            read: PROSE(2000),
          },
        },
        breadth: {
          type: 'object',
          required: ['proxy', 'read'],
          additionalProperties: false,
          properties: { proxy: PROSE(1000), read: PROSE(2000) },
        },
        eventRisk: {
          type: 'object',
          required: ['events', 'read'],
          additionalProperties: false,
          properties: {
            events: {
              type: 'array',
              maxItems: 30,
              items: {
                type: 'object',
                required: ['date', 'event'],
                additionalProperties: false,
                properties: { date: { type: 'string' }, event: PROSE(1000) },
              },
            },
            read: PROSE(2000),
          },
        },
      },
    },
    bias: { enum: ['risk_on', 'neutral', 'risk_off'] },
    biasReason: PROSE(4000),
    workingGrossCapPct: { type: 'number', minimum: 0, maximum: bind('maxGrossExposurePct') },
    candidates: { type: 'array', maxItems: bind('maxThesesPerDay'), items: CANDIDATE_SCHEMA },
    memo: { ...PROSE(60000), description: 'The research memo, in Markdown.' },
  },
};

// ── The revise-round counter ──────────────────────────────────────────────

export const ROUND_DECISIONS = [
  'revise',
  'write_set',
  'rejected',
  'rounds_spent',
  'review_failed',
  'no_candidates',
] as const;

/**
 * What one review decides, by rule. A revise verdict sends the candidates
 * back while revise rounds remain, approved ones with them. Once none
 * remain, the approved candidates are written and a revise trades nothing.
 * A strategist that proposed nothing is read first: no lens had a candidate
 * to vote on, so the round must never read as a rejection.
 */
export function roundRules(round: number): WorkflowRunDecideRule[] {
  const empty: WorkflowRunDecideRule = {
    when: { expression: 'state.candidateCount == 0' },
    decision: 'no_candidates',
    reason: `Strategist round ${String(round)} returned no candidates, so no lens had a candidate to vote on.`,
  };
  const failed: WorkflowRunDecideRule = {
    when: { expression: 'state.anyApproved == null' },
    decision: 'review_failed',
    reason: `Review ${String(round)} has no aggregate: a lens returned no result, or the aggregate did not follow the veto rule. The desk decided nothing on it.`,
  };
  const approved: WorkflowRunDecideRule = {
    when: { expression: 'state.anyApproved == true' },
    decision: 'write_set',
    reason: `Review ${String(round)} approved at least one candidate, and none waits on a revise round.`,
  };
  if (round < DESK_REVIEWS_MAX) {
    return [
      empty,
      failed,
      {
        when: { expression: 'state.anyRevise == true' },
        decision: 'revise',
        reason: `Review ${String(round)} asked for a revision, and ${String(DESK_REVIEWS_MAX - round)} revise round(s) remain. The candidates go back to the strategist with the reason of every lens, and every lens reviews the revision.`,
      },
      approved,
    ];
  }
  return [
    empty,
    failed,
    {
      ...approved,
      reason: `Review ${String(round)} approved at least one candidate. No revise round remains, so a candidate marked revise trades nothing.`,
    },
    {
      when: { expression: 'state.anyRevise == true' },
      decision: 'rounds_spent',
      reason: `Both revise rounds are spent, and review ${String(round)} approved no candidate.`,
    },
  ];
}

export function roundOtherwise(round: number) {
  return {
    decision: 'rejected',
    reason: `Review ${String(round)} rejected every candidate the strategist proposed, a lens voting to reject each one.`,
  };
}

// ── The settlement: whether the set is written, and why ────────────────────

/** What a review run decides when it has written the set: the desk run may hand it off. */
export const REVIEW_SET_WRITTEN = 'set_written';

/** Why a desk ended where it did, the label `stoppedAt.why` carries. */
export const DESK_STOP_REASONS = {
  approved:
    'The review approved at least one candidate, so the desk writes the set and starts the cycle early.',
  rejected_all:
    'The lenses voted to reject every candidate the strategist proposed, so the desk writes no set for this slot.',
  no_candidates:
    'The strategist returned no candidates, so no lens voted and the desk writes no set for this slot.',
  rounds_spent:
    'Both revise rounds are spent without an approved candidate, so the desk writes no set for this slot.',
  review_failed:
    'A review round has no aggregate, because a lens returned no result or the aggregate failed, so the desk writes no set for this slot.',
  strategist_failed:
    'A strategist run returned no result, so the desk writes no set for this slot.',
  ledger_unread:
    'The ledger read failed, so the strategist did not run and the desk writes no set.',
} as const;
export type DeskStopReason = keyof typeof DESK_STOP_REASONS;

function settleRule(
  round: number,
  why: DeskStopReason,
  comparisons: string[],
): WorkflowRunDecideRule {
  const [only] = comparisons;
  const reason = DESK_STOP_REASONS[why];
  return {
    when:
      comparisons.length === 1 && only !== undefined
        ? { expression: only }
        : { allOf: comparisons },
    decision: why === 'approved' ? REVIEW_SET_WRITTEN : 'no_cycle',
    reason,
    value: { round, why, reason },
  };
}

/** One rule for each way a desk can end. They are exclusive, so their order decides nothing. */
export const SETTLE_RULES: readonly WorkflowRunDecideRule[] = [
  settleRule(0, 'ledger_unread', ['state.ledger == null']),
  ...DESK_ROUNDS.flatMap((round) => {
    const n = String(round);
    const reached =
      round === 1 ? 'state.ledger != null' : `state.decision${String(round - 1)} == 'revise'`;
    const rules = [
      settleRule(round, 'strategist_failed', [reached, `state.strategist${n} == null`]),
      settleRule(round, 'approved', [`state.decision${n} == 'write_set'`]),
      settleRule(round, 'rejected_all', [`state.decision${n} == 'rejected'`]),
      settleRule(round, 'no_candidates', [`state.decision${n} == 'no_candidates'`]),
      settleRule(round, 'review_failed', [`state.decision${n} == 'review_failed'`]),
    ];
    if (round === DESK_REVIEWS_MAX) {
      rules.push(settleRule(round, 'rounds_spent', [`state.decision${n} == 'rounds_spent'`]));
    }
    return rules;
  }),
];

export const SETTLE_OTHERWISE = {
  decision: 'no_cycle',
  reason: DESK_STOP_REASONS.review_failed,
  value: { round: 0, why: 'review_failed', reason: DESK_STOP_REASONS.review_failed },
};

// ── The desk run's own outcome ────────────────────────────────────────────

/**
 * How a desk run ends, the value `deskOutcome` carries on it. The desk
 * decides what the slot's cycle may open, never whether it runs: the slot's
 * own schedule fires its cycle whatever the desk ended in. `hand_off` means a
 * cycle runs the slot with the set: the one the desk started, or the slot's
 * scheduled one where the slot could not run yet. Every outcome is recorded.
 */
const SCHEDULED_CYCLE =
  "The slot's cycle still runs on its own schedule, resolves open theses and opens nothing new.";

export const DESK_OUTCOMES = {
  hand_off:
    'The approved set is written, and the cycle the desk started has run the slot with it. When the scheduled cycle of the slot fires, it finds the slot recorded.',
  hand_off_failed:
    'The approved set is written, but the cycle the desk started did not run the slot with it. The cycle allows one active run, so a cycle in flight may have refused the start. Or the cycle ran no slot, because the slot had run already. The hand-off task and the cycle run say which. Where the slot has not run, its scheduled cycle opens from the set.',
  no_cycle: `The review approved no candidate, so the desk wrote no set. stoppedAt says why. ${SCHEDULED_CYCLE}`,
  review_refused: `The review run could not start, so the desk wrote no set. A desk holds two active runs, its own and its review run, so a desk in flight refuses it. ${SCHEDULED_CYCLE}`,
  review_failed: `The review run did not complete with a decision: it failed, was cancelled or paused. Its run says why. ${SCHEDULED_CYCLE}`,
  review_unframed: `The review run found nothing to review: the campaign ended, or its frame was gone, after this desk framed. reviewFrameReason says which. ${SCHEDULED_CYCLE}`,
  unframed: `The desk could not run, so it wrote no set. frameReason says why. ${SCHEDULED_CYCLE}`,
} as const;
export type DeskOutcome = keyof typeof DESK_OUTCOMES;

/**
 * The reason a no_cycle desk run carries where the review says why, so a
 * strategist that proposed nothing never reads as a lens rejection.
 */
export const NO_CYCLE_REASONS = {
  rejected_all: `${DESK_STOP_REASONS.rejected_all} ${SCHEDULED_CYCLE}`,
  no_candidates: `${DESK_STOP_REASONS.no_candidates} ${SCHEDULED_CYCLE}`,
} as const;

/** The reason a hand_off carries where the slot could not run yet, so its schedule runs it. */
export const HAND_OFF_SCHEDULED_REASON =
  "The approved set is written before the market opens, so a cycle started now would run no open or intraday slot. The desk starts none. The slot's scheduled cycle runs the slot with the set when it fires.";

export const START_NOW = 'start_now';
export const LEAVE_TO_SCHEDULE = 'leave_to_schedule';

/**
 * Whether the slot can run when the set is written. An open or intraday
 * cycle on a closed market runs no slot, so the desk starts none there. A
 * clock that could not be read leaves the slot to its schedule too.
 */
export const HAND_OFF_TIMING_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { allOf: ["state.slot != 'pre_market'", 'state.isOpen != true'] },
    decision: LEAVE_TO_SCHEDULE,
    reason: HAND_OFF_SCHEDULED_REASON,
  },
];

export const HAND_OFF_TIMING_OTHERWISE = {
  decision: START_NOW,
  reason: 'The slot can run now, so the desk starts its cycle with the set.',
};

function outcomeRule(outcome: DeskOutcome, comparisons: string[]): WorkflowRunDecideRule {
  const [only] = comparisons;
  return {
    when:
      comparisons.length === 1 && only !== undefined
        ? { expression: only }
        : { allOf: comparisons },
    decision: outcome,
    reason: DESK_OUTCOMES[outcome],
  };
}

/** Read in order. A review run that never started reports no outcome at all. */
export const DESK_OUTCOME_RULES: readonly WorkflowRunDecideRule[] = [
  outcomeRule('unframed', ["state.framed == 'unframed'"]),
  outcomeRule('review_refused', ['state.reviewOutcome == null']),
  outcomeRule('review_failed', ["state.reviewOutcome != 'completed'"]),
  outcomeRule('review_unframed', ["state.reviewDecision == 'unframed'"]),
  {
    when: { allOf: ["state.reviewDecision == 'no_cycle'", "state.stoppedWhy == 'no_candidates'"] },
    decision: 'no_cycle',
    reason: NO_CYCLE_REASONS.no_candidates,
  },
  {
    when: { allOf: ["state.reviewDecision == 'no_cycle'", "state.stoppedWhy == 'rejected_all'"] },
    decision: 'no_cycle',
    reason: NO_CYCLE_REASONS.rejected_all,
  },
  outcomeRule('no_cycle', ["state.reviewDecision == 'no_cycle'"]),
  outcomeRule('hand_off', [
    `state.reviewDecision == '${REVIEW_SET_WRITTEN}'`,
    'state.approvedSetPath != null',
    'state.cycleCompleted == 1',
  ]),
  {
    when: {
      allOf: [
        `state.reviewDecision == '${REVIEW_SET_WRITTEN}'`,
        'state.approvedSetPath != null',
        `state.timing == '${LEAVE_TO_SCHEDULE}'`,
      ],
    },
    decision: 'hand_off',
    reason: HAND_OFF_SCHEDULED_REASON,
  },
  outcomeRule('hand_off_failed', [
    `state.reviewDecision == '${REVIEW_SET_WRITTEN}'`,
    'state.approvedSetPath != null',
  ]),
];

export const DESK_OUTCOME_OTHERWISE = {
  decision: 'review_failed',
  reason: DESK_OUTCOMES.review_failed,
};
