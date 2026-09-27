'use client';

import { useMemo } from 'react';
import type {
  OAuthClientMeta,
  OAuthClientListResponse,
  OAuthClientCreateResponse,
  OAuthClientRotateSecretInput,
  OAuthClientRotateSecretResponse,
  OAuthClientDeleteResponse,
} from '@aflow/schemas';
import { useApiQuery, useApiMutation } from './useApiQuery.js';
import type {
  TenantOAuthClientCreateInput,
  RotateClientSecretInput,
} from './use-tenant-oauth-clients';

// ---------------------------------------------------------------------------
// Space OAuth Apps (Plan 185 §11, O3)
// ---------------------------------------------------------------------------
//
// Space-admin registration of space-scoped OAuth client apps (multi-org tenant /
// freemium BYO-app). Same write-only-secret + rotate posture as the tenant
// surface. Keyed under the `['space', spaceId]` invalidation handle.

/** Per-space clients — see CLAUDE.md Plan 161 query-key conventions. */
export function spaceOAuthClientsKey(spaceId: string) {
  return ['space', spaceId, 'integrations', 'oauth-clients'] as const;
}

export function useSpaceOAuthClients(spaceId: string) {
  const key = [...spaceOAuthClientsKey(spaceId)];

  const clientsQuery = useApiQuery<OAuthClientListResponse>({
    key,
    path: '/integrations/oauth-clients',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });

  const clients = useMemo<OAuthClientMeta[]>(
    () => clientsQuery.data?.clients ?? [],
    [clientsQuery.data],
  );

  const createClient = useApiMutation<TenantOAuthClientCreateInput, OAuthClientCreateResponse>({
    path: '/integrations/oauth-clients',
    method: 'POST',
    ...(spaceId ? { spaceId } : {}),
    invalidate: [key],
  });

  const rotateSecret = useApiMutation<RotateClientSecretInput, OAuthClientRotateSecretResponse>({
    path: (input) => `/integrations/oauth-clients/${encodeURIComponent(input.id)}/rotate-secret`,
    method: 'POST',
    serialize: (input) => JSON.stringify(input.body),
    ...(spaceId ? { spaceId } : {}),
    invalidate: [key],
  });

  const deleteClient = useApiMutation<{ id: string }, OAuthClientDeleteResponse>({
    path: (input) => `/integrations/oauth-clients/${encodeURIComponent(input.id)}`,
    method: 'DELETE',
    ...(spaceId ? { spaceId } : {}),
    invalidate: [key],
  });

  return {
    clients,
    isLoading: clientsQuery.isLoading,
    error: clientsQuery.error ?? null,
    refetch: () => {
      void clientsQuery.refetch();
    },
    createClient,
    rotateSecret,
    deleteClient,
  };
}

export type { OAuthClientRotateSecretInput };
