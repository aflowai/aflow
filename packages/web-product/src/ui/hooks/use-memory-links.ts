'use client';

import { useApiQuery } from './useApiQuery.js';
import type { ApiError } from '../lib/query-client.js';
import type { UseQueryResult } from '@tanstack/react-query';

/** Identity of a document on either end of a link — enough to open it. */
export interface MemoryLinkedDoc {
  id: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface MemoryOutgoingLink {
  targetPath: string;
  /** Recomputed at read: a target that exists today may not have existed at write. */
  resolved: boolean;
  occurrenceCount: number;
  context?: string;
  target?: MemoryLinkedDoc;
}

export interface MemoryBacklink {
  fromPath: string;
  context?: string;
  updatedAt: string;
  source?: MemoryLinkedDoc;
}

export interface MemoryLinksBlock {
  outgoing: MemoryOutgoingLink[];
  backlinks: MemoryBacklink[];
  /** Exact totals — the arrays above are a capped page of each. */
  outgoingTotal: number;
  outgoingGhostTotal: number;
  backlinkTotal: number;
  truncated?: boolean;
}

export function useMemoryLinks(
  spaceId: string | undefined,
  docId: string | null,
): UseQueryResult<MemoryLinksBlock, ApiError> {
  return useApiQuery<MemoryLinksBlock>({
    key: ['space', spaceId ?? 'none', 'memory', 'links', docId ?? 'none'],
    path: `/memory/docs/${docId ?? ''}/links`,
    ...(spaceId ? { spaceId } : {}),
    enabled: Boolean(spaceId && docId),
    staleTime: 30_000,
  });
}
