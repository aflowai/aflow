import { MIN_ANSWER_TOKENS } from '@aflow/ai-client';
import { MAX_ATOMS_STRUCTURAL } from '@aflow/schemas';

/** Assumed when the model catalog reports no context window for the turn's model. */
export const DEFAULT_MODEL_WINDOW_TOKENS = 200_000;
/**
 * Held back from the prompt for the model's answer. The same floor a local
 * runtime refuses a prompt below, so a prompt this budget admits is never
 * refused there.
 */
export const COMPLETION_RESERVE_TOKENS = MIN_ANSWER_TOKENS;
/** Share of the window held back because prompt tokens are estimated before the call, not counted. */
export const SAFETY_MARGIN_FRACTION = 0.05;
/** The window whose hard budget caps the working budget, so a model of this window or smaller keeps the trigger points it always had. */
export const WORKING_BUDGET_REFERENCE_WINDOW_TOKENS = 200_000;

/** What the model can take: the window less the completion reserve and the safety margin. */
export function hardBudgetTokens(modelWindow: number): number {
  return modelWindow - COMPLETION_RESERVE_TOKENS - Math.ceil(modelWindow * SAFETY_MARGIN_FRACTION);
}

/**
 * Tier-1 verbatim recency, in turns, on every path — pressure clearing, forced
 * clearing and compaction. A turn carries one call and the result of the call
 * before it, so the agent's working set is its last few read-then-act cycles.
 * Three turns held one cycle, and a result the agent was still acting on
 * became a stub it then read again. Eight turns hold four cycles.
 */
export const RECENT_TURNS_FLOOR = 8;

/**
 * A tool result under this many tokens (about 7 KB) is never replaced by a
 * clear-to-ref stub (§4.4). The stub costs up to `noteMaxTokens`, and a
 * re-read costs a turn plus the result again, so clearing a small result saves
 * little and often costs more. A small result leaves history only through
 * compaction, with its turn, where the summary keeps its facts.
 */
export const LARGE_RESULT_MIN_TOKENS = 2_000;

/**
 * Absolute floor on what one clear must save (§4.3). A clear rewrites history
 * at the note's position, so the provider reads every later message uncached
 * once. A saving under this does not pay for that read.
 */
export const MIN_CLEAR_NET_SAVINGS_TOKENS = 1_500;

export const RETENTION_POLICY = {
  /**
   * How much history a turn should carry, whatever the window. Every turn pays for its whole
   * prompt, so a window large enough to hold a long conversation is no reason to keep sending
   * all of it: clearing and compaction are sized to this, and the window bounds only the forced pass.
   */
  workingBudgetTokens: hardBudgetTokens(WORKING_BUDGET_REFERENCE_WINDOW_TOKENS),
  /** Tier-2 trigger (§4.3), a share of the working budget: start clearing only above this pressure — below it, verbatim + cache-stable history wins. */
  clearHighWater: 0.55,
  /** Hysteresis target, a share of the working budget: greedy clearing stops once estimated pressure reaches this — bursts, not per-turn churn. */
  clearLowWater: 0.4,
  /** Tier-3 trigger (§4.8), a share of the working budget: compact only when POST-clearing pressure still exceeds this. */
  compactHighWater: 0.7,
  /** Tier-1 verbatim recency: exchanges/turns this recent are never cleared or compacted. */
  keepRecentTurns: RECENT_TURNS_FLOOR,
  /** Tier-2 size threshold: every result of a cleared exchange measures at least this. */
  largeResultMinTokens: LARGE_RESULT_MIN_TOKENS,
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
  /**
   * State-size/assembly-cost bound only (§4.7) — never a policy window. Reaching it
   * triggers compaction of the older range. It never clears an exchange.
   */
  maxAtomsStructural: MAX_ATOMS_STRUCTURAL,
  /** Principle 3: a note must save its own cost twice over, and never less than the absolute floor. */
  minClearNetSavings: (noteTokens: number): number =>
    Math.max(MIN_CLEAR_NET_SAVINGS_TOKENS, noteTokens * 2),
} as const;

export interface TurnBudgets {
  modelWindow: number;
  reservedForCompletion: number;
  /** Bounds the forced clearing and every excess computation. */
  hardBudget: number;
  /** Drives the clearing trigger, the clearing target and the compaction trigger, nothing else. */
  workingBudget: number;
}

export function turnBudgets(modelContextWindow: number | undefined): TurnBudgets {
  const modelWindow =
    modelContextWindow && modelContextWindow > 0 ? modelContextWindow : DEFAULT_MODEL_WINDOW_TOKENS;
  const hardBudget = hardBudgetTokens(modelWindow);
  return {
    modelWindow,
    reservedForCompletion: COMPLETION_RESERVE_TOKENS,
    hardBudget,
    workingBudget: Math.min(hardBudget, RETENTION_POLICY.workingBudgetTokens),
  };
}

export interface PinnableAtom {
  atomId: string;
  sourceKind?: string | undefined;
  turnNumber?: number | undefined;
}

/**
 * Tier-0 pin set (§4.1), derived structurally at evaluation time — never a
 * stored flag. Pinned: the opening user_input atom(s) (every turn-0 user_input,
 * or the first user_input when turn numbers are absent), the latest user_input
 * (the request the current run answers), the latest compaction_restore atom,
 * and every atom of the current turn. Pinning binds clearing, compaction range
 * selection, and the Tier-4 safety bound.
 */
export function computePinnedAtomIds(
  atoms: readonly PinnableAtom[],
  currentTurnNumber?: number,
): Set<string> {
  const pinned = new Set<string>();
  let firstUserInputId: string | undefined;
  let latestUserInputId: string | undefined;
  let latestRestoreId: string | undefined;
  let sawTurnZeroUserInput = false;

  for (const atom of atoms) {
    if (atom.sourceKind === 'user_input') {
      firstUserInputId ??= atom.atomId;
      latestUserInputId = atom.atomId;
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
  if (latestUserInputId !== undefined) {
    pinned.add(latestUserInputId);
  }
  if (latestRestoreId !== undefined) {
    pinned.add(latestRestoreId);
  }
  return pinned;
}

/**
 * Where the current run starts (§4.10): the position of the latest user_input
 * atom in the committed list, or -1 when there is none and so no current run.
 * An exchange whose first atom sits after this position was created by the
 * current run. Pressure clearing never takes it, because the run is still
 * acting on what it read. Compaction relieves the run instead. Only the
 * hard-budget pass may clear it (§4.7).
 */
export function currentRunStartIndex(atoms: readonly PinnableAtom[]): number {
  for (let i = atoms.length - 1; i >= 0; i--) {
    if (atoms[i]!.sourceKind === 'user_input') return i;
  }
  return -1;
}
