'use client';

import { useMemo } from 'react';
import type { PrimaryInputDescriptor } from '@aflow/schemas';
import type { StateVariableInfo } from '../lib/types.js';
import { useApiQuery } from './useApiQuery.js';

interface FlowDetail {
  inputVariables: StateVariableInfo[];
  primaryInput: PrimaryInputDescriptor | null;
}

interface UseFlowDetailReturn {
  flowDetail: FlowDetail | null;
  isLoading: boolean;
}

interface FlowDetailResponse {
  definition?: Record<string, unknown>;
  inputContract?: Record<string, unknown>;
}

export function useFlowDetail(spaceId: string, flowId: string | null): UseFlowDetailReturn {
  const { data, isLoading } = useApiQuery<FlowDetailResponse>({
    key: ['space', spaceId, 'agents', flowId ?? '__none__'],
    path: flowId ? `/agents/${encodeURIComponent(flowId)}` : '/agents',
    ...(spaceId ? { spaceId } : {}),
    staleTime: 60_000,
    enabled: !!spaceId && flowId !== null,
  });

  const flowDetail = useMemo<FlowDetail | null>(() => {
    if (!data) return null;
    return extractFlowDetail(data);
  }, [data]);

  return { flowDetail, isLoading };
}

function extractFlowDetail(data: FlowDetailResponse): FlowDetail {
  const contract = data.inputContract as
    | {
        primaryInput?: PrimaryInputDescriptor;
      }
    | undefined;
  const primaryInput = contract?.primaryInput ?? null;

  // Legacy: extract inputVariables from definition for backward compat.
  const stateVars = (data.definition?.['stateVariables'] ?? []) as Array<Record<string, unknown>>;
  const inputVariables: StateVariableInfo[] = stateVars
    .filter((v) => {
      const lifecycle = v['lifecycle'] as Record<string, unknown> | undefined;
      return lifecycle?.['isInput'] === true;
    })
    .map((v) => {
      const lifecycle = v['lifecycle'] as Record<string, unknown> | undefined;
      const uiHints = v['uiHints'] as Record<string, unknown> | undefined;
      return {
        variableId: v['variableId'] as string,
        ...(v['name'] != null ? { name: v['name'] as string } : {}),
        ...(v['description'] != null ? { description: v['description'] as string } : {}),
        ...(v['typeSchema'] != null
          ? { typeSchema: v['typeSchema'] as Record<string, unknown> }
          : {}),
        semanticType: (v['semanticType'] as string | undefined) ?? 'text',
        required: (v['required'] as boolean | undefined) ?? false,
        lifecycle: {
          isInput: true,
          isOutput: (lifecycle?.['isOutput'] as boolean | undefined) ?? false,
        },
        ...(uiHints
          ? {
              uiHints: {
                ...(uiHints['placeholder'] != null
                  ? { placeholder: uiHints['placeholder'] as string }
                  : {}),
                ...(uiHints['helpText'] != null ? { helpText: uiHints['helpText'] as string } : {}),
                ...(uiHints['label'] != null ? { label: uiHints['label'] as string } : {}),
              },
            }
          : {}),
      };
    });

  return { inputVariables, primaryInput };
}
