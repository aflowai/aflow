/**
 * Reasoning-effort resolution against a model's declared profile.
 *
 * Providers reject efforts their model does not implement, and they reject them
 * as a 400 mid-run rather than a startup error. Every effort therefore passes
 * through `resolveReasoningForModel` before it reaches an adapter, so an
 * unrepresentable request degrades to the nearest rung the model does accept.
 */
import { REASONING_EFFORT_LADDER } from './types.js';
import type { ModelReasoningProfile, ReasoningConfig, ReasoningEffort } from './types.js';

function rungOf(effort: ReasoningEffort): number {
  return REASONING_EFFORT_LADDER.indexOf(effort);
}

export interface ClampedReasoningEffort {
  effort: ReasoningEffort;
  /** The requested rung, present only when it differed from `effort`. */
  clampedFrom?: ReasoningEffort;
}

/**
 * Snap `requested` to the nearest rung in `supported`.
 *
 * Distance is measured on the ladder, and ties break **downward** — a caller
 * asking for less reasoning than the model offers is expressing a cost or
 * latency preference, so the cheaper neighbour honours the intent better than
 * the more expensive one. `off` on a model that always reasons therefore lands
 * on its lowest rung rather than its highest.
 */
export function clampReasoningEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ClampedReasoningEffort {
  if (supported.includes(requested)) return { effort: requested };

  const target = rungOf(requested);
  // Rank by distance, then by rung, so the result never depends on the order
  // the profile happened to list its rungs in.
  const nearest = [...supported].sort((a, b) => {
    const byDistance = Math.abs(rungOf(a) - target) - Math.abs(rungOf(b) - target);
    return byDistance !== 0 ? byDistance : rungOf(a) - rungOf(b);
  })[0];

  return nearest === undefined
    ? { effort: requested }
    : { effort: nearest, clampedFrom: requested };
}

export interface ResolvedReasoning {
  /** The config to hand the adapter, or undefined to leave the provider's default. */
  reasoning: ReasoningConfig | undefined;
  /** Set when the requested effort was not one the model accepts. */
  clampedFrom?: ReasoningEffort;
}

/**
 * Resolve a caller's reasoning request against a model's profile.
 *
 * A model with no profile is one the client treats as non-reasoning: it
 * receives no reasoning params at all, because passing thinking config to a
 * model that has none is itself a 400 on several providers.
 */
export function resolveReasoningForModel(
  requested: ReasoningConfig | undefined,
  profile: ModelReasoningProfile | undefined,
): ResolvedReasoning {
  if (!profile) return { reasoning: undefined };

  const asked = requested?.effort;
  if (asked === undefined) {
    return {
      reasoning: profile.default !== undefined ? { effort: profile.default } : undefined,
    };
  }

  const { effort, clampedFrom } = clampReasoningEffort(asked, profile.supported);
  return {
    reasoning: { ...requested, effort },
    ...(clampedFrom !== undefined ? { clampedFrom } : {}),
  };
}
