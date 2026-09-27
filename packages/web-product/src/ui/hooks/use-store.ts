'use client';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  CatalogEntryEnvelope,
  IntegrationSourceKind,
  ListingRequirements,
  StoreInstallDivergence,
  StoreInstallPreviewResponse,
  StoreInstallResponse,
  StoreInstallState,
  StoreUninstallPreviewResponse,
  StoreUninstallResponse,
  StoreUpdateMode,
  StoreUpdatePreviewResponse,
  StoreUpdateResponse,
} from '@aflow/schemas';
import { StoreInstallDivergenceSchema } from '@aflow/schemas';
import { useApiMutation, useApiQuery } from './useApiQuery.js';
import type { ApiError } from '../lib/query-client.js';

export interface ListingInstalledState {
  installed: boolean;
  installedVersion?: number;
  updateAvailable: boolean;
  state?: StoreInstallState;
}

export type StoreListingSummary = CatalogEntryEnvelope & {
  sourceKind?: IntegrationSourceKind;
  installedState: ListingInstalledState;
  requirements: ListingRequirements;
};

export interface StoreListingDetail {
  entry: CatalogEntryEnvelope & { sourceKind?: IntegrationSourceKind; payload: unknown };
  installedState: ListingInstalledState;
  requirements: ListingRequirements;
}

export type ListingDisplayState = 'not_installed' | 'installed' | 'update_available';

export function listingDisplayState(state: ListingInstalledState): ListingDisplayState {
  if (!state.installed) return 'not_installed';
  return state.updateAvailable ? 'update_available' : 'installed';
}

export interface StoreListingFilters {
  kind?: 'bundle' | 'connector' | 'applet';
  q?: string;
}

export function useStoreListings(
  spaceId: string,
  filters: StoreListingFilters = {},
): UseQueryResult<{ listings: StoreListingSummary[] }, ApiError> {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return useApiQuery<{ listings: StoreListingSummary[] }>({
    key: ['space', spaceId, 'store', 'listings', filters.kind ?? 'all', filters.q ?? ''],
    path: `/store/listings${qs ? `?${qs}` : ''}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}

export function useStoreListing(
  spaceId: string,
  catalogId: string,
): UseQueryResult<StoreListingDetail, ApiError> {
  return useApiQuery<StoreListingDetail>({
    key: ['space', spaceId, 'store', 'listing', catalogId],
    path: `/store/listings/${encodeURIComponent(catalogId)}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId && !!catalogId,
    staleTime: 30_000,
  });
}

export function useStoreInstallPreview(
  spaceId: string,
): UseMutationResult<StoreInstallPreviewResponse, ApiError, { catalogId: string }> {
  return useApiMutation<{ catalogId: string }, StoreInstallPreviewResponse>({
    path: `/spaces/${spaceId}/store/install-preview`,
    ...(spaceId ? { spaceId } : {}),
  });
}

export interface StoreInstallInput {
  catalogId: string;
  expectedVersion: number;
  /** Generated once per install attempt (crypto.randomUUID) and reused on retries of that attempt. */
  idempotencyKey: string;
}

export function useStoreInstall(
  spaceId: string,
): UseMutationResult<StoreInstallResponse, ApiError, StoreInstallInput> {
  return useApiMutation<StoreInstallInput, StoreInstallResponse>({
    path: `/spaces/${spaceId}/store/install`,
    ...(spaceId ? { spaceId } : {}),
    invalidate: [
      ['space', spaceId, 'store'],
      ['space', spaceId, 'workflows'],
      ['space', spaceId, 'workflow'],
      ['space', spaceId, 'integrations'],
      ['space', spaceId, 'capabilities'],
    ],
  });
}

export function useStoreUpdatePreview(
  spaceId: string,
): UseMutationResult<StoreUpdatePreviewResponse, ApiError, { catalogId: string }> {
  return useApiMutation<{ catalogId: string }, StoreUpdatePreviewResponse>({
    path: `/spaces/${spaceId}/store/update-preview`,
    ...(spaceId ? { spaceId } : {}),
  });
}

export interface StoreUpdateInput {
  catalogId: string;
  expectedVersion: number;
  /** Generated once per update attempt (crypto.randomUUID) and reused on retries of that attempt. */
  idempotencyKey: string;
  mode: StoreUpdateMode;
}

export function useStoreUpdate(
  spaceId: string,
): UseMutationResult<StoreUpdateResponse, ApiError, StoreUpdateInput> {
  return useApiMutation<StoreUpdateInput, StoreUpdateResponse>({
    path: `/spaces/${spaceId}/store/update`,
    ...(spaceId ? { spaceId } : {}),
    invalidate: [
      ['space', spaceId, 'store'],
      ['space', spaceId, 'workflows'],
      ['space', spaceId, 'workflow'],
      ['space', spaceId, 'integrations'],
      ['space', spaceId, 'capabilities'],
    ],
  });
}

export function useStoreUninstallPreview(
  spaceId: string,
): UseMutationResult<StoreUninstallPreviewResponse, ApiError, { catalogId: string }> {
  return useApiMutation<{ catalogId: string }, StoreUninstallPreviewResponse>({
    path: `/spaces/${spaceId}/store/uninstall-preview`,
    ...(spaceId ? { spaceId } : {}),
  });
}

export interface StoreUninstallInput {
  catalogId: string;
  /** Generated once per uninstall attempt (crypto.randomUUID) and reused on retries of that attempt. */
  idempotencyKey: string;
  keepUserData?: string[];
}

export function useStoreUninstall(
  spaceId: string,
): UseMutationResult<StoreUninstallResponse, ApiError, StoreUninstallInput> {
  return useApiMutation<StoreUninstallInput, StoreUninstallResponse>({
    path: `/spaces/${spaceId}/store/uninstall`,
    ...(spaceId ? { spaceId } : {}),
    invalidate: [
      ['space', spaceId, 'store'],
      ['space', spaceId, 'workflows'],
      ['space', spaceId, 'workflow'],
      ['space', spaceId, 'integrations'],
      ['space', spaceId, 'capabilities'],
    ],
  });
}

export function storeErrorCode(error: ApiError): string | null {
  const body = error.body;
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export function storeErrorDetails(error: ApiError): string[] {
  const body = error.body;
  if (body && typeof body === 'object' && 'errors' in body) {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors)) return errors.filter((e): e is string => typeof e === 'string');
  }
  return [];
}

export function storeErrorDivergence(error: ApiError): StoreInstallDivergence | null {
  const body = error.body;
  if (body && typeof body === 'object' && 'divergence' in body) {
    const parsed = StoreInstallDivergenceSchema.safeParse(
      (body as { divergence?: unknown }).divergence,
    );
    if (parsed.success) return parsed.data;
  }
  return null;
}
