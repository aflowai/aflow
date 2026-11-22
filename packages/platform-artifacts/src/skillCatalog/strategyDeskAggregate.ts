/**
 * How the Strategy Desk folds its six lens reviews into one approved set
 * (Plan 343 Part C). Each lens is its own harness run and returns its own
 * verdict on every candidate. A lens may veto: one rejection rejects the
 * candidate, whatever the other lenses say. A lens that gave a candidate no
 * verdict vetoes it too, so a silent lens never approves. Otherwise one
 * revise sends the candidate back, and only a candidate every lens approved
 * enters the set.
 *
 * The rule is a function, so the review run's aggregate is checked against
 * it: the lens verdicts are read from the document the run itself wrote. The
 * check compares the fold's structure only: every id, verdict, round and
 * entry field. Reasons are prose a model copies, so a paraphrased reason never
 * fails the fold. The verbatim reasons stay in the record at its path.
 */
import { z } from 'zod';
import {
  canonicalJson,
  DESK_LENSES,
  REVIEWER_VERDICTS,
  type DeskLens,
} from './dailyTradingCycleLenses.js';

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

const LensRoundSchema = z.object({
  round: z.number().int(),
  verdict: z.enum(REVIEWER_VERDICTS),
  reason: z.string(),
});

/** What one lens said on one candidate: its verdict this round, and every round so far. */
export interface LensFinding {
  verdict: ReviewerVerdict;
  reason: string;
  rounds: Array<z.infer<typeof LensRoundSchema>>;
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

const PriorReviewSchema = z
  .object({
    candidateId: z.string(),
    lenses: z.record(z.object({ rounds: z.array(LensRoundSchema) }).passthrough()).optional(),
  })
  .passthrough();

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
  priorReviews: z.array(PriorReviewSchema),
});
export type LensReviewsDoc = z.infer<typeof LensReviewsDocSchema>;

export interface AggregatedReview {
  candidateId: string;
  verdict: ReviewerVerdict;
  reason: string;
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
  anyApproved: boolean;
  anyRevise: boolean;
  approvedSet: { tradingDay: string; slots: Record<string, AggregatedEntry[]> };
}

/** Each lens as a reason names it. */
export const LENS_NAMES: Record<DeskLens, string> = {
  fundamentals: 'fundamentals',
  macro: 'macro',
  technical: 'technical',
  priorLearnings: 'prior-learnings',
  priorDecisions: 'prior-decisions',
  risk: 'risk',
};

function named(lenses: readonly DeskLens[]): string {
  const names = lenses.map((lens) => LENS_NAMES[lens]);
  if (names.length === 1) return `the ${names[0] ?? ''} lens`;
  return `the ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''} lenses`;
}

function silent(lens: DeskLens): LensVerdict {
  return {
    candidateId: '',
    verdict: 'rejected',
    reason: `The ${LENS_NAMES[lens]} lens gave this candidate no verdict, so it vetoes it.`,
  };
}

/** One candidate's verdict from its lens verdicts: a rejection vetoes, then a revise sends it back. */
export function vetoVerdict(verdicts: Readonly<Record<DeskLens, ReviewerVerdict>>): {
  verdict: ReviewerVerdict;
  reason: string;
} {
  const by = (verdict: ReviewerVerdict) => DESK_LENSES.filter((lens) => verdicts[lens] === verdict);
  const rejected = by('rejected');
  if (rejected.length > 0) {
    return {
      verdict: 'rejected',
      reason: `Rejected by ${named(rejected)}. One lens rejection rejects the candidate.`,
    };
  }
  const revise = by('revise');
  if (revise.length > 0) {
    return { verdict: 'revise', reason: `Sent back for a revision by ${named(revise)}.` };
  }
  return { verdict: 'approved', reason: 'Approved by every lens.' };
}

function lensMap(
  doc: LensReviewsDoc,
  candidateId: string,
  prior: LensReviewsDoc['priorReviews'][number] | undefined,
): LensMap {
  return Object.fromEntries(
    DESK_LENSES.map((lens) => {
      const said = doc.lenses[lens].find((v) => v.candidateId === candidateId) ?? silent(lens);
      const earlier = prior?.lenses?.[lens]?.rounds ?? [];
      const finding: LensFinding = {
        verdict: said.verdict,
        reason: said.reason,
        rounds: [...earlier, { round: doc.round, verdict: said.verdict, reason: said.reason }],
      };
      return [lens, finding];
    }),
  ) as LensMap;
}

/** The aggregate the rule gives for one review round. */
export function aggregateLensReviews(doc: LensReviewsDoc): AggregatedRound {
  const prior = new Map(doc.priorReviews.map((review) => [review.candidateId, review]));
  const seen = new Set<string>();
  const reviews = doc.candidates.map((candidate): AggregatedReview => {
    const id = candidate.candidateId;
    const repeated = seen.has(id);
    seen.add(id);
    const lenses = lensMap(doc, id, prior.get(id));
    const ruled = repeated
      ? {
          verdict: 'rejected' as const,
          reason: `The strategist proposed candidateId ${id} more than once. Only its first proposal is reviewed.`,
        }
      : vetoVerdict(
          Object.fromEntries(DESK_LENSES.map((lens) => [lens, lenses[lens].verdict])) as Record<
            DeskLens,
            ReviewerVerdict
          >,
        );
    return { candidateId: id, verdict: ruled.verdict, reason: ruled.reason, lenses };
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

/**
 * The aggregate a review round submits must be exactly what the veto rule
 * gives over the lens verdicts its own run wrote. A doc another run wrote,
 * or none, refuses the aggregate whole.
 */
export function lensAggregateIssues(
  output: unknown,
  read: LensReviewsRead,
  workflowRunId: string | undefined,
): LensAggregateIssue[] {
  const identity = AggregateIdentitySchema.safeParse(output);
  if (!identity.success) {
    return [
      {
        path: [],
        message: 'The output does not name its tradingDay, slotKey, reviewRunId and round.',
      },
    ];
  }
  const { tradingDay, slotKey, reviewRunId, round } = identity.data;
  const path = lensReviewsPath(tradingDay, slotKey, reviewRunId, round);
  const refuse = (why: string): LensAggregateIssue[] => [
    { path: [], message: `The lens verdicts at ${path} ${why}, so this round has no aggregate.` },
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
  return (['reviews', 'anyApproved', 'anyRevise', 'approvedSet'] as const).flatMap((field) => {
    const want = withoutReasons(expected[field]);
    return canonicalJson(withoutReasons(submitted[field])) === canonicalJson(want)
      ? []
      : [
          {
            path: [field],
            message: `does not follow the lens veto rule over the verdicts at ${path}. Its ids, verdicts, rounds and entry fields must be: ${JSON.stringify(want)}. Keep a reason for every verdict and every lens. Reasons are not compared.`,
          },
        ];
  });
}

/** The fold's structure: the value with every `reason` left out, at any depth. */
export function withoutReasons(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReasons);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'reason')
        .map(([key, inner]) => [key, withoutReasons(inner)]),
    );
  }
  return value;
}
