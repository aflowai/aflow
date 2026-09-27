'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../components/providers.js';

// ---------------------------------------------------------------------------
// Types (mirroring Zod schemas from @aflow/schemas)
// ---------------------------------------------------------------------------

export interface ProviderDefinition {
  providerId: string;
  category: string;
  displayName: string;
  description: string;
  iconName: string;
  docsUrl?: string;
  fields: CredentialField[];
}

export interface CredentialField {
  fieldId: string;
  label: string;
  type: 'secret' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  helpText?: string;
  defaultValue?: string;
}

export interface CredentialMeta {
  id: string;
  providerId: string;
  scope: 'user' | 'space' | 'tenant';
  scopeId: string;
  label: string | null;
  configJson: Record<string, unknown>;
  hasSecrets: boolean;
  status: 'active' | 'error';
  lastValidatedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialStatus {
  providerId: string;
  resolved: boolean;
  resolvedScope: 'user' | 'space' | 'tenant' | null;
  status: 'active' | 'error' | null;
  lastErrorCode: string | null;
  availableScopes: Array<{
    scope: 'user' | 'space' | 'tenant';
    scopeId: string;
    status: 'active' | 'error';
  }>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCredentials() {
  const { apiUrl, headers } = useApi();
  const queryClient = useQueryClient();
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [statuses, setStatuses] = useState<Map<string, CredentialStatus>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch all visible credentials ──────────────────────────────────────

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/credentials`, { headers: headers() });
      if (!res.ok) throw new Error(`Failed to load credentials: ${res.statusText}`);
      const json = (await res.json()) as { credentials: CredentialMeta[] };
      setCredentials(json.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    }
  }, [apiUrl, headers]);

  // ── Fetch resolution status for all providers ──────────────────────────

  const fetchStatuses = useCallback(
    async (providerList: ProviderDefinition[]) => {
      const newStatuses = new Map<string, CredentialStatus>();
      await Promise.all(
        providerList.map(async (p) => {
          try {
            const res = await fetch(`${apiUrl}/credentials/status?providerId=${p.providerId}`, {
              headers: headers(),
            });
            if (res.ok) {
              const status = (await res.json()) as CredentialStatus;
              newStatuses.set(p.providerId, status);
            }
          } catch {
            // Ignore individual status fetch failures
          }
        }),
      );
      setStatuses(newStatuses);
    },
    [apiUrl, headers],
  );

  // ── Initial load (single pass: providers → credentials + statuses) ────

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Fetch providers first (static registry, rarely changes)
      const provRes = await fetch(`${apiUrl}/credentials/providers`, { headers: headers() });
      if (!provRes.ok) throw new Error(`Failed to load providers: ${provRes.statusText}`);
      const provJson = (await provRes.json()) as { providers: ProviderDefinition[] };
      setProviders(provJson.providers);

      // Fetch credentials and statuses in parallel
      const [credRes] = await Promise.all([
        fetch(`${apiUrl}/credentials`, { headers: headers() }),
        fetchStatuses(provJson.providers),
      ]);
      if (credRes.ok) {
        const credJson = (await credRes.json()) as { credentials: CredentialMeta[] };
        setCredentials(credJson.credentials);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers, fetchStatuses]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Mutations ──────────────────────────────────────────────────────────

  // Credential changes move llm-readiness for every space the user can see;
  // the hook has no spaceId, so invalidate the readiness key across spaces.
  const invalidateReadiness = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'space' && q.queryKey[2] === 'llm-readiness',
    });
  }, [queryClient]);

  const saveCredential = useCallback(
    async (
      providerId: string,
      scope: 'user' | 'space' | 'tenant',
      secrets: Record<string, string>,
      config?: Record<string, string>,
      label?: string,
    ): Promise<CredentialMeta | null> => {
      try {
        setError(null);
        const res = await fetch(`${apiUrl}/credentials/${providerId}`, {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ scope, secrets, config, label }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? res.statusText);
        }
        const created = (await res.json()) as CredentialMeta;
        await fetchCredentials();
        await fetchStatuses(providers);
        invalidateReadiness();
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save credential');
        return null;
      }
    },
    [apiUrl, headers, fetchCredentials, fetchStatuses, providers, invalidateReadiness],
  );

  const updateConfig = useCallback(
    async (
      providerId: string,
      scope: 'user' | 'space' | 'tenant',
      config: Record<string, string>,
      label?: string,
    ): Promise<CredentialMeta | null> => {
      try {
        setError(null);
        const res = await fetch(`${apiUrl}/credentials/${providerId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ scope, config, label }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? res.statusText);
        }
        const updated = (await res.json()) as CredentialMeta;
        await fetchCredentials();
        return updated;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update credential');
        return null;
      }
    },
    [apiUrl, headers, fetchCredentials],
  );

  const validateCredential = useCallback(
    async (
      providerId: string,
      scope: 'user' | 'space' | 'tenant',
    ): Promise<{ verified: boolean; errorCode: string | null; message: string | null } | null> => {
      try {
        setError(null);
        const res = await fetch(`${apiUrl}/credentials/${providerId}/validate`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ scope }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string; message?: string };
          throw new Error(err.message ?? err.error ?? res.statusText);
        }
        const outcome = (await res.json()) as {
          verified: boolean;
          errorCode: string | null;
          message: string | null;
        };
        await fetchCredentials();
        await fetchStatuses(providers);
        invalidateReadiness();
        return outcome;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to verify credential');
        return null;
      }
    },
    [apiUrl, headers, fetchCredentials, fetchStatuses, providers, invalidateReadiness],
  );

  const deleteCredential = useCallback(
    async (providerId: string, scope: 'user' | 'space' | 'tenant'): Promise<boolean> => {
      try {
        setError(null);
        const res = await fetch(`${apiUrl}/credentials/${providerId}?scope=${scope}`, {
          method: 'DELETE',
          headers: headers(),
        });
        if (!res.ok && res.status !== 204) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? res.statusText);
        }
        await fetchCredentials();
        await fetchStatuses(providers);
        invalidateReadiness();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete credential');
        return false;
      }
    },
    [apiUrl, headers, fetchCredentials, fetchStatuses, providers, invalidateReadiness],
  );

  return {
    providers,
    credentials,
    statuses,
    isLoading,
    error,
    refresh,
    saveCredential,
    updateConfig,
    deleteCredential,
    validateCredential,
  };
}
