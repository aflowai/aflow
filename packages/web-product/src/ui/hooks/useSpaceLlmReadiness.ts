'use client';

import { useApiQuery } from './useApiQuery.js';

export interface RoleReadiness {
  model: string;
  modelId: string | null;
  providerId: string | null;
  resolved: boolean;
  resolvedScope: 'user' | 'space' | 'tenant' | null;
  status: 'active' | 'error' | null;
  /** `null` where the provider offers no live check. */
  verified: boolean | null;
}

/**
 * What the Clerk resolves to. Kept out of `ready` on purpose: unnamed
 * conversations are a space with plain titles, not a space that cannot work.
 */
export interface ClerkReadiness {
  mode: 'auto' | 'space_default' | 'explicit';
  model: string | null;
  modelId: string | null;
  providerId: string | null;
  credentialResolved: boolean;
  unavailableReason: 'no_candidate_for_provider' | 'not_permitted' | 'unknown_model' | null;
}

export interface SpaceLlmReadiness {
  ready: boolean;
  roles: Record<string, RoleReadiness>;
  clerk: ClerkReadiness;
  missingProviders: Array<{ providerId: string; roles: string[] }>;
  erroredProviders: Array<{ providerId: string; roles: string[]; lastErrorCode: string | null }>;
  /**
   * Roles assigned a model the catalog no longer carries. No key resolves one,
   * so these are reported apart from the credential channels — the fix is to
   * pick another model.
   */
  unknownModelRoles: Array<{ role: string; model: string }>;
  /** Holding a key nothing has tried yet. Not counted against `ready`. */
  unverifiedProviders: Array<{ providerId: string; roles: string[] }>;
  /**
   * Whether any provider credential is visible here, for any provider — which
   * is whether setup has ever happened, not whether the workspace can run now.
   */
  hasConfiguredProvider: boolean;
}

/** Invalidate with this key after credential or model-defaults mutations. */
export function llmReadinessQueryKey(spaceId: string): readonly unknown[] {
  return ['space', spaceId, 'llm-readiness'] as const;
}

/**
 * Standing LLM readiness for a space, recomputed server-side at read for the
 * calling user (user-scoped credentials participate in resolution).
 */
export function useSpaceLlmReadiness(spaceId: string | null): {
  readiness: SpaceLlmReadiness | null;
  isLoading: boolean;
} {
  const q = useApiQuery<SpaceLlmReadiness>({
    key: spaceId ? [...llmReadinessQueryKey(spaceId)] : ['space', 'none', 'llm-readiness'],
    path: `/spaces/${spaceId}/llm-readiness`,
    staleTime: 30_000,
    enabled: spaceId !== null,
  });
  return { readiness: q.data ?? null, isLoading: q.isLoading };
}
