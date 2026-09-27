'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  IntegrationHostRequest,
  IntegrationPolicyMode,
  StoreCatalogListing,
  StoreListingAvailability,
  TenantIntegrationAllowlistCreate,
  TenantIntegrationAllowlistEntry,
  TenantStoreOverride,
} from '@aflow/schemas';
import { useApiMutation, useApiQuery } from './useApiQuery.js';
import type { ApiError } from '../lib/query-client.js';

export type { StoreCatalogListing };

const POLICY_KEY = ['tenant', 'integration-policy'];
const ALLOWLIST_KEY = ['tenant', 'integration-allowlist'];
const REQUESTS_KEY = ['tenant', 'integration-host-requests'];
const STORE_POLICY_KEY = ['tenant', 'store-policy'];
const OVERRIDES_KEY = ['tenant', 'store-overrides'];
const AGENT_MODELS_KEY = ['tenant', 'agent-models'];

export function useIntegrationPolicy(): UseQueryResult<{ mode: IntegrationPolicyMode }, ApiError> {
  return useApiQuery({ key: POLICY_KEY, path: '/tenant/integration-policy' });
}

export function useSetIntegrationPolicy(): UseMutationResult<
  { mode: IntegrationPolicyMode },
  ApiError,
  { mode: IntegrationPolicyMode }
> {
  return useApiMutation({
    path: '/tenant/integration-policy',
    method: 'PUT',
    invalidate: [POLICY_KEY],
  });
}

export function useIntegrationAllowlist(): UseQueryResult<
  { entries: TenantIntegrationAllowlistEntry[] },
  ApiError
> {
  return useApiQuery({ key: ALLOWLIST_KEY, path: '/tenant/integration-allowlist' });
}

export function useAddAllowlistHost(): UseMutationResult<
  TenantIntegrationAllowlistEntry,
  ApiError,
  TenantIntegrationAllowlistCreate
> {
  return useApiMutation({
    path: '/tenant/integration-allowlist',
    invalidate: [ALLOWLIST_KEY],
  });
}

export function useRemoveAllowlistHost(): UseMutationResult<
  { id: string; deleted: true },
  ApiError,
  { id: string }
> {
  return useApiMutation({
    path: (input) => `/tenant/integration-allowlist/${encodeURIComponent(input.id)}`,
    method: 'DELETE',
    invalidate: [ALLOWLIST_KEY],
  });
}

export function useIntegrationHostRequests(): UseQueryResult<
  { requests: IntegrationHostRequest[] },
  ApiError
> {
  return useApiQuery({ key: REQUESTS_KEY, path: '/tenant/integration-host-requests' });
}

export function useResolveIntegrationHostRequest(): UseMutationResult<
  IntegrationHostRequest,
  ApiError,
  { requestId: string; status: 'approved' | 'rejected'; note?: string }
> {
  return useApiMutation({
    path: (input) => `/tenant/integration-host-requests/${input.requestId}`,
    method: 'PATCH',
    serialize: (input) =>
      JSON.stringify({ status: input.status, ...(input.note ? { note: input.note } : {}) }),
    invalidate: [REQUESTS_KEY, ALLOWLIST_KEY],
  });
}

export function useStorePolicy(): UseQueryResult<
  { defaultAvailability: StoreListingAvailability },
  ApiError
> {
  return useApiQuery({ key: STORE_POLICY_KEY, path: '/tenant/store-policy' });
}

export function useSetStorePolicy(): UseMutationResult<
  { defaultAvailability: StoreListingAvailability },
  ApiError,
  { defaultAvailability: StoreListingAvailability }
> {
  return useApiMutation({
    path: '/tenant/store-policy',
    method: 'PUT',
    invalidate: [STORE_POLICY_KEY],
  });
}

export function useStoreOverrides(): UseQueryResult<
  { overrides: TenantStoreOverride[] },
  ApiError
> {
  return useApiQuery({ key: OVERRIDES_KEY, path: '/tenant/store-overrides' });
}

export function useSetStoreOverride(): UseMutationResult<
  TenantStoreOverride,
  ApiError,
  TenantStoreOverride
> {
  return useApiMutation({
    path: '/tenant/store-overrides',
    method: 'PUT',
    invalidate: [OVERRIDES_KEY],
  });
}

export function useRemoveStoreOverride(): UseMutationResult<
  { catalogId: string; deleted: true },
  ApiError,
  { catalogId: string }
> {
  return useApiMutation({
    path: (input) => `/tenant/store-overrides/${encodeURIComponent(input.catalogId)}`,
    method: 'DELETE',
    invalidate: [OVERRIDES_KEY],
  });
}

export function useAdminStoreCatalog(): UseQueryResult<
  { listings: StoreCatalogListing[] },
  ApiError
> {
  return useApiQuery({
    key: ['tenant', 'store-catalog'],
    path: '/tenant/store-catalog',
    staleTime: 60_000,
  });
}

/**
 * Models this tenant lets a space assign to a cybernetic role.
 *
 * `source: 'platform'` means no admin has chosen, so the set tracks the
 * platform recommendations as they move.
 */
export interface AgentModelPolicy {
  modelIds: string[];
  source: 'tenant' | 'platform';
}

export function useAgentModelPolicy(): UseQueryResult<AgentModelPolicy, ApiError> {
  return useApiQuery({
    key: AGENT_MODELS_KEY,
    path: '/tenant/agent-models',
    staleTime: 60_000,
  });
}

export function useSetAgentModelPolicy(): UseMutationResult<
  AgentModelPolicy,
  ApiError,
  { modelIds: string[] | null }
> {
  const queryClient = useQueryClient();
  return useApiMutation({
    path: '/tenant/agent-models',
    method: 'PUT',
    // Every role picker reads this set, so a change has to invalidate them too
    // or a just-enabled model stays missing from the dropdown that needed it.
    invalidate: [AGENT_MODELS_KEY, ['catalog']],
    // Seed the cache from the response the server just returned. Invalidation
    // is not awaited, so a second edit computed from the pre-write cache would
    // resend the old set and quietly undo the first.
    onSuccess: (data: AgentModelPolicy) => {
      queryClient.setQueryData(AGENT_MODELS_KEY, data);
    },
  });
}
