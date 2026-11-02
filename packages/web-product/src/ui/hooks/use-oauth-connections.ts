'use client';

import { useMemo } from 'react';
import type { OAuthConnection } from '@aflow/schemas';
import { useApiQuery, useApiMutation } from './useApiQuery.js';

// ---------------------------------------------------------------------------
// Per-user "Connected accounts" (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// The first per-user TanStack key in the app. A connection is one `oauth_tokens`
// row the signed-in user owns (owner_scope='user'); connect-once means a single
// entry per (integrationKind, resourceKey) across every binding/space that
// replays it. Tokens are never returned — only label, granted scopes, expiry,
// and a connected/expired status.

/** Tenant-scoped, per-user — see CLAUDE.md Plan 161 query-key conventions. */
export const OAUTH_CONNECTIONS_KEY = ['users', 'me', 'oauth-connections'] as const;

export interface DisconnectInput {
  integrationKind: OAuthConnection['integrationKind'];
  resourceKey: string;
}

export function useOAuthConnections() {
  const query = useApiQuery<{ connections: OAuthConnection[] }>({
    key: [...OAUTH_CONNECTIONS_KEY],
    path: '/users/me/oauth-connections',
    staleTime: 30_000,
  });

  const connections = useMemo(() => query.data?.connections ?? [], [query.data]);

  const disconnect = useApiMutation<DisconnectInput, { deleted: boolean }>({
    path: (input) =>
      `/users/me/oauth-connections/${encodeURIComponent(input.integrationKind)}/${encodeURIComponent(
        input.resourceKey,
      )}`,
    method: 'DELETE',
    invalidate: [[...OAUTH_CONNECTIONS_KEY]],
  });

  return {
    connections,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    disconnect,
  };
}
