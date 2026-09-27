'use client';

import { useApiQuery } from './useApiQuery.js';

export interface SpaceDetail {
  /** Space id, as `GET /spaces/:id` actually names it. */
  id: string;
  /**
   * Not sent by that endpoint. Declared optional rather than dropped because
   * the name reads like the obvious one, and a caller reaching for it should
   * be told by the compiler that it may be absent instead of sending
   * `undefined` into a route that wants a uuid.
   */
  spaceId?: string;
  name: string;
  slug: string;
  description: string | null;
  memberCount?: number;
  defaultAgentId: string | null;
  /** Cybernetic directives — null/undefined means non-cybernetic space. */
  directives: Record<string, unknown> | null;
  myRole?: 'admin' | 'editor' | 'viewer' | null;
  createdAt?: string;
  updatedAt?: string;
}

interface UseSpaceDetailReturn {
  space: SpaceDetail | null;
  isLoading: boolean;
  error: string | null;
}

export function useSpaceDetail(spaceId: string | null): UseSpaceDetailReturn {
  const { data, isLoading, error } = useApiQuery<SpaceDetail>({
    key: ['space', spaceId ?? '__none__', 'detail'],
    path: spaceId ? `/spaces/${spaceId}` : '/spaces',
    staleTime: 30_000,
    enabled: spaceId !== null,
    ...(spaceId ? { spaceId } : {}),
  });

  return {
    space: data ?? null,
    isLoading,
    error: error ? error.message : null,
  };
}
