/**
 * How the Strategy Desk's review decides, computed by code wherever a set is
 * read. Seven lenses each give a candidate approved or rejected with a
 * reason, and a lens that says nothing approves. A candidate passes when
 * fewer than half the lenses reject it. The desk reviewer holds the one veto
 * right: it reads every lens finding and may veto a candidate with a stated
 * reason, naming itself or the lens whose finding it upholds. No model folds
 * the verdicts, so nothing has to match a fold.
 */
import { z } from 'zod';
import { DESK_LENSES, type DeskLens } from './dailyTradingCycleLenses.js';

export { DESK_LENSES, type DeskLens } from './dailyTradingCycleLenses.js';

/** What one lens may say on one candidate. Silence is an approval. */
export const LENS_VERDICTS = ['approved', 'rejected'] as const;
export type LensVerdict = (typeof LENS_VERDICTS)[number];

/** Who may be named on a veto: the desk itself, or the lens whose finding the desk upholds. */
export const VETO_NAMES = ['desk', ...DESK_LENSES] as const;
export type VetoName = (typeof VETO_NAMES)[number];

/** The one sentence every prompt and doc quotes, so the rule lives here alone. */
export const DESK_TALLY_RULE = `A candidate is approved unless the desk reviewer vetoed it with a stated reason, or ${String(Math.ceil(DESK_LENSES.length / 2))} or more of the ${String(DESK_LENSES.length)} lenses rejected it. A lens that gave no verdict approves.`;

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

export const LensFindingSchema = z
  .object({
    candidateId: z.string().min(1),
    // Only a rejection counts against a candidate, so any other word approves.
    verdict: z.string(),
    reason: z.string(),
  })
  .passthrough();
export type LensFinding = z.infer<typeof LensFindingSchema>;

export const DeskVetoSchema = z
  .object({
    candidateId: z.string().min(1),
    by: z.enum(VETO_NAMES),
    reason: z.string().trim().min(1),
  })
  .passthrough();
export type DeskVeto = z.infer<typeof DeskVetoSchema>;

/**
 * A reviewed candidate as the strategist proposed it. Only what names the
 * trade is required, so an operator can write one by hand: the instrument,
 * the direction and the campaign arm it tests.
 */
export const SetCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    instrument: z.string().min(1),
    direction: z.enum(['long', 'short']),
    hypothesisId: z.string().min(1),
  })
  .passthrough();
export type SetCandidate = z.infer<typeof SetCandidateSchema>;

export interface CandidateTally {
  candidateId: string;
  instrument: string;
  direction: 'long' | 'short';
  hypothesisId: string;
  approvals: number;
  rejections: number;
  /** The lenses that gave this candidate no verdict. Each counts as an approval. */
  silent: DeskLens[];
  veto: { by: VetoName; reason: string } | null;
  approved: boolean;
  /** Why, in one sentence a decide refusal or a record can quote. */
  why: string;
}

export interface ReviewParts {
  candidates: readonly SetCandidate[];
  lenses: Partial<Record<DeskLens, readonly LensFinding[] | undefined>>;
  vetoes: readonly DeskVeto[];
}

/** The tally of every candidate, in proposal order. A repeated candidateId counts once, at its first proposal. */
export function tallyReview(review: ReviewParts): CandidateTally[] {
  const seen = new Set<string>();
  return review.candidates.flatMap((candidate): CandidateTally[] => {
    const id = candidate.candidateId;
    if (seen.has(id)) return [];
    seen.add(id);
    let approvals = 0;
    let rejections = 0;
    const silent: DeskLens[] = [];
    const rejectedBy: DeskLens[] = [];
    for (const lens of DESK_LENSES) {
      const said = review.lenses[lens]?.find((f) => f.candidateId === id);
      if (said === undefined) {
        silent.push(lens);
        approvals += 1;
      } else if (said.verdict === 'rejected') {
        rejections += 1;
        rejectedBy.push(lens);
      } else {
        approvals += 1;
      }
    }
    const vetoed = review.vetoes.find((v) => v.candidateId === id);
    const veto = vetoed ? { by: vetoed.by, reason: vetoed.reason } : null;
    const majorityRejects = rejections * 2 >= DESK_LENSES.length;
    const approved = veto === null && !majorityRejects;
    const why = veto
      ? `${id} was vetoed by ${veto.by}: ${veto.reason}`
      : majorityRejects
        ? `${id} was rejected by ${String(rejections)} of ${String(DESK_LENSES.length)} lenses (${rejectedBy.join(', ')}).`
        : `${id} was approved by ${String(approvals)} of ${String(DESK_LENSES.length)} lenses.`;
    return [
      {
        candidateId: id,
        instrument: candidate.instrument,
        direction: candidate.direction,
        hypothesisId: candidate.hypothesisId,
        approvals,
        rejections,
        silent,
        veto,
        approved,
        why,
      },
    ];
  });
}
