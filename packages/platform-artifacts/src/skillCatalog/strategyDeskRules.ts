/**
 * The Strategy Desk's contracts and the few decisions its run makes without
 * a model: whether a campaign is active, and whether the strategist proposed
 * anything to review. The harness schemas are task templates, so the
 * campaign's universe and arms land in them as values before the harness
 * sees them. Nothing here caps a size, a count or an exposure: the
 * strategist sizes, and the cycle that executes checks only what the account
 * can express.
 */
import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { APPROVED_ID_PATTERN } from './dailyTradingCycleApproved.js';
import { bind } from './localPrShepherdWiring.js';
import { LENS_VERDICTS, VETO_NAMES, type DeskLens } from './strategyDeskTally.js';

export const STRATEGY_DESK_SLUG = 'strategy-desk';

export const FRAME_TASK_ID = 'frame';
export const READ_CAMPAIGN_TASK_ID = 'read-campaign';
export const READ_LEDGER_TASK_ID = 'read-ledger';
export const READ_SET_TASK_ID = 'read-set';
export const STRATEGIST_TASK_ID = 'strategist';
export const PROPOSAL_TASK_ID = 'proposal';
export const DESK_REVIEW_TASK_ID = 'desk-review';
export const WRITE_SET_TASK_ID = 'write-set';
export const WRITE_RECORD_TASK_ID = 'write-desk-record';
export const WRITE_MEMO_TASK_ID = 'write-memo';
export const WRITE_FOLDER_MEMO_TASK_ID = 'write-folder-memo';
export const barsTaskId = (symbol: string) => `bars-${symbol.toLowerCase()}`;

const researchPath = (...rest: unknown[]) => ({
  $concat: ['/research/', bind('tradingDay'), ...rest],
});

/** The day's one set, at the path `approvedThesesPath` builds. */
export const SET_PATH = researchPath('/approved-theses.json');
/** One record per desk run. */
export const DESK_RECORD_PATH = researchPath('/desk-runs/', bind('deskRunId'), '.json');
export const MEMO_MEMORY_PATH = researchPath('/strategy-memo-', bind('deskRunId'), '.md');
export const MEMO_FOLDER_PATH = {
  $concat: ['research/', bind('tradingDay'), '/strategy-memo-', bind('deskRunId'), '.md'],
};

// ── The frame ─────────────────────────────────────────────────────────────

export const FRAME_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.campaignId == null' },
    decision: 'unframed',
    reason:
      'No Daily Trading Cycle campaign is active in this space. The desk proposes for a campaign’s arms and universe, so it proposes nothing without one.',
  },
];

export const FRAME_OTHERWISE = {
  decision: 'desk',
  reason: 'A campaign is active, so the desk proposes, reviews and writes the day’s set.',
};

// ── The strategist's result ───────────────────────────────────────────────

const LEVEL = { type: 'number', exclusiveMinimum: 0 };
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

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
    // The campaign's universe and arms are the strategy's definition of a trade.
    instrument: { type: 'string', enum: bind('universe') },
    direction: { enum: ['long', 'short'] },
    hypothesisId: {
      type: 'string',
      enum: bind('hypothesisIds'),
      description: 'The id of the campaign hypothesis arm this tests.',
    },
    hypothesis: PROSE(8000),
    entryLevel: LEVEL,
    invalidationLevel: LEVEL,
    confirmationLevel: LEVEL,
    sizePct: {
      type: 'number',
      exclusiveMinimum: 0,
      description:
        'The size you propose, as a percent of equity. The cycle that executes sizes from the account it reads then.',
    },
    horizonTradingDays: { type: 'integer', minimum: 1 },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: {
        type: 'object',
        required: ['claim', 'source'],
        additionalProperties: false,
        properties: { claim: PROSE(8000), source: PROSE(2000) },
      },
    },
  },
};

export const STRATEGIST_RESULT_SCHEMA = {
  type: 'object',
  required: ['tradingDay', 'regimeRead', 'bias', 'biasReason', 'candidates', 'memo'],
  additionalProperties: false,
  properties: {
    tradingDay: { const: bind('tradingDay') },
    regimeRead: {
      ...PROSE(16000),
      description:
        'Your read of the indices, volatility, breadth and the coming events, with the numbers you computed.',
    },
    bias: { enum: ['risk_on', 'neutral', 'risk_off'] },
    biasReason: PROSE(8000),
    candidates: { type: 'array', maxItems: 40, items: CANDIDATE_SCHEMA },
    memo: { ...PROSE(60000), description: 'The research memo, in Markdown.' },
  },
};

// ── Whether there is anything to review ───────────────────────────────────

export const PROPOSAL_DECISIONS = ['review', 'no_candidates', 'strategist_failed'] as const;

export const PROPOSAL_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.candidateCount == null' },
    decision: 'strategist_failed',
    reason:
      'The strategist returned no result, so the desk wrote no set. A cycle that finds no set for the day runs the desk again.',
  },
  {
    when: { expression: 'state.candidateCount == 0' },
    decision: 'no_candidates',
    reason:
      'The strategist proposed no candidate, so no lens ran. The desk writes the empty set, and a cycle opens nothing from it.',
  },
];

export const PROPOSAL_OTHERWISE = {
  decision: 'review',
  reason: 'The strategist proposed candidates, so the lenses and the desk reviewer review them.',
};

// ── The lens and desk reviewer results ────────────────────────────────────

/** One lens's result: a verdict on each candidate it has a view on, with the reason. */
export function lensResultSchema(lens: DeskLens) {
  return {
    type: 'object',
    required: ['lens', 'verdicts', 'summary'],
    additionalProperties: false,
    properties: {
      lens: { const: lens },
      verdicts: {
        type: 'array',
        maxItems: 40,
        description:
          'A verdict on each candidate, named by its candidateId. A candidate you leave out counts as approved.',
        items: {
          type: 'object',
          required: ['candidateId', 'verdict', 'reason'],
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string', pattern: APPROVED_ID_PATTERN },
            verdict: { enum: [...LENS_VERDICTS] },
            reason: PROSE(8000),
          },
        },
      },
      summary: PROSE(8000),
    },
  };
}

/** The desk reviewer's result: its vetoes, each with its reason, and its account of the review. */
export const DESK_REVIEW_RESULT_SCHEMA = {
  type: 'object',
  required: ['vetoes', 'summary'],
  additionalProperties: false,
  properties: {
    vetoes: {
      type: 'array',
      maxItems: 40,
      description: 'Each candidate you veto. A candidate you leave out keeps the lenses’ tally.',
      items: {
        type: 'object',
        required: ['candidateId', 'by', 'reason'],
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', pattern: APPROVED_ID_PATTERN },
          by: {
            enum: [...VETO_NAMES],
            description: 'desk for your own reason, or the lens whose finding you uphold.',
          },
          reason: PROSE(8000),
        },
      },
    },
    summary: PROSE(16000),
  },
};
