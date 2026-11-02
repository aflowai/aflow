'use client';

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BindingFulfillment, IconRef } from '@aflow/schemas';
import { useApi } from '../components/providers.js';
import { useApiQuery } from './useApiQuery.js';
import { apiErrorFromResponse } from '../lib/query-client.js';

export interface ApiBindingVariableMeta {
  name: string;
  description?: string;
  example?: string;
  required: boolean;
}

export interface ApiDefinitionSummary {
  apiId: string;
  name: string;
  description: string | null;
  baseUrl: string;
  baseUrlTemplate?: string;
  variables?: ApiBindingVariableMeta[];
  version: string;
  tags: string[];
  enabled: boolean;
  endpointCount: number;
  /** Store-listing branding, present only for an installed connector. */
  icon?: IconRef;
  createdAt: string;
  updatedAt: string;
}

export interface ApiBindingSummary {
  bindingId: string;
  apiId: string;
  name: string;
  description: string | null;
  scope: Record<string, unknown>;
  authType: string;
  auth: Record<string, unknown>;
  credentialKeys: string[];
  egressPolicy: Record<string, unknown>;
  variableValues?: Record<string, string>;
  fulfillment: BindingFulfillment;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationCredentialMeta {
  credentialKey: string;
  label: string;
  description: string | null;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEndpointParamDetail {
  name: string;
  location: 'path' | 'query' | 'header' | 'body';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface ApiEndpointDetail {
  endpointId: string;
  name: string;
  description?: string;
  method: string;
  pathTemplate: string;
  params?: ApiEndpointParamDetail[];
  bodyEncoding?: string;
  tags?: string[];
}

export interface SuggestedEgressPolicyDetail {
  allowCrossHostRedirects?: boolean;
  additionalHosts?: string[];
  allowedMethods?: string[];
  minResponseBodyBytes?: number;
  minTimeoutMs?: number;
}

export interface ApiDefinitionDetail {
  apiId: string;
  name: string;
  description?: string | null;
  baseUrl: string;
  baseUrlTemplate?: string;
  variables?: ApiBindingVariableMeta[];
  version: string;
  enabled?: boolean;
  endpoints: ApiEndpointDetail[];
  defaultHeaders?: Record<string, string>;
  suggestedEgressPolicy?: SuggestedEgressPolicyDetail;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function useIntegrations(spaceId: string) {
  // `authFetch` routes through the same 401 → login redirect that
  // useApiQuery's apiFetch uses. Plain `fetch` here would silently
  // fail on session expiry and leave the user staring at a broken
  // mutation — fix from Phase 2 review.
  const { apiUrl, headers, authFetch } = useApi();
  const queryClient = useQueryClient();

  const defsQuery = useApiQuery<{ definitions?: ApiDefinitionSummary[] }>({
    key: ['space', spaceId, 'integrations', 'definitions'],
    path: '/integrations/definitions',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
  const bindsQuery = useApiQuery<{ bindings?: ApiBindingSummary[] }>({
    key: ['space', spaceId, 'integrations', 'bindings'],
    path: '/integrations/bindings',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
  const credsQuery = useApiQuery<{ credentials?: IntegrationCredentialMeta[] }>({
    key: ['space', spaceId, 'integrations', 'credentials'],
    path: '/integrations/credentials',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });

  const definitions = useMemo(() => defsQuery.data?.definitions ?? [], [defsQuery.data]);
  const bindings = useMemo(() => bindsQuery.data?.bindings ?? [], [bindsQuery.data]);
  const credentials = useMemo(() => credsQuery.data?.credentials ?? [], [credsQuery.data]);
  const isLoading = defsQuery.isLoading || bindsQuery.isLoading || credsQuery.isLoading;
  const error =
    defsQuery.error?.message ?? bindsQuery.error?.message ?? credsQuery.error?.message ?? null;

  const invalidateAll = useCallback((): void => {
    if (spaceId) {
      void queryClient.invalidateQueries({
        queryKey: ['space', spaceId, 'integrations', 'definitions'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['space', spaceId, 'integrations', 'bindings'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['space', spaceId, 'integrations', 'credentials'],
      });
    }
  }, [queryClient, spaceId]);

  const refresh = useCallback(async (): Promise<void> => {
    // Imperative "force-now" refresh; resolves once all three refetches
    // settle. Most call sites won't need this — mutations invalidate
    // automatically — but the integrations page exposes a manual
    // refresh button and we preserve its UX.
    await Promise.all([defsQuery.refetch(), bindsQuery.refetch(), credsQuery.refetch()]);
  }, [defsQuery, bindsQuery, credsQuery]);

  const saveCredential = useCallback(
    async (credentialKey: string, value: string, label: string, description?: string) => {
      const res = await authFetch(
        `${apiUrl}/integrations/credentials/${encodeURIComponent(credentialKey)}`,
        {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ value, label, ...(description ? { description } : {}) }),
        },
      );
      if (!res.ok) throw new Error('Failed to save credential');
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  const deleteCredential = useCallback(
    async (credentialKey: string) => {
      const res = await authFetch(
        `${apiUrl}/integrations/credentials/${encodeURIComponent(credentialKey)}`,
        {
          method: 'DELETE',
          headers: headers(),
        },
      );
      if (!res.ok) throw new Error('Failed to delete credential');
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  const saveDefinition = useCallback(
    async (body: {
      apiId: string;
      name: string;
      description?: string;
      baseUrl?: string;
      baseUrlTemplate?: string;
      variables?: Array<{
        name: string;
        description: string;
        example?: string;
        required?: boolean;
      }>;
      version?: string;
      endpoints: Array<Record<string, unknown>>;
      defaultHeaders?: Record<string, string>;
      tags?: string[];
    }) => {
      const res = await authFetch(`${apiUrl}/integrations/definitions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await apiErrorFromResponse(res, 'Failed to save definition');
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  const getDefinitionDetail = useCallback(
    async (apiId: string): Promise<ApiDefinitionDetail> => {
      const res = await authFetch(
        `${apiUrl}/integrations/definitions/${encodeURIComponent(apiId)}`,
        {
          headers: headers(),
        },
      );
      if (!res.ok) throw new Error('Failed to load API definition');
      const data = (await res.json()) as { definition: ApiDefinitionDetail };
      return data.definition;
    },
    [apiUrl, headers, authFetch],
  );

  const deleteDefinition = useCallback(
    async (apiId: string) => {
      const res = await authFetch(
        `${apiUrl}/integrations/definitions/${encodeURIComponent(apiId)}`,
        {
          method: 'DELETE',
          headers: headers(),
        },
      );
      if (!res.ok) {
        // Surface the server message (e.g. the repo-cascade 409 guard) instead of
        // a generic failure, so the operator learns which repos still depend on it.
        const data: unknown = await res.json().catch(() => null);
        const message =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          typeof (data as { error: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Failed to delete definition';
        throw new Error(message);
      }
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  const deleteBinding = useCallback(
    async (bindingId: string) => {
      const res = await authFetch(
        `${apiUrl}/integrations/bindings/${encodeURIComponent(bindingId)}`,
        {
          method: 'DELETE',
          headers: headers(),
        },
      );
      if (!res.ok) {
        // Surface the server message (e.g. the repo-cascade 409 guard) so the
        // operator learns which repos still resolve through this connection.
        const data: unknown = await res.json().catch(() => null);
        const message =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          typeof (data as { error: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Failed to delete binding';
        throw new Error(message);
      }
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  const saveBinding = useCallback(
    async (body: {
      bindingId: string;
      apiId: string;
      name: string;
      description?: string;
      scope: { flowId?: string | undefined };
      auth: Record<string, unknown>;
      egressPolicy: Record<string, unknown>;
      variableValues?: Record<string, string>;
      enabled?: boolean;
      // Create-intent: the server 409s instead of upserting if the id is taken.
      expectAbsent?: boolean;
    }) => {
      const res = await authFetch(`${apiUrl}/integrations/bindings`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await apiErrorFromResponse(res, 'Failed to save binding');
      invalidateAll();
    },
    [apiUrl, headers, authFetch, invalidateAll],
  );

  return {
    definitions,
    bindings,
    credentials,
    isLoading,
    error,
    refresh,
    saveCredential,
    deleteCredential,
    saveDefinition,
    deleteDefinition,
    getDefinitionDetail,
    saveBinding,
    deleteBinding,
  };
}
