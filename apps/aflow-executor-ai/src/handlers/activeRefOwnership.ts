import type { PinnedState } from '@aflow/schemas';

export type ActiveRef = NonNullable<PinnedState['activeRefs']>[number];

/**
 * How many active refs the restore lists with their descriptions. A described
 * line costs about 50 tokens on every turn, so only the newest carry one. The
 * older refs stay in the list as bare paths.
 */
export const RESTORE_DESCRIBED_REFS_MAX = 40;

export interface RestoreRefList {
  /** The newest refs, oldest first. The restore lists each with its description. */
  described: ActiveRef[];
  /** Every older ref, oldest first. The restore lists each as its bare path. */
  pathOnly: ActiveRef[];
}

/**
 * The restore list holds every active ref (§4.8, D7). It is the completeness
 * guarantee, because the summary is capped at the template's maxTokens and
 * cannot hold an unbounded path list. The restore and the summarizer prompt
 * both split the refs here, so the summarizer leaves out exactly the paths
 * the restore sends.
 */
export function splitRestoreRefs(refs: readonly ActiveRef[] | undefined): RestoreRefList {
  const newestFirst = [...(refs ?? [])].sort((a, b) => b.fromTurn - a.fromTurn);
  return {
    described: newestFirst.slice(0, RESTORE_DESCRIBED_REFS_MAX).reverse(),
    pathOnly: newestFirst.slice(RESTORE_DESCRIBED_REFS_MAX).reverse(),
  };
}
