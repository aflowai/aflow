import type { PinnedState } from '@aflow/schemas';

export type ActiveRef = NonNullable<PinnedState['activeRefs']>[number];

/**
 * How many active refs the restore lists. Each line costs about 50 tokens on
 * every turn, so the restore lists the newest and the summary carries the rest.
 */
export const RESTORE_ACTIVE_REFS_MAX = 40;

export interface ActiveRefOwners {
  /** The newest refs, oldest first. The restore lists them, so the summary leaves them out. */
  restoreListed: ActiveRef[];
  /** Every other ref, oldest first. The restore leaves them out, so the summary must carry them. */
  summaryCarried: ActiveRef[];
}

/**
 * Each active ref has exactly one owner (§4.8). The restore and the summarizer
 * prompt both split the refs here, so a path the restore drops is always one
 * the summarizer was told to keep. A ref is never left to neither.
 */
export function splitActiveRefOwners(refs: readonly ActiveRef[] | undefined): ActiveRefOwners {
  const newestFirst = [...(refs ?? [])].sort((a, b) => b.fromTurn - a.fromTurn);
  return {
    restoreListed: newestFirst.slice(0, RESTORE_ACTIVE_REFS_MAX).reverse(),
    summaryCarried: newestFirst.slice(RESTORE_ACTIVE_REFS_MAX).reverse(),
  };
}
