/**
 * How the Strategy Desk folds its seven lens reviews into one approved set
 * (Plan 343 Part C). Each lens is its own harness run and returns its own
 * verdict on every candidate. A lens may veto: one rejection rejects the
 * candidate, whatever the other lenses say. A lens that gave a candidate no
 * verdict vetoes it too, so a silent lens never approves. Otherwise one
 * revise sends the candidate back, and only a candidate every lens approved
 * enters the set.
 *
 * The rule is a function, so the review run's aggregate is checked against
 * it: the lens verdicts are read from the document the run itself wrote. The
 * aggregate writes no prose at all, only ids, verdicts, rounds and entry
 * fields, so the check compares it exactly and no paraphrase can fail it.
 * Every reason a durable record holds comes from the lens tasks: the revise
 * round, every later lens record, the approved set's lensReviews and the
 * desk record all bind them there, verbatim.
 */
import { z } from 'zod';
import { DESK_LENSES, REVIEWER_VERDICTS, type DeskLens } from './dailyTradingCycleLenses.js';
import { fieldRefusals } from './strategyDeskAggregateDiff.js';

export { DESK_LENSES, LENS_RECORD_SCHEMA, type DeskLens } from './dailyTradingCycleLenses.js';
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];

/** The registered runtime validator that holds the aggregate to the rule. */
export const LENS_AGGREGATE_VALIDATOR_REF = 'trading.lens-aggregate' as const;

/** Where a review round's lens verdicts are written, by the review run itself. */
export function lensReviewsPath(
  tradingDay: string,
  slotKey: string,
  reviewRunId: string,
  round: number,
): string {
  return `/research/${tradingDay}/lens-reviews/${slotKey}-${reviewRunId}-round-${String(round)}.json`;
}

const LensVerdictSchema = z
  .object({
    candidateId: z.string(),
    verdict: z.enum(REVIEWER_VERDICTS),
    reason: z.string(),
  })
  .passthrough();
export type LensVerdict = z.infer<typeof LensVerdictSchema>;

/**
 * What one lens decided on one candidate: its verdict this round, and every
 * round so far. Its reasons are verbatim in the lens record and the set's
 * lensReviews, keyed by lens, round and candidateId.
 */
export interface LensFinding {
  verdict: ReviewerVerdict;
  rounds: Array<{ round: number; verdict: ReviewerVerdict }>;
}
export type LensMap = Record<DeskLens, LensFinding>;

const CandidateSchema = z
  .object({
    candidateId: z.string(),
    instrument: z.string(),
    direction: z.enum(['long', 'short']),
    hypothesisId: z.string(),
    entryLevel: z.number(),
    invalidationLevel: z.number(),
    confirmationLevel: z.number(),
    sizePct: z.number(),
    horizonTradingDays: z.number(),
  })
  .passthrough();
export type DeskCandidate = z.infer<typeof CandidateSchema>;

const LensVerdictsSchema = z.object(
  Object.fromEntries(DESK_LENSES.map((lens) => [lens, z.array(LensVerdictSchema)])) as Record<
    DeskLens,
    z.ZodArray<typeof LensVerdictSchema>
  >,
);

/** The document a review round writes before it aggregates: what every lens said. */
export const LensReviewsDocSchema = z.object({
  tradingDay: z.string(),
  slotKey: z.string(),
  reviewRunId: z.string(),
  round: z.number().int().min(1),
  candidates: z.array(CandidateSchema),
  lenses: LensVerdictsSchema,
  /**
   * What every lens said in each earlier round, copied from the lens tasks'
   * own outputs and never from an aggregate, so every reason is verbatim.
   */
  priorRounds: z.array(z.object({ round: z.number().int().min(1), lenses: LensVerdictsSchema })),
});
export type LensReviewsDoc = z.infer<typeof LensReviewsDocSchema>;

export interface AggregatedReview {
  candidateId: string;
  verdict: ReviewerVerdict;
  lenses: LensMap;
}

export interface AggregatedEntry {
  approvedId: string;
  instrument: string;
  direction: 'long' | 'short';
  hypothesisId: string;
  entryLevel: number;
  invalidationLevel: number;
  confirmationLevel: number;
  maxSizePct: number;
  horizonTradingDays: number;
  reviewerVerdict: 'approved';
  reviewRunId: string;
  lenses: LensMap;
}

export interface AggregatedRound {
  reviews: AggregatedReview[];
  /** Each candidate's verdict alone. It carries no prose, so the revise round reads it as the rule gave it. */
  candidateVerdicts: Array<{ candidateId: string; verdict: ReviewerVerdict }>;
  anyApproved: boolean;
  anyRevise: boolean;
  approvedSet: { tradingDay: string; slots: Record<string, AggregatedEntry[]> };
}

/** Each lens as prose and task ids name it. */
export const LENS_NAMES: Record<DeskLens, string> = {
  fundamentals: 'fundamentals',
  macro: 'macro',
  technical: 'technical',
  priorLearnings: 'prior-learnings',
  priorDecisions: 'prior-decisions',
  risk: 'risk',
  principles: 'principles',
};

/** A lens that gave a candidate no verdict vetoes it. */
const SILENT_VERDICT: ReviewerVerdict = 'rejected';

/** One candidate's verdict from its lens verdicts: a rejection vetoes, then a revise sends it back. */
export function vetoVerdict(
  verdicts: Readonly<Record<DeskLens, ReviewerVerdict>>,
): ReviewerVerdict {
  const said = DESK_LENSES.map((lens) => verdicts[lens]);
  if (said.includes('rejected')) return 'rejected';
  if (said.includes('revise')) return 'revise';
  return 'approved';
}

function lensMap(doc: LensReviewsDoc, candidateId: string): LensMap {
  const earlierRounds = [...doc.priorRounds].sort((a, b) => a.round - b.round);
  return Object.fromEntries(
    DESK_LENSES.map((lens) => {
      const verdict =
        doc.lenses[lens].find((v) => v.candidateId === candidateId)?.verdict ?? SILENT_VERDICT;
      const earlier = earlierRounds.flatMap(({ round, lenses }) => {
        const then = lenses[lens].find((v) => v.candidateId === candidateId);
        return then === undefined ? [] : [{ round, verdict: then.verdict }];
      });
      const finding: LensFinding = { verdict, rounds: [...earlier, { round: doc.round, verdict }] };
      return [lens, finding];
    }),
  ) as LensMap;
}

/** The aggregate the rule gives for one review round. */
export function aggregateLensReviews(doc: LensReviewsDoc): AggregatedRound {
  const seen = new Set<string>();
  const reviews = doc.candidates.map((candidate): AggregatedReview => {
    const id = candidate.candidateId;
    const repeated = seen.has(id);
    seen.add(id);
    const lenses = lensMap(doc, id);
    // A candidateId proposed twice is reviewed once, at its first proposal.
    const verdict: ReviewerVerdict = repeated
      ? 'rejected'
      : vetoVerdict(
          Object.fromEntries(DESK_LENSES.map((lens) => [lens, lenses[lens].verdict])) as Record<
            DeskLens,
            ReviewerVerdict
          >,
        );
    return { candidateId: id, verdict, lenses };
  });
  const entries = doc.candidates.flatMap((candidate, i): AggregatedEntry[] => {
    const review = reviews[i];
    if (review?.verdict !== 'approved') return [];
    return [
      {
        approvedId: candidate.candidateId,
        instrument: candidate.instrument,
        direction: candidate.direction,
        hypothesisId: candidate.hypothesisId,
        entryLevel: candidate.entryLevel,
        invalidationLevel: candidate.invalidationLevel,
        confirmationLevel: candidate.confirmationLevel,
        maxSizePct: candidate.sizePct,
        horizonTradingDays: candidate.horizonTradingDays,
        reviewerVerdict: 'approved',
        reviewRunId: doc.reviewRunId,
        lenses: review.lenses,
      },
    ];
  });
  return {
    reviews,
    candidateVerdicts: reviews.map(({ candidateId, verdict }) => ({ candidateId, verdict })),
    anyApproved: reviews.some((r) => r.verdict === 'approved'),
    anyRevise: reviews.some((r) => r.verdict === 'revise'),
    approvedSet: { tradingDay: doc.tradingDay, slots: { [doc.slotKey]: entries } },
  };
}

/** The aggregate's identity: which round of which review run it folds. */
const AggregateIdentitySchema = z
  .object({
    tradingDay: z.string(),
    slotKey: z.string(),
    reviewRunId: z.string(),
    round: z.number().int().min(1),
  })
  .passthrough();

export interface LensReviewsRead {
  /** The doc at the round's path, or why it could not be read. */
  doc:
    | { status: 'missing' }
    | { status: 'unreadable'; reason: string }
    | { status: 'found'; content: unknown };
  /** The workflow runs whose task wrote its current version. */
  writerRunIds: readonly string[];
}

export interface LensAggregateIssue {
  path: Array<string | number>;
  message: string;
}

/** The path an aggregate output names for its round's lens verdicts, or null where it names none. */
export function lensReviewsPathOf(output: unknown): string | null {
  const identity = AggregateIdentitySchema.safeParse(output);
  if (!identity.success) return null;
  const { tradingDay, slotKey, reviewRunId, round } = identity.data;
  return lensReviewsPath(tradingDay, slotKey, reviewRunId, round);
}

const IDENTITY_FIELDS = ['tradingDay', 'slotKey', 'reviewRunId', 'round'] as const;

/** One line for each identity field the output leaves out, empty, or of the wrong type. */
function identityIssues(output: unknown, workflowRunId: string | undefined): LensAggregateIssue[] {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return [{ path: [], message: 'is not an object. Submit the aggregate as one JSON object.' }];
  }
  const submitted = output as Record<string, unknown>;
  const issues = IDENTITY_FIELDS.flatMap((field): LensAggregateIssue[] => {
    const value = submitted[field];
    const copy = `Copy your \`${field}\` input as it stands.`;
    if (value === undefined) return [{ path: [field], message: `is missing. ${copy}` }];
    if (field === 'round') {
      return Number.isInteger(value) && (value as number) >= 1
        ? []
        : [{ path: [field], message: `is ${JSON.stringify(value)}, not a round number. ${copy}` }];
    }
    if (typeof value !== 'string') {
      return [{ path: [field], message: `is ${JSON.stringify(value)}, not a string. ${copy}` }];
    }
    return value === '' ? [{ path: [field], message: `is the empty string. ${copy}` }] : [];
  });
  if (issues.length > 0) return issues;
  const reviewRunId = submitted['reviewRunId'];
  if (workflowRunId !== undefined && reviewRunId !== workflowRunId) {
    return [
      {
        path: ['reviewRunId'],
        message: `is ${JSON.stringify(reviewRunId)}, but this review run is ${JSON.stringify(workflowRunId)}. Copy your \`reviewRunId\` input as it stands.`,
      },
    ];
  }
  return [];
}

/**
 * The aggregate a review round submits must be exactly what the veto rule
 * gives over the lens verdicts its own run wrote. That record holds the same
 * candidates and lens verdicts the aggregating Runner has as inputs, so every
 * refusal names what to change in terms of those inputs alone. A doc another
 * run wrote, or none, refuses the aggregate whole.
 */
export function lensAggregateIssues(
  output: unknown,
  read: LensReviewsRead,
  workflowRunId: string | undefined,
): LensAggregateIssue[] {
  const malformed = identityIssues(output, workflowRunId);
  if (malformed.length > 0) return malformed;
  const identity = AggregateIdentitySchema.safeParse(output);
  if (!identity.success) return [{ path: [], message: 'does not name its round.' }];
  const { tradingDay, slotKey, reviewRunId, round } = identity.data;
  const path = lensReviewsPath(tradingDay, slotKey, reviewRunId, round);
  // The Runner cannot read this record, and no draft repairs it, so the refusal says to stop.
  const refuse = (why: string): LensAggregateIssue[] => [
    {
      path: [],
      message: `The lens record this run wrote at ${path} ${why}, so this round has no aggregate. No draft can pass. Report this round blocked.`,
    },
  ];
  if (read.doc.status === 'missing') return refuse('do not exist');
  if (read.doc.status === 'unreadable') return refuse(`cannot be read (${read.doc.reason})`);
  if (
    workflowRunId === undefined ||
    read.writerRunIds.length !== 1 ||
    read.writerRunIds[0] !== workflowRunId
  ) {
    return refuse('were not written by this review run');
  }
  const doc = LensReviewsDocSchema.safeParse(read.doc.content);
  if (!doc.success) {
    const first = doc.error.issues[0];
    const detail = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid';
    return refuse(`do not parse (${detail})`);
  }
  if (
    doc.data.tradingDay !== tradingDay ||
    doc.data.slotKey !== slotKey ||
    doc.data.reviewRunId !== reviewRunId ||
    doc.data.round !== round
  ) {
    return refuse('name another round');
  }
  const expected = aggregateLensReviews(doc.data);
  const submitted = output as Record<string, unknown>;
  return fieldRefusals(
    AGGREGATE_FIELDS.map((field) => ({
      field,
      expected: expected[field],
      actual: submitted[field],
    })),
  ).map(({ field, message }) => ({ path: [field], message }));
}

const AGGREGATE_FIELDS = [
  'reviews',
  'candidateVerdicts',
  'anyApproved',
  'anyRevise',
  'approvedSet',
] as const satisfies ReadonlyArray<keyof AggregatedRound>;
