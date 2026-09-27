'use client';

import { useCallback, useMemo } from 'react';
import type { CatalogOperationResponse, CatalogStepTypeResponse } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/** Re-export for consumers that import from this hook. */
export type CatalogOperation = CatalogOperationResponse;
export type CatalogStepType = CatalogStepTypeResponse;

interface UseOperationCatalogReturn {
  operations: CatalogOperationResponse[];
  stepTypes: CatalogStepTypeResponse[];
  isLoading: boolean;
  error: string | null;
  getOperation: (operationId: string) => CatalogOperationResponse | undefined;
  getOperationsForStepType: (stepType: string) => CatalogOperationResponse[];
}

export function useOperationCatalog(): UseOperationCatalogReturn {
  const opsQuery = useApiQuery<{ operations?: CatalogOperationResponse[] }>({
    key: ['catalog', 'operations'],
    path: '/catalog/operations',
    staleTime: 5 * 60_000,
  });
  const stQuery = useApiQuery<{ stepTypes?: CatalogStepTypeResponse[] }>({
    key: ['catalog', 'step-types'],
    path: '/catalog/step-types',
    staleTime: 5 * 60_000,
  });

  const operations = useMemo(() => opsQuery.data?.operations ?? [], [opsQuery.data]);
  const stepTypes = useMemo(() => stQuery.data?.stepTypes ?? [], [stQuery.data]);
  const isLoading = opsQuery.isLoading || stQuery.isLoading;
  const error = opsQuery.error?.message ?? stQuery.error?.message ?? null;

  const getOperation = useCallback(
    (operationId: string) => operations.find((o) => o.operationId === operationId),
    [operations],
  );

  const getOperationsForStepType = useCallback(
    (stepType: string) => operations.filter((o) => o.stepType === stepType),
    [operations],
  );

  return {
    operations,
    stepTypes,
    isLoading,
    error,
    getOperation,
    getOperationsForStepType,
  };
}
