/**
 * The review lenses the Strategy Desk and the Campaign Successor review
 * through, and the verdicts a reviewer of a draft may give. The desk's own
 * tally is in `strategyDeskTally.ts`. The set keeps every lens finding by
 * candidate, so a thesis's approvedId joins its outcome to what each lens said.
 */

/** What a draft reviewer may say. The desk's lenses approve or reject only. */
export const REVIEWER_VERDICTS = ['approved', 'revise', 'rejected'] as const;

export const DESK_LENSES = [
  'fundamentals',
  'macro',
  'technical',
  'priorLearnings',
  'priorDecisions',
  'risk',
  'principles',
] as const;
export type DeskLens = (typeof DESK_LENSES)[number];
