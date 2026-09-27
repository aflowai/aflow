import { MAX_ATOMS_STRUCTURAL } from '@aflow/schemas';

export const RETENTION_POLICY = {
  /** Tier-2 trigger (§4.3): start clearing only above this pressure — below it, verbatim + cache-stable history wins. */
  clearHighWater: 0.55,
  /** Hysteresis target: greedy clearing stops once estimated pressure reaches this — bursts, not per-turn churn. */
  clearLowWater: 0.4,
  /** Tier-3 trigger (§4.8): compact only when POST-clearing pressure still exceeds this. */
  compactHighWater: 0.7,
  /** Tier-1 verbatim recency: exchanges/turns this recent are never cleared or compacted. */
  keepRecentTurns: 3,
  /** Tier-3 range floor: fewer content turns than this aren't worth a summarizer call. */
  minCompactableTurns: 3,
  /** Tier-3 summarizer — cheap/fast class. */
  compactionSummaryModel: 'flash-lite',
  /** Bound on a clear-to-ref note's size, outline hint included (§4.4). */
  noteMaxTokens: 200,
  /** Note-format bound (§4.4): argument digests and ref descriptions inside notes. */
  noteDigestMaxChars: 120,
  /** Note-format bound (§4.4): status/error one-line snippets inside notes. */
  noteSnippetMaxChars: 80,
  /** State-size/assembly-cost bound only (§4.7) — never a policy window. */
  maxAtomsStructural: MAX_ATOMS_STRUCTURAL,
  /** Principle 3: a note must save at least its own cost again — derived per exchange, never absolute. */
  minClearNetSavings: (noteTokens: number): number => noteTokens * 2,
} as const;

export interface PinnableAtom {
  atomId: string;
  sourceKind?: string | undefined;
  turnNumber?: number | undefined;
}

/**
 * Tier-0 pin set (§4.1), derived structurally at evaluation time — never a
 * stored flag. Pinned: the opening user_input atom(s) (every turn-0 user_input,
 * or the first user_input when turn numbers are absent), the latest
 * compaction_restore atom, and every atom of the current turn. Pinning binds
 * clearing, compaction range selection, and the Tier-4 safety bound.
 */
export function computePinnedAtomIds(
  atoms: readonly PinnableAtom[],
  currentTurnNumber?: number,
): Set<string> {
  const pinned = new Set<string>();
  let firstUserInputId: string | undefined;
  let latestRestoreId: string | undefined;
  let sawTurnZeroUserInput = false;

  for (const atom of atoms) {
    if (atom.sourceKind === 'user_input') {
      firstUserInputId ??= atom.atomId;
      if (atom.turnNumber === 0) {
        pinned.add(atom.atomId);
        sawTurnZeroUserInput = true;
      }
    }
    if (atom.sourceKind === 'compaction_restore') {
      latestRestoreId = atom.atomId;
    }
    if (
      currentTurnNumber !== undefined &&
      atom.turnNumber !== undefined &&
      atom.turnNumber >= currentTurnNumber
    ) {
      pinned.add(atom.atomId);
    }
  }

  if (!sawTurnZeroUserInput && firstUserInputId !== undefined) {
    pinned.add(firstUserInputId);
  }
  if (latestRestoreId !== undefined) {
    pinned.add(latestRestoreId);
  }
  return pinned;
}
