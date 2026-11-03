import { AGENT_MODEL_PROVIDER_IDS, type AgentModelProviderId } from '@aflow/schemas';
import type { SpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';

/**
 * What holds for the space when onboarding reaches the ready step, so the step
 * says that and not something else. Only `no_key` is a key the operator has
 * not connected. The others are fixed elsewhere, or not known.
 */
export type ReadyStanding =
  /** Readiness is ready, with no key left untried. */
  | { kind: 'runnable' }
  /** The operator skipped the connect step. */
  | { kind: 'no_key' }
  /** Roles hold a model the catalog no longer carries. Another model fixes it, a key does not. */
  | { kind: 'unknown_models'; roles: Array<{ role: string; model: string }> }
  /** The runtime on this computer cannot serve a role. Its own page fixes it. */
  | { kind: 'local_runtime'; message: string }
  /** Not ready for a reason readiness does not name. */
  | { kind: 'not_ready' }
  /** Readiness could not be read. */
  | { kind: 'unread' };

/** Where onboarding goes once the model step has saved. */
export type AfterModelStep =
  | { step: 'connect'; providers: AgentModelProviderId[] }
  | { step: 'ready'; standing: ReadyStanding };

const KEY_PROVIDERS: ReadonlySet<string> = new Set(AGENT_MODEL_PROVIDER_IDS);

function isKeyProvider(providerId: string): providerId is AgentModelProviderId {
  return KEY_PROVIDERS.has(providerId);
}

/**
 * Why a space with no key left to connect still cannot run. A model the
 * catalog dropped is named first, as the composer's banner names it: a fix on
 * the runtime does nothing for it.
 */
function standingWithoutKeys(readiness: SpaceLlmReadiness): ReadyStanding {
  if (readiness.unknownModelRoles.length > 0) {
    return { kind: 'unknown_models', roles: readiness.unknownModelRoles };
  }
  const localError = readiness.localIssues.find((issue) => issue.severity === 'error');
  if (localError) {
    const remedy =
      localError.remedy.kind === 'instruction'
        ? localError.remedy.text
        : `${localError.remedy.label} on This Computer.`;
    return { kind: 'local_runtime', message: `${localError.cause} ${remedy}` };
  }
  if (readiness.missingProviders.some((p) => !isKeyProvider(p.providerId))) {
    return {
      kind: 'local_runtime',
      message: 'Nothing connects this workspace to the models on this computer yet.',
    };
  }
  if (readiness.ready && readiness.unverifiedProviders.length === 0) return { kind: 'runnable' };
  return { kind: 'not_ready' };
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
 * The space counts as runnable only where it can run: `ready`, with no key
 * left untried. That is the condition the setup gate reopens on, so anything
 * weaker sends the operator back into this flow on the reload that ends it.
 * A space no key can fix, or one whose readiness is unread, reaches the ready
 * step with the reason that holds, never as a missing key.
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
  if (!readiness) return { step: 'ready', standing: { kind: 'unread' } };
  return { step: 'ready', standing: standingWithoutKeys(readiness) };
}

/** What the ready step says about a space that cannot run yet, and where the operator fixes it. */
export interface ReadyNote {
  text: string;
  action: 'choose_model' | 'open_computer' | null;
}

const ASK_IN_CHAT = 'your workspace will say what it needs when you start chatting.';

/**
 * The ready step's note for a standing. A missing key is named only where a
 * key was skipped: a dropped model or the runtime on this computer has another
 * fix, and the note offers that one.
 */
export function readyNote(standing: ReadyStanding): ReadyNote | null {
  switch (standing.kind) {
    case 'runnable':
      return null;
    case 'no_key':
      return {
        text: 'No key connected yet — your workspace will guide you when you start chatting.',
        action: null,
      };
    case 'unknown_models': {
      const models = [...new Set(standing.roles.map((entry) => entry.model))];
      const roles = standing.roles.map((entry) => entry.role).join(', ');
      const subject =
        models.length === 1 ? `The model ${models[0]} is` : `The models ${models.join(', ')} are`;
      return {
        text: `${subject} no longer available. Choose another model for ${roles} before your agents can run.`,
        action: 'choose_model',
      };
    }
    case 'local_runtime':
      return { text: standing.message, action: 'open_computer' };
    case 'not_ready':
      return { text: `Your agents cannot run yet — ${ASK_IN_CHAT}`, action: null };
    case 'unread':
      return { text: `Could not check whether your agents can run — ${ASK_IN_CHAT}`, action: null };
  }
}
