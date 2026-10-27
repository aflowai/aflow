'use client';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  QuickStartOffer,
  StoreInstallResponse,
  StoreSpaceInstallRequest,
} from '@aflow/schemas';
import { useApiMutation, useApiQuery } from './useApiQuery.js';
import type { ApiError } from '../lib/query-client.js';

/**
 * The Store's quick starts, and whether the first-run offer applies: it does
 * while the only space is the empty first one (Plan 330 D1).
 */
export function useQuickStartOffer(): UseQueryResult<QuickStartOffer, ApiError> {
  return useApiQuery<QuickStartOffer>({
    key: ['quick-starts'],
    path: '/store/quick-start-offer',
    staleTime: 30_000,
  });
}

/** The request as the browser sends it: the idempotency key is a fresh UUID, branded by the server's parse. */
export type StartQuickStartInput = Omit<StoreSpaceInstallRequest, 'idempotencyKey'> & {
  idempotencyKey: string;
};

/** Start a new space from a quick start. The space is created by the install itself. */
export function useStartQuickStart(): UseMutationResult<
  StoreInstallResponse,
  ApiError,
  StartQuickStartInput
> {
  return useApiMutation<StartQuickStartInput, StoreInstallResponse>({
    path: '/store/space-installs',
    invalidate: [['spaces'], ['quick-starts']],
    // The picker owns its error text.
    onError: () => undefined,
  });
}
