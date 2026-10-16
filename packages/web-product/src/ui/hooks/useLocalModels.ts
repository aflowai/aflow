'use client';

import type {
  EntityDirectives,
  LocalModelAction,
  LocalModelDiagnosis,
  LocalRuntimeDiagnostics,
} from '@aflow/schemas';
import { useEffect, useState } from 'react';
import { useApiMutation, useApiQuery } from './useApiQuery.js';
import { llmReadinessQueryKey } from './useSpaceLlmReadiness.js';

/** While bytes are flowing the page reads the record this often; otherwise only when something changes it. */
const DOWNLOAD_POLL_MS = 2_000;

export const localModelsQueryKey = (spaceId: string) => ['space', spaceId, 'localModels'] as const;

/**
 * The space's models on this computer, from the one diagnosis readiness and
 * Helmsman read too (Plan 323 D15).
 */
export function useLocalModels(spaceId: string, enabled: boolean) {
  // Polled only while a download runs; read from the last answer, since the
  // interval has to be chosen before this render's answer exists.
  const [downloading, setDownloading] = useState(false);
  const query = useApiQuery<{ diagnostics: LocalRuntimeDiagnostics | null }>({
    key: localModelsQueryKey(spaceId),
    path: `/spaces/${spaceId}/local-models`,
    enabled: enabled && spaceId.length > 0,
    ...(downloading ? { refetchInterval: DOWNLOAD_POLL_MS } : {}),
    spaceId,
  });
  const nowDownloading =
    query.data?.diagnostics?.models.some((m) => m.pull?.status === 'downloading') ?? false;
  useEffect(() => {
    setDownloading(nowDownloading);
  }, [nowDownloading]);
  const invalidate = [localModelsQueryKey(spaceId), llmReadinessQueryKey(spaceId)];
  const act = useApiMutation<LocalModelAction, { message: string }>({
    path: () => `/spaces/${spaceId}/local-models/actions`,
    serialize: (action) => JSON.stringify(action),
    spaceId,
    invalidate,
  });
  const stopPull = useApiMutation<string, { stopped: boolean }>({
    path: (model) => `/spaces/${spaceId}/local-models/pulls/${encodeURIComponent(model)}`,
    method: 'DELETE',
    spaceId,
    invalidate,
  });
  return {
    diagnostics: query.data?.diagnostics ?? null,
    isLoading: query.isLoading,
    act,
    stopPull,
  };
}

/**
 * The directives with every role on one model: the default set to it, each
 * role's override cleared so it inherits, and the Clerk on the space default —
 * the one role that does not inherit unless told to. One GPU serves every
 * role, and a role on another model is a load each time the work switches.
 */
export function everyRoleOn(
  directives: EntityDirectives,
  model: LocalModelDiagnosis,
): EntityDirectives {
  return {
    ...directives,
    modelDefaults: { default: model.ref, clerk: 'space_default' },
  };
}
