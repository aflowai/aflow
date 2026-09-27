/**
 * Provider-native reasoning continuity (Plan 259) — capability gate + retention.
 *
 * Reasoning artifacts ride inline on assistant atoms (`AiMessageV1.providerReasoning`,
 * like `thoughtSignature`). This module decides, per turn, which of those artifacts
 * survive into the assembled request — bounded by the authored continuity mode and
 * always reset when the resolved provider/model changes (never cross-replayed).
 */
import type {
  AiMessageAtomV1,
  AiProviderReasoningV1,
  ReasoningContinuityMode,
} from '@aflow/schemas';

export type { ReasoningContinuityMode };

/**
 * Providers whose adapters implement tool-loop reasoning continuity: Anthropic
 * (thinking-block replay), Fireworks (reasoning_content replay), and xAI
 * (Responses reasoning items, `encrypted_content` included, replayed unchanged).
 * Three providers are deliberately excluded so an authored `tool_loop` fails
 * loud rather than silently no-op-ing or replaying invalid state:
 * - OpenAI — replayable reasoning lives in Responses-API items the agent-turn
 *   streaming path (Chat Completions) cannot round-trip (deferred). xAI is not
 *   in that bucket: its text path is Responses for both generate and stream.
 * - OpenRouter — upstream-dependent reasoning replay; not yet implemented.
 * - Google/Gemini — thought signatures go stale after Phoenix clearing/compaction,
 *   so a widened replay window would 400; safe widening needs the deferred
 *   clearing-range-aligned reasoning retention.
 */
export const TOOL_LOOP_CONTINUITY_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'fireworks',
  'xai',
]);

/** Whether the resolved model can retain reasoning across a tool-use turn. */
export function supportsToolLoopContinuity(
  provider: string | undefined,
  supportsReasoning: boolean,
): boolean {
  return (
    provider !== undefined && TOOL_LOOP_CONTINUITY_PROVIDERS.has(provider) && supportsReasoning
  );
}

/**
 * Providers where the most recent assistant turn's reasoning is a HARD wire
 * requirement, not optional continuity — Anthropic rejects a tool-use turn whose
 * thinking blocks are missing when its tool results are returned under thinking.
 * These keep a wire floor even in `off`; providers with purely-optional reasoning
 * replay (Fireworks `reasoning_content`, xAI encrypted reasoning) retain nothing in `off`, so `off` stays
 * truly wire-minimal and optional reasoning never rides the default path.
 */
const WIRE_FLOOR_PROVIDERS: ReadonlySet<string> = new Set(['anthropic']);

export type ReasoningContinuityResetReason = 'provider_switch' | 'model_switch';

/** Per-turn continuity state threaded from the handler to the commit + output. */
export interface ReasoningContinuityTurnInfo {
  requestedMode: ReasoningContinuityMode;
  effectiveMode: ReasoningContinuityMode;
  provider: string;
  /** Reasoning captured from this turn's response, stored on the accepted atom. */
  providerReasoning?: AiProviderReasoningV1;
  /** Retention diagnostics from `assembleRequest` for this turn's request. */
  stats?: {
    stateBytes: number;
    stateItems: number;
    resetReason?: ReasoningContinuityResetReason;
  };
}

export interface ReasoningRetentionResult {
  /** Atom ids whose `providerReasoning` should survive into this request. */
  keptAtomIds: Set<string>;
  /** Bytes of retained reasoning `blocks` (observability only). */
  stateBytes: number;
  /** Count of assistant turns whose reasoning is retained. */
  stateItems: number;
  /** Set when compatible reasoning was dropped because the provider/model changed. */
  resetReason?: ReasoningContinuityResetReason;
}

/**
 * Decide which assistant atoms keep their `providerReasoning` for this request.
 *
 * - reset: reasoning tagged with a different provider or model is never replayed
 *   (Anthropic requires thinking blocks stripped on model switch; other providers
 *   ignore foreign blocks). A drop for this reason is reported as `resetReason`.
 * - `off`: wire-minimal. Retain the most recent compatible assistant turn only for
 *   providers that hard-require it (WIRE_FLOOR_PROVIDERS); providers with optional
 *   reasoning replay retain nothing, so optional reasoning never rides the default path.
 * - `tool_loop`: retain compatible reasoning back to the last user instruction.
 * - `conversation`: retain all compatible reasoning (reserved; gated off today).
 */
export function retainReasoningForRequest(
  atomsInOrder: AiMessageAtomV1[],
  opts: { mode: ReasoningContinuityMode; provider: string; model: string },
): ReasoningRetentionResult {
  const kept = new Set<string>();
  let resetReason: ReasoningContinuityResetReason | undefined;

  const compatibleIdx: number[] = [];
  atomsInOrder.forEach((atom, i) => {
    const pr = atom.role === 'assistant' ? atom.message.providerReasoning : undefined;
    if (!pr) return;
    if (pr.provider !== opts.provider) {
      resetReason ??= 'provider_switch';
      return;
    }
    if (pr.model !== opts.model) {
      resetReason ??= 'model_switch';
      return;
    }
    compatibleIdx.push(i);
  });

  if (opts.mode === 'conversation') {
    for (const i of compatibleIdx) kept.add(atomsInOrder[i]!.atomId);
  } else if (opts.mode === 'tool_loop') {
    let boundary = -1;
    for (let i = atomsInOrder.length - 1; i >= 0; i--) {
      if (atomsInOrder[i]!.sourceKind === 'user_input') {
        boundary = i;
        break;
      }
    }
    for (const i of compatibleIdx) {
      if (i > boundary) kept.add(atomsInOrder[i]!.atomId);
    }
  } else if (WIRE_FLOOR_PROVIDERS.has(opts.provider)) {
    // 'off' — retain the wire floor (most recent compatible assistant turn) only
    // for providers that hard-require it; others retain nothing (truly minimal).
    const last = compatibleIdx[compatibleIdx.length - 1];
    if (last !== undefined) kept.add(atomsInOrder[last]!.atomId);
  }

  let stateBytes = 0;
  let stateItems = 0;
  for (const i of compatibleIdx) {
    const atom = atomsInOrder[i]!;
    if (!kept.has(atom.atomId)) continue;
    const pr = atom.message.providerReasoning;
    if (pr) {
      stateBytes += Buffer.byteLength(JSON.stringify(pr.blocks));
      stateItems += 1;
    }
  }

  return { keptAtomIds: kept, stateBytes, stateItems, ...(resetReason ? { resetReason } : {}) };
}
