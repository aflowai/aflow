/**
 * Curated agent-model allowlist (Plan 227 D2 — the single registry every
 * agent-role surface derives from; a contract test in @aflow/ai-client pins
 * each entry to a live, non-deprecated catalog model). Operation-level model
 * inputs are deliberately NOT restricted by this list.
 *
 * This is the platform recommendation, not a ceiling: a tenant admin can name
 * its own set, and `effectiveAgentModelRefs` is what every gate actually reads.
 */
import { z } from 'zod';

export const AGENT_MODEL_PROVIDER_IDS = [
  'anthropic',
  'google',
  'openai',
  'fireworks',
  'xai',
] as const;
export type AgentModelProviderId = (typeof AGENT_MODEL_PROVIDER_IDS)[number];

export interface RecommendedAgentModel {
  readonly modelId: string;
  readonly alias?: string;
  readonly credentialProviderId: AgentModelProviderId;
  readonly label: string;
  readonly tagline: string;
  readonly recommended?: boolean;
}

export const RECOMMENDED_AGENT_MODELS: readonly RecommendedAgentModel[] = [
  {
    modelId: 'accounts/fireworks/models/glm-5p3',
    alias: 'glm-pro',
    credentialProviderId: 'fireworks',
    label: 'GLM-5.3',
    tagline: 'Best value — near-frontier quality at a fraction of the cost',
    recommended: true,
  },
  {
    modelId: 'claude-sonnet-5',
    alias: 'sonnet',
    credentialProviderId: 'anthropic',
    label: 'Claude Sonnet 5',
    tagline: 'Excellent coding and analysis with dependable tool use',
  },
  {
    modelId: 'gemini-3.1-pro-preview',
    alias: 'pro',
    credentialProviderId: 'google',
    label: 'Gemini Pro 3.1',
    tagline: 'Deep multimodal reasoning with a 1M-token context',
  },
  {
    modelId: 'gpt-5.6-terra',
    alias: 'gpt',
    credentialProviderId: 'openai',
    label: 'GPT-5.6 Terra',
    tagline: 'Flagship-grade quality at a mid-range price',
  },
  {
    modelId: 'accounts/fireworks/models/kimi-k3',
    alias: 'kimi-pro',
    credentialProviderId: 'fireworks',
    label: 'Kimi K3',
    tagline: 'Open 2.8T-class flagship — native vision and 1M context',
  },
  {
    modelId: 'grok-4.7',
    alias: 'grok',
    credentialProviderId: 'xai',
    label: 'Grok 4.7',
    tagline: 'Flagship reasoning and vision with a 500k context',
  },
];

const acceptedRefs = new Set(
  RECOMMENDED_AGENT_MODELS.flatMap((m) => (m.alias ? [m.modelId, m.alias] : [m.modelId])),
);

export function isRecommendedAgentModelRef(value: string): boolean {
  return acceptedRefs.has(value);
}

export function recommendedAgentModelRefs(): readonly string[] {
  return [...acceptedRefs];
}

/**
 * A tenant's chosen set of model refs a space may assign to a cybernetic role.
 *
 * `null` is not the same as `[]`: null means the tenant never chose and follows
 * the platform's recommendations as they move, where an empty array would be a
 * deliberate choice to allow nothing. Only the first is expressible as a stored
 * value, because a tenant that allows no models has no working agent.
 */
export const TenantAgentModelAllowlistSchema = z.array(z.string().min(1)).min(1).max(64);
export type TenantAgentModelAllowlist = z.infer<typeof TenantAgentModelAllowlistSchema>;

/**
 * The refs a space may assign, given whatever the tenant stored.
 *
 * Every caller that gates a model choice reads this, so widening a tenant's set
 * cannot take effect on one surface and not another.
 */
export function effectiveAgentModelRefs(
  stored: readonly string[] | null | undefined,
): readonly string[] {
  return stored && stored.length > 0 ? stored : recommendedAgentModelRefs();
}

/** Whether a space may assign this ref under the tenant's current set. */
export function isAllowedAgentModelRef(
  value: string,
  stored: readonly string[] | null | undefined,
): boolean {
  return effectiveAgentModelRefs(stored).includes(value);
}

export function agentModelForRef(value: string): RecommendedAgentModel | undefined {
  return RECOMMENDED_AGENT_MODELS.find((m) => m.modelId === value || m.alias === value);
}

// ============================================================================
// Clerk candidates — the economical tier for bounded background language work
// ============================================================================

/**
 * The curated small model for each provider, best first.
 *
 * Deliberately a short ordered list per provider rather than "whichever entry
 * is cheapest": price alone picks the model that cannot hold a sentence in
 * Turkish, and a name suffix picks whatever the vendor last called small.
 * Every ref here is a catalog model with structured-output support, which the
 * generation contract requires — a contract test in `@aflow/ai-client` pins
 * each one to a live catalog entry and fails if that stops being true.
 *
 * Ordering within a provider is quality-first among models that all sit in the
 * economy tier, so a second entry is a fallback for when the first is not in
 * the tenant's permitted set — never a cheaper-at-any-cost downgrade.
 */
export const CLERK_MODEL_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  fireworks: ['glm-flash'],
  anthropic: ['haiku'],
  google: ['flash-lite', 'flash'],
  openai: ['gpt-mini'],
  openrouter: ['deepseek-flash'],
};

/**
 * The curated candidates for one provider, in preference order.
 *
 * Deliberately NOT narrowed by a tenant allowlist here. Narrowing means
 * comparing two refs for the same model, and the same model reaches these
 * gates spelled both ways — this list names `glm-flash` while an allowlist
 * stores `accounts/fireworks/models/glm-5p3-flash`. Only the catalog can say
 * those are one model, and this package cannot reach it (the catalog depends
 * on this one). Comparing the strings as given silently refuses a model the
 * tenant had in fact permitted, which is exactly what it did.
 *
 * The intersection therefore happens where the catalog is: `resolveClerkModel`
 * in `@aflow/cybernetic-runtime` server-side, and the catalog-backed option
 * list client-side.
 */
export function clerkCandidateRefs(providerId: string): readonly string[] {
  return CLERK_MODEL_CANDIDATES[providerId] ?? [];
}
