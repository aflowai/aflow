'use client';

import { useCallback, useRef, useState } from 'react';
import { useApi } from '../components/providers.js';

// ---------------------------------------------------------------------------
// Types — lightweight interfaces mirroring the REST API response shapes.
// ---------------------------------------------------------------------------

export interface MemoryQueryItem {
  entryType?: 'directory' | 'document';
  path: string;
  id: string;
  name?: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  semanticType?: string | null;
  updatedAt: string;
  preview?: string;
  description?: string;
  childCount?: { dirs: number; docs: number };
  hit?: { score: number; snippet?: string; chunkId?: string };
  spaceId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface MemoryQueryOutput {
  items: MemoryQueryItem[];
  nextCursor?: string | null;
  totalEstimate?: number;
}

export interface MemoryDocStat {
  id: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  tags: string[];
  semanticType?: string | null;
  version: number;
  embeddingStatus: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface MemoryGetOutput {
  stat: MemoryDocStat;
  data?: string;
  dataJson?: unknown;
  truncated?: boolean;
}

export interface MemoryPutOutput {
  id: string;
  path: string;
  version: number;
  sizeBytes: number;
}

export interface MemoryDeleteOutput {
  id: string;
  path: string;
  deleted: boolean;
}

export interface MemoryMkdirOutput {
  id: string;
  path: string;
  created: boolean;
}

export interface MemoryTrashItem extends MemoryDocStat {
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Narrow config shapes for URL/query building (callers pass loose objects). */
interface MemoryQueryHookConfig {
  pathPrefix?: string;
  mode?: string;
  query?: string;
  recursive?: boolean;
  cursor?: string;
  budget?: { limit?: number };
}

interface MemoryTargetRef {
  path?: string;
  id?: string;
}

interface MemoryGetHookConfig {
  target?: MemoryTargetRef;
  view?: string;
  maxBytes?: string | number;
}

interface MemoryDeleteHookConfig {
  target?: MemoryTargetRef;
  recursive?: boolean;
}

export interface UseMemoryOpsReturn {
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  /** List/search/grep documents via GET /api/memory/docs */
  query: (config: Record<string, unknown>) => Promise<MemoryQueryOutput | null>;
  /** Get document by ID via GET /api/memory/docs/:docId */
  get: (config: Record<string, unknown>) => Promise<MemoryGetOutput | null>;
  /** Create/upsert document via PUT /api/memory/docs */
  put: (config: Record<string, unknown>) => Promise<MemoryPutOutput | null>;
  /** Soft-delete document via DELETE /api/memory/docs/:docId */
  del: (config: Record<string, unknown>) => Promise<MemoryDeleteOutput | null>;
  /** Create directory via POST /api/memory/dirs */
  mkdir: (config: Record<string, unknown>) => Promise<MemoryMkdirOutput | null>;
  /** List trash via GET /api/memory/trash */
  listTrash: (options?: { limit?: number; cursor?: string }) => Promise<MemoryQueryOutput | null>;
  /** Restore from trash via POST /api/memory/trash/:docId/restore */
  restore: (docId: string) => Promise<{ id: string; path: string; restored: boolean } | null>;
  /** Permanently delete via DELETE /api/memory/trash/:docId */
  purge: (docId: string) => Promise<{ id: string; purged: boolean } | null>;
}

export function useMemoryOps(spaceIdOverride?: string): UseMemoryOpsReturn {
  const { apiUrl, headers } = useApi();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(0);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /** Generic fetch wrapper with loading/error state management. */
  const execute = useCallback(
    async <T>(url: string, init?: RequestInit): Promise<T | null> => {
      inflightRef.current += 1;
      setIsLoading(true);
      setError(null);

      try {
        const baseHeaders = headers();
        const requestHeaders: Record<string, string> = spaceIdOverride
          ? { ...baseHeaders, 'X-Space-ID': spaceIdOverride }
          : baseHeaders;
        const res = await fetch(url, {
          headers: requestHeaders,
          ...init,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        return null;
      } finally {
        inflightRef.current -= 1;
        if (inflightRef.current === 0) {
          setIsLoading(false);
        }
      }
    },
    [headers, spaceIdOverride],
  );

  const query = useCallback(
    (config: Record<string, unknown>) => {
      const c = config as MemoryQueryHookConfig;
      const params = new URLSearchParams();
      if (c.pathPrefix) params.set('pathPrefix', c.pathPrefix);
      if (c.mode) params.set('mode', c.mode);
      if (c.query) params.set('query', c.query);
      if (c.recursive) params.set('recursive', 'true');
      if (c.cursor) params.set('cursor', c.cursor);
      if (c.budget?.limit) params.set('limit', String(c.budget.limit));

      return execute<MemoryQueryOutput>(`${apiUrl}/memory/docs?${params.toString()}`);
    },
    [apiUrl, execute],
  );

  const get = useCallback(
    (config: Record<string, unknown>) => {
      const c = config as MemoryGetHookConfig;
      const docId = c.target?.id;
      if (!docId) {
        setError('Document ID required');
        return Promise.resolve(null);
      }
      const params = new URLSearchParams();
      if (c.view) params.set('view', c.view);
      if (c.maxBytes != null) params.set('maxBytes', String(c.maxBytes));

      return execute<MemoryGetOutput>(`${apiUrl}/memory/docs/${docId}?${params.toString()}`);
    },
    [apiUrl, execute],
  );

  const put = useCallback(
    (config: Record<string, unknown>) => {
      return execute<MemoryPutOutput>(`${apiUrl}/memory/docs`, {
        method: 'PUT',
        body: JSON.stringify(config),
      });
    },
    [apiUrl, execute],
  );

  const del = useCallback(
    (config: Record<string, unknown>) => {
      const c = config as MemoryDeleteHookConfig;
      const docId = c.target?.id;
      const recursive = c.recursive;
      if (!docId) {
        setError('Document or directory ID required');
        return Promise.resolve(null);
      }
      // Try docs first; if it's a directory, use the dirs endpoint
      const params = recursive ? '?recursive=true' : '';
      return execute<MemoryDeleteOutput>(`${apiUrl}/memory/docs/${docId}${params}`, {
        method: 'DELETE',
      });
    },
    [apiUrl, execute],
  );

  const mkdir = useCallback(
    (config: Record<string, unknown>) => {
      return execute<MemoryMkdirOutput>(`${apiUrl}/memory/dirs`, {
        method: 'POST',
        body: JSON.stringify(config),
      });
    },
    [apiUrl, execute],
  );

  const listTrash = useCallback(
    (options?: { limit?: number; cursor?: string }) => {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.cursor) params.set('cursor', options.cursor);

      return execute<MemoryQueryOutput>(`${apiUrl}/memory/trash?${params.toString()}`);
    },
    [apiUrl, execute],
  );

  const restore = useCallback(
    (docId: string) => {
      return execute<{ id: string; path: string; restored: boolean }>(
        `${apiUrl}/memory/trash/${docId}/restore`,
        { method: 'POST' },
      );
    },
    [apiUrl, execute],
  );

  const purge = useCallback(
    (docId: string) => {
      return execute<{ id: string; purged: boolean }>(`${apiUrl}/memory/trash/${docId}`, {
        method: 'DELETE',
      });
    },
    [apiUrl, execute],
  );

  return { isLoading, error, clearError, query, get, put, del, mkdir, listTrash, restore, purge };
}
