/**
 * The review of one desk round as six separate reviews (Plan 343 Part C).
 * Each lens is its own harness run inside the review run, with its own focus
 * and only the reads its lens needs, and returns its own verdict on every
 * candidate. The run writes what every lens said to memory with an operation
 * task, then a Runner folds the verdicts into one approved set. The fold is
 * the veto rule of `strategyDeskAggregate.ts`, and a registered validator
 * holds the Runner to it against the record this run wrote. The lens runs are
 * tasks of the review run, so the skill's run cap is unchanged.
 */
import { REVIEWER_VERDICTS, APPROVED_ID_PATTERN } from './dailyTradingCycleApproved.js';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  DESK_LENSES,
  LENS_AGGREGATE_VALIDATOR_REF,
  LENS_NAMES,
  LENS_RECORD_SCHEMA,
  type DeskLens,
} from './strategyDeskAggregate.js';
import { DESK_AGGREGATE_PROMPT, deskLensTask } from './strategyDeskProse.js';
import {
  DESK_REVIEWS_MAX,
  READ_CAMPAIGN_TASK_ID,
  READ_LEDGER_TASK_ID,
  reviewTaskId,
  SLOT_KEY,
  strategistTaskId,
} from './strategyDeskRules.js';

export const lensTaskId = (lens: DeskLens, round: number) =>
  `lens-${LENS_NAMES[lens]}-${String(round)}`;
export const lensReviewsTaskId = (round: number) => `lens-reviews-${String(round)}`;

/** The ledger reads a lens may take. Every lens also reads the ledger note, which names failed reads. */
type LedgerRead =
  | 'openTheses'
  | 'resolvedTheses'
  | 'recentCycles'
  | 'priorDesk'
  | 'operatorNotes'
  | 'universeSnapshots'
  | 'news'
  | 'journal';
type ProposalRead = 'bias' | 'workingGrossCapPct' | 'regime';

/** What each lens reads: only what its lens needs, beside the candidates every lens reviews. */
export const DESK_LENS_READS: Record<
  DeskLens,
  { ledger: readonly LedgerRead[]; proposal: readonly ProposalRead[]; campaign: boolean }
> = {
  fundamentals: { ledger: ['universeSnapshots', 'news'], proposal: [], campaign: false },
  macro: { ledger: ['news'], proposal: ['regime', 'bias'], campaign: false },
  technical: { ledger: ['universeSnapshots'], proposal: ['regime'], campaign: false },
  priorLearnings: { ledger: ['resolvedTheses', 'journal'], proposal: [], campaign: false },
  priorDecisions: {
    ledger: ['recentCycles', 'priorDesk', 'operatorNotes'],
    proposal: [],
    campaign: true,
  },
  risk: { ledger: ['openTheses'], proposal: ['workingGrossCapPct', 'regime'], campaign: true },
};

const HARNESS_TIMEOUT_MS = 40 * 60_000;
const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const SLOT_BINDINGS = {
  tradingDay: runInput('tradingDay'),
  slot: runInput('slot'),
  slotIndex: runInput('slotIndex'),
};

/** One lens's result: its own verdict on every candidate, with the reason. */
export function lensResultSchema(lens: DeskLens) {
  return {
    type: 'object',
    required: ['lens', 'verdicts', 'summary'],
    additionalProperties: false,
    properties: {
      lens: { const: lens },
      verdicts: {
        type: 'array',
        maxItems: 20,
        description:
          'One verdict for each candidate, named by its candidateId. A candidate with none counts as this lens’s rejection.',
        items: {
          type: 'object',
          required: ['candidateId', 'verdict', 'reason'],
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string', pattern: APPROVED_ID_PATTERN },
            verdict: { enum: [...REVIEWER_VERDICTS] },
            reason: PROSE(4000),
          },
        },
      },
      summary: PROSE(8000),
    },
  };
}

function lensTask(lens: DeskLens, round: number) {
  const strategist = strategistTaskId(round);
  const reads = DESK_LENS_READS[lens];
  return {
    taskId: lensTaskId(lens, round),
    name: `Review round ${String(round)} through the ${LENS_NAMES[lens]} lens`,
    goal: `Run the ${LENS_NAMES[lens]} lens on the harness over the folder: give every candidate of strategist round ${String(round)} its own verdict through this lens alone, with the reason. A rejection here vetoes the candidate.`,
    type: 'operation' as const,
    operation: 'host.harness.run',
    dependsOn: [READ_CAMPAIGN_TASK_ID, READ_LEDGER_TASK_ID, strategist],
    when: { expression: `tasks.${strategist}.output.bias != null`, onMissingRef: SKIP },
    // A lens with no result fails the round through its counter, which names it.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      ...SLOT_BINDINGS,
      reviewHarness: runInput('reviewHarness'),
      reviewModel: runInput('reviewModel'),
      candidates: out(strategist, 'candidates'),
      ledgerNote: out(READ_LEDGER_TASK_ID, 'ledgerNote'),
      ...Object.fromEntries(
        reads.ledger.map((field) => [`ledger_${field}`, out(READ_LEDGER_TASK_ID, field)]),
      ),
      ...Object.fromEntries(
        reads.proposal.map((field) => [`proposal_${field}`, out(strategist, field)]),
      ),
      ...(reads.campaign ? { campaign: out(READ_CAMPAIGN_TASK_ID, 'config') } : {}),
    },
    context: ctx('host.harness.run'),
    inputTemplate: {
      bindingId: bind('bindingId'),
      harness: bind('reviewHarness'),
      model: bind('reviewModel'),
      task: deskLensTask(lens),
      inputs: {
        focus: lens,
        tradingDay: bind('tradingDay'),
        slot: bind('slot'),
        slotKey: SLOT_KEY,
        round,
        revisesLeft: DESK_REVIEWS_MAX - round,
        candidates: bind('candidates'),
        ledger: {
          ledgerNote: bind('ledgerNote'),
          ...Object.fromEntries(reads.ledger.map((field) => [field, bind(`ledger_${field}`)])),
        },
        ...(reads.proposal.length > 0
          ? {
              proposal: Object.fromEntries(
                reads.proposal.map((field) => [field, bind(`proposal_${field}`)]),
              ),
            }
          : {}),
        ...(reads.campaign ? { campaign: bind('campaign') } : {}),
      },
      outputSchema: lensResultSchema(lens),
      resultRetries: 2,
      timeoutMs: HARNESS_TIMEOUT_MS,
    },
    outputProjection: {
      verdicts: { path: 'result.verdicts', onMissing: 'error' as const },
      summary: { path: 'result.summary', onMissing: 'error' as const },
      harness: { path: 'harness.id', onMissing: 'null' as const },
    },
  };
}

/** `lensReviewsPath`, built from the run's own inputs. */
export function lensReviewsPathTemplate(round: number) {
  return {
    $concat: [
      '/research/',
      bind('tradingDay'),
      '/lens-reviews/',
      SLOT_KEY,
      '-',
      bind('reviewRunId'),
      `-round-${String(round)}.json`,
    ],
  };
}

const lensVerdictsAs = (lens: DeskLens) => `verdicts_${lens}`;

const earlierRounds = (round: number) => Array.from({ length: round - 1 }, (_, i) => i + 1);

/** The name an earlier round's lens verdicts bind as: `round1_macro`. */
export const priorLensAs = (round: number, lens: DeskLens) => `round${String(round)}_${lens}`;

/**
 * Every earlier round's lens verdicts, bound from the lens tasks themselves.
 * No aggregate output is ever a source of a reason a later round reads.
 */
export function priorLensBindings(round: number) {
  return Object.fromEntries(
    earlierRounds(round).flatMap((r) =>
      DESK_LENSES.map((lens) => [priorLensAs(r, lens), out(lensTaskId(lens, r), 'verdicts')]),
    ),
  );
}

const priorLensTasks = (round: number) =>
  earlierRounds(round).flatMap((r) => DESK_LENSES.map((lens) => lensTaskId(lens, r)));

function lensReviewsTask(round: number) {
  const strategist = strategistTaskId(round);
  const lenses = DESK_LENSES.map((lens) => lensTaskId(lens, round));
  return {
    taskId: lensReviewsTaskId(round),
    name: `Record the lens verdicts of round ${String(round)}`,
    goal: 'Write what every lens said this round to memory before the round is aggregated. The aggregate is checked against this record, and the desk record and the eval plane read it.',
    type: 'operation' as const,
    operation: 'memory.store.put',
    dependsOn: [
      strategist,
      ...lenses,
      ...priorLensTasks(round),
      ...(round > 1 ? [reviewTaskId(round - 1)] : []),
    ],
    when: {
      allOf: lenses.map((taskId) => `tasks.${taskId}.output.verdicts != null`),
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    inputBindings: {
      ...SLOT_BINDINGS,
      reviewRunId: { kind: 'run_id' as const },
      candidates: out(strategist, 'candidates'),
      ...Object.fromEntries(
        DESK_LENSES.map((lens) => [lensVerdictsAs(lens), out(lensTaskId(lens, round), 'verdicts')]),
      ),
      ...priorLensBindings(round),
    },
    context: ctx('memory.store.put'),
    inputTemplate: {
      path: lensReviewsPathTemplate(round),
      docType: 'json',
      mimeType: 'application/json',
      content: {
        inlineJson: {
          tradingDay: bind('tradingDay'),
          slotKey: SLOT_KEY,
          reviewRunId: bind('reviewRunId'),
          round,
          candidates: bind('candidates'),
          lenses: Object.fromEntries(DESK_LENSES.map((lens) => [lens, bind(lensVerdictsAs(lens))])),
          priorRounds: earlierRounds(round).map((r) => ({
            round: r,
            lenses: Object.fromEntries(
              DESK_LENSES.map((lens) => [lens, bind(priorLensAs(r, lens))]),
            ),
          })),
        },
      },
      writeMode: 'upsert',
      indexing: 'disabled',
    },
    outputProjection: {
      path: { path: 'path', onMissing: 'error' as const },
      // What was written, so the aggregate can be pinned to the round it folds.
      record: { fromInput: 'content' },
    },
  };
}

const LENS_MAP_SCHEMA = { ...LENS_RECORD_SCHEMA, type: 'object' };

/** The aggregate's contract. The validator refuses any value the veto rule does not give. */
export function aggregateResultSchema(round: number) {
  return {
    type: 'object',
    required: [
      'tradingDay',
      'slotKey',
      'reviewRunId',
      'round',
      'reviews',
      'candidateVerdicts',
      'anyApproved',
      'anyRevise',
      'approvedSet',
      'summary',
    ],
    additionalProperties: false,
    properties: {
      tradingDay: { type: 'string', description: 'Copied from your input. It is pinned.' },
      slotKey: { type: 'string', description: 'Copied from your input. It is pinned.' },
      reviewRunId: { type: 'string', description: 'Copied from your input. It is pinned.' },
      round: { const: round },
      reviews: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          required: ['candidateId', 'verdict', 'reason', 'lenses'],
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            verdict: { enum: [...REVIEWER_VERDICTS] },
            reason: { type: 'string' },
            lenses: LENS_MAP_SCHEMA,
          },
        },
      },
      candidateVerdicts: {
        type: 'array',
        maxItems: 20,
        description: 'Each review’s candidateId and verdict, in the same order, and nothing else.',
        items: {
          type: 'object',
          required: ['candidateId', 'verdict'],
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            verdict: { enum: [...REVIEWER_VERDICTS] },
          },
        },
      },
      anyApproved: { type: 'boolean' },
      anyRevise: { type: 'boolean' },
      approvedSet: {
        type: 'object',
        required: ['tradingDay', 'slots'],
        additionalProperties: false,
        properties: {
          tradingDay: { type: 'string' },
          slots: { type: 'object', additionalProperties: { type: 'array' } },
        },
      },
      summary: PROSE(8000),
    },
  };
}

function aggregateTask(round: number) {
  const strategist = strategistTaskId(round);
  const record = lensReviewsTaskId(round);
  return {
    taskId: reviewTaskId(round),
    name: `Aggregate the lens reviews, round ${String(round)}`,
    goal: DESK_AGGREGATE_PROMPT,
    type: 'agent' as const,
    dependsOn: [
      strategist,
      record,
      ...priorLensTasks(round),
      ...(round > 1 ? [reviewTaskId(round - 1)] : []),
    ],
    when: { expression: `tasks.${record}.output.path != null`, onMissingRef: SKIP },
    optional: true,
    inputs: { round },
    inputBindings: {
      tradingDay: runInput('tradingDay'),
      slot: runInput('slot'),
      slotIndex: runInput('slotIndex'),
      reviewRunId: { kind: 'run_id' as const },
      slotKey: out(strategist, 'slotKey'),
      candidates: out(strategist, 'candidates'),
      ...Object.fromEntries(
        DESK_LENSES.map((lens) => [lens, out(lensTaskId(lens, round), 'verdicts')]),
      ),
      ...priorLensBindings(round),
    },
    context: {
      strategy: 'scoped' as const,
      contextPolicy: 'auto-optimize' as const,
      learnings: 'none' as const,
      // It folds what it is handed: no read, no write.
      capabilities: { operations: [], integrations: [] },
    },
    outputContract: {
      schema: aggregateResultSchema(round),
      derivedFrom: [
        {
          bindingId: 'aggregate-trading-day-pin',
          from: record,
          binding: 'value:$.record.inlineJson.tradingDay',
          target: '$.tradingDay.const',
        },
        {
          bindingId: 'aggregate-review-run-pin',
          from: record,
          binding: 'value:$.record.inlineJson.reviewRunId',
          target: '$.reviewRunId.const',
        },
        {
          bindingId: 'aggregate-slot-key-pin',
          from: strategist,
          binding: 'value:$.slotKey',
          target: '$.slotKey.const',
        },
      ],
      validatorRefs: [LENS_AGGREGATE_VALIDATOR_REF],
    },
  };
}

/** One review round: the six lens runs, the record of what they said, and the aggregate. */
export function lensReviewTasks(round: number) {
  return [
    ...DESK_LENSES.map((lens) => lensTask(lens, round)),
    lensReviewsTask(round),
    aggregateTask(round),
  ];
}
