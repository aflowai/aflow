/**
 * The client configuration a resolved credential stands for — one reading,
 * shared by every process that builds an AI client from a credential, so the
 * executor and the API server cannot disagree about where a request goes.
 */
import type { LocalMachine, ProviderConfig } from '@aflow/ai-client';
import {
  getProviderDefinition,
  getRequiredSecretFieldIds,
  localRuntimeId,
  THIS_MACHINE_RUNTIME_HOST,
} from '@aflow/schemas';
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

/**
 * The machine a local runtime's models run on (Plan 323 D8). A GPU memory
 * figure on the connection is the operator's word for a runtime on another
 * machine, and wins. Otherwise only a runtime on this machine is described by
 * this machine's inventory; one elsewhere is unknown, and its windows fall
 * back to the conservative default rather than being sized for the wrong box.
 */
export function localMachineFor(input: {
  config: Readonly<Record<string, string>> | null | undefined;
  inventoryMachine: LocalMachine | undefined;
}): LocalMachine | undefined {
  const configuredGb = Number(input.config?.['gpu_memory_gb']);
  if (Number.isFinite(configuredGb) && configuredGb > 0) {
    const bytes = Math.round(configuredGb * 1e9);
    return { totalMemoryBytes: bytes, gpuWorkingSetBytes: bytes, unifiedMemory: false };
  }
  return localRuntimeId(input.config?.['base_url']).startsWith(`${THIS_MACHINE_RUNTIME_HOST}:`)
    ? input.inventoryMachine
    : undefined;
}

export function providerConfigFromCredential(
  providerId: string,
  resolved: ResolvedProvider,
  local: { machine?: LocalMachine | undefined } = {},
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
  const parallel = positiveInteger(configValue(providerId, resolved, 'max_parallel'));
  if (parallel !== undefined) config.parallel = parallel;
  const machine = localMachineFor({ config: resolved.config, inventoryMachine: local.machine });
  if (machine) config.machine = machine;
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
