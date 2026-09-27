'use client';

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../components/providers.js';
import { useApiQuery } from './useApiQuery.js';

/** Operator-authored named check profile (commands run by the lane, never the agent). */
export interface RepoCheckProfile {
  name: string;
  commands: string[];
}

/**
 * A repo designation — the coding lane's space-scoped authority to clone + branch +
 * push ONE repo under a fixed branch policy. The repo is identified by its
 * host-qualified coordinate (`coordinate`, e.g. `github.com/owner/repo`); the clone
 * remote is derived from it. The git credential is referenced by name
 * (`credentialKey` → an `api_credentials` row in the same space); the token never
 * lives on the row. Mirrors `RepoBindingResponseSchema` in `@aflow/schemas` —
 * kept as a local DTO so this client module stays free of deep schema imports.
 */
export interface RepoBindingSummary {
  repoDesignationId: string;
  spaceId: string;
  coordinate: string;
  remoteUrl: string;
  description: string | null;
  defaultBranch: string;
  allowedPushBranchPatterns: string[];
  egressHosts: string[];
  checkProfiles: RepoCheckProfile[];
  /** The GitHub connection (`api_bindings.bindingId`) this repo resolves git + API through. */
  connectionBindingId: string;
  credentialKey: string | null;
  status: 'provisioning' | 'ready' | 'error' | 'archived';
  lastValidatedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRepoBindingInput {
  repo: string;
  description?: string;
  defaultBranch: string;
  allowedPushBranchPatterns: string[];
  checkProfiles?: RepoCheckProfile[];
  // XOR-ish (Plan 222 P3): link an existing GitHub connection, OR bootstrap one
  // from a named credential. At least one is required.
  connectionBindingId?: string;
  credentialKey?: string;
}

/** Pull a `{ error }` message off a non-2xx route reply, else a generic fallback. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data: unknown = await res.json().catch(() => null);
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === 'string' && e.length > 0) return e;
  }
  return fallback;
}

export function useRepoBindings(spaceId: string) {
  const { apiUrl, headers, authFetch } = useApi();
  const queryClient = useQueryClient();

  const listQuery = useApiQuery<{ repoBindings?: RepoBindingSummary[] }>({
    key: ['space', spaceId, 'integrations', 'repo-bindings'],
    path: '/integrations/repo-bindings',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });

  // Archived bindings are soft-deleted and can't drive a run, so the operator
  // surface only manages the live ones.
  const repoBindings = useMemo(
    () => (listQuery.data?.repoBindings ?? []).filter((b) => b.status !== 'archived'),
    [listQuery.data],
  );
  const isLoading = listQuery.isLoading;
  const error = listQuery.error?.message ?? null;

  const invalidate = useCallback((): void => {
    if (spaceId) {
      void queryClient.invalidateQueries({
        queryKey: ['space', spaceId, 'integrations', 'repo-bindings'],
      });
    }
  }, [queryClient, spaceId]);

  const saveRepoBinding = useCallback(
    async (body: SaveRepoBindingInput): Promise<void> => {
      const res = await authFetch(`${apiUrl}/integrations/repo-bindings`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Failed to save repository.'));
      invalidate();
    },
    [apiUrl, headers, authFetch, invalidate],
  );

  const archiveRepoBinding = useCallback(
    async (repoDesignationId: string): Promise<void> => {
      const res = await authFetch(
        `${apiUrl}/integrations/repo-bindings/${encodeURIComponent(repoDesignationId)}`,
        { method: 'DELETE', headers: headers() },
      );
      if (!res.ok) throw new Error(await errorMessage(res, 'Failed to remove repository.'));
      invalidate();
    },
    [apiUrl, headers, authFetch, invalidate],
  );

  return { repoBindings, isLoading, error, saveRepoBinding, archiveRepoBinding };
}
