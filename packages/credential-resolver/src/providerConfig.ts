/**
 * The client configuration a resolved credential stands for — one reading,
 * shared by every process that builds an AI client from a credential, so the
 * executor and the API server cannot disagree about where a request goes.
 */
import type { ProviderConfig } from '@aflow/ai-client';
import { getProviderDefinition, getRequiredSecretFieldIds } from '@aflow/schemas';
import type { ResolvedProvider } from './types.js';

/**
 * A field the credential leaves unset takes the registry's default, so a
 * connection saved with nothing but its name (a local runtime) reaches the
 * runtime the registry describes.
 */
function configValue(
  providerId: string,
  resolved: ResolvedProvider,
  fieldId: string,
): string | undefined {
  const value = resolved.config[fieldId];
  if (value !== undefined && value !== '') return value;
  return getProviderDefinition(providerId)?.fields.find((f) => f.fieldId === fieldId)?.defaultValue;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function providerConfigFromCredential(
  providerId: string,
  resolved: ResolvedProvider,
): ProviderConfig {
  // Always set, empty when the credential carries none: an SDK handed no key
  // reads the platform's own from the environment, and a space's request must
  // never be paid for with it.
  const config: ProviderConfig = {
    apiKey: resolved.secrets['api_key'] || resolved.secrets['token'] || '',
  };
  const orgId = configValue(providerId, resolved, 'org_id');
  if (providerId === 'openai' && orgId) config.organization = orgId;
  const baseUrl = configValue(providerId, resolved, 'base_url');
  if (baseUrl) config.baseUrl = baseUrl;
  const contextTokens = positiveInteger(configValue(providerId, resolved, 'context_tokens'));
  if (contextTokens !== undefined) config.contextTokens = contextTokens;
  const keepAlive = configValue(providerId, resolved, 'keep_alive');
  if (keepAlive) config.keepAlive = keepAlive;
  return config;
}

/** The secrets a credential must carry and does not, as the registry declares them. */
export function missingRequiredSecrets(providerId: string, resolved: ResolvedProvider): string[] {
  return getRequiredSecretFieldIds(providerId).filter((fieldId) => !resolved.secrets[fieldId]);
}

/** How many requests at once a local runtime's connection admits (Plan 323 D7). */
export function localRuntimeSettings(
  providerId: string,
  resolved: ResolvedProvider,
): { maxParallel: number } {
  return { maxParallel: positiveInteger(configValue(providerId, resolved, 'max_parallel')) ?? 1 };
}
