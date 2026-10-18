'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { SpaceMemoryEmbedding } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/** How often the index state is re-read while documents wait to be embedded; no event stream carries it. */
const REINDEX_POLL_MS = 5_000;

export function memoryEmbeddingKey(spaceId: string) {
  return ['space', spaceId, 'memoryEmbedding'] as const;
}

/** The space's embedding model and index state, re-read while a re-index is running. */
export function useSpaceMemoryEmbedding(spaceId: string) {
  const key = memoryEmbeddingKey(spaceId);
  const cached = useQueryClient().getQueryData<SpaceMemoryEmbedding>(key);
  const reindexing = (cached?.documents.pending ?? 0) > 0;
  return useApiQuery<SpaceMemoryEmbedding>({
    key,
    path: `/spaces/${spaceId}/memory/embedding`,
    enabled: spaceId.length > 0,
    ...(reindexing ? { refetchInterval: REINDEX_POLL_MS } : {}),
  });
}
