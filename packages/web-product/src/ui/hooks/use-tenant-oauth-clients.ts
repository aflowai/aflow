'use client';

import { useMemo } from 'react';
import type {
  OAuthClientMeta,
  OAuthClientListResponse,
  OAuthClientCreateInput,
  OAuthClientCreateResponse,
  OAuthClientRotateSecretInput,
  OAuthClientRotateSecretResponse,
  OAuthClientDeleteResponse,
  TenantOAuthPolicy,
  TenantOAuthPolicyResponse,
  TenantOAuthPolicyUpdateInput,
} from '@aflow/schemas';
import { useApiQuery, useApiMutation } from './useApiQuery.js';

// ---------------------------------------------------------------------------
// Tenant OAuth Apps (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// Tenant-admin registration of OAuth client apps (the org's own client_id /
// client_secret) plus the per-tenant default policy (defaultOwnerScope,
// defaultClientScope, allowUserSelfConnect). The client_secret is WRITE-ONLY:
// it is never returned, only `hasSecret` reports its presence, and a Rotate
// action replaces it.

/** Tenant-scoped clients — see CLAUDE.md Plan 161 query-key conventions. */
export const TENANT_OAUTH_CLIENTS_KEY = ['tenant', 'oauth-clients'] as const;
/** Tenant-scoped policy. */
export const TENANT_OAUTH_POLICY_KEY = ['tenant', 'oauth-policy'] as const;

/** Create input minus the server-derived `scope`/`scopeId` (the route pins them). */
export type TenantOAuthClientCreateInput = Omit<OAuthClientCreateInput, 'scope' | 'scopeId'>;

export interface RotateClientSecretInput {
  id: string;
  body: OAuthClientRotateSecretInput;
}

/**
 * Policy-only read — the tenant OAuth default policy without the admin-gated
 * client list. Binding editors (granted via `api_config:write`, not tenant
 * admin) call this to seed the ownership-selector defaults; the now
 * non-admin `GET /tenant/oauth-policy` is the only request it makes. Use
 * `useTenantOAuthClients()` only on the tenant-admin OAuth Apps pages.
 */
export function useTenantOAuthPolicy() {
  const policyQuery = useApiQuery<TenantOAuthPolicyResponse>({
    key: [...TENANT_OAUTH_POLICY_KEY],
    path: '/tenant/oauth-policy',
    staleTime: 30_000,
  });

  const policy = useMemo<TenantOAuthPolicy | null>(
    () => policyQuery.data?.policy ?? null,
    [policyQuery.data],
  );

  return {
    policy,
    isLoading: policyQuery.isLoading,
    error: policyQuery.error ?? null,
    refetch: () => {
      void policyQuery.refetch();
    },
  };
}

export function useTenantOAuthClients() {
  const clientsQuery = useApiQuery<OAuthClientListResponse>({
    key: [...TENANT_OAUTH_CLIENTS_KEY],
    path: '/tenant/oauth-clients',
    staleTime: 30_000,
  });

  const policyQuery = useApiQuery<TenantOAuthPolicyResponse>({
    key: [...TENANT_OAUTH_POLICY_KEY],
    path: '/tenant/oauth-policy',
    staleTime: 30_000,
  });

  const clients = useMemo<OAuthClientMeta[]>(
    () => clientsQuery.data?.clients ?? [],
    [clientsQuery.data],
  );
  const policy = useMemo<TenantOAuthPolicy | null>(
    () => policyQuery.data?.policy ?? null,
    [policyQuery.data],
  );

  const createClient = useApiMutation<TenantOAuthClientCreateInput, OAuthClientCreateResponse>({
    path: '/tenant/oauth-clients',
    method: 'POST',
    invalidate: [[...TENANT_OAUTH_CLIENTS_KEY]],
  });

  const rotateSecret = useApiMutation<RotateClientSecretInput, OAuthClientRotateSecretResponse>({
    path: (input) => `/tenant/oauth-clients/${encodeURIComponent(input.id)}/rotate-secret`,
    method: 'POST',
    serialize: (input) => JSON.stringify(input.body),
    invalidate: [[...TENANT_OAUTH_CLIENTS_KEY]],
  });

  const deleteClient = useApiMutation<{ id: string }, OAuthClientDeleteResponse>({
    path: (input) => `/tenant/oauth-clients/${encodeURIComponent(input.id)}`,
    method: 'DELETE',
    invalidate: [[...TENANT_OAUTH_CLIENTS_KEY]],
  });

  const updatePolicy = useApiMutation<TenantOAuthPolicyUpdateInput, TenantOAuthPolicyResponse>({
    path: '/tenant/oauth-policy',
    method: 'PATCH',
    invalidate: [[...TENANT_OAUTH_POLICY_KEY]],
  });

  return {
    clients,
    policy,
    isLoading: clientsQuery.isLoading || policyQuery.isLoading,
    error: clientsQuery.error ?? policyQuery.error ?? null,
    refetch: () => {
      void clientsQuery.refetch();
      void policyQuery.refetch();
    },
    createClient,
    rotateSecret,
    deleteClient,
    updatePolicy,
  };
}
