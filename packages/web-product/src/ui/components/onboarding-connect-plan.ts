import { AGENT_MODEL_PROVIDER_IDS, type AgentModelProviderId } from '@aflow/schemas';
import type { SpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';

/** Where onboarding goes once the model step has saved. */
export type AfterModelStep =
  | { step: 'connect'; providers: AgentModelProviderId[] }
  | { step: 'ready'; keysConnected: boolean };

const KEY_PROVIDERS: ReadonlySet<string> = new Set(AGENT_MODEL_PROVIDER_IDS);

function isKeyProvider(providerId: string): providerId is AgentModelProviderId {
  return KEY_PROVIDERS.has(providerId);
}

/**
 * The step after the model step, decided by the space's readiness as saved.
 *
 * The selection alone cannot say which keys a space needs. It names providers
 * only for recommended models, so a space still holding one the
 * recommendation dropped (`glm-pro`) reads as needing none, as a model on
 * this computer does. Readiness resolves every role's model through the
 * catalog, so its missing, failed and untried keys go to the connect step too.
 *
 * Keys count as connected only where the space can run: `ready`, with no key
 * left untried. That is the condition the setup gate reopens on, so anything
 * weaker sends the operator back into this flow on the reload that ends it.
 * Unread readiness is not a runnable space.
 */
export function planAfterModelStep(
  selectionProviders: readonly AgentModelProviderId[],
  readiness: SpaceLlmReadiness | null,
): AfterModelStep {
  const unservedProviders = readiness
    ? [
        ...readiness.missingProviders,
        ...readiness.erroredProviders,
        ...readiness.unverifiedProviders,
      ].map((p) => p.providerId)
    : [];
  const providers = [...new Set([...selectionProviders, ...unservedProviders])].filter(
    isKeyProvider,
  );
  if (providers.length > 0) return { step: 'connect', providers };
  const runnable = readiness?.ready === true && readiness.unverifiedProviders.length === 0;
  return { step: 'ready', keysConnected: runnable };
}
