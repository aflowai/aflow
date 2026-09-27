'use client';

import { useMemo, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryFunctionContext,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { useToast } from '@aflow/design-system';
import { useApi } from '../components/providers.js';
import { ApiError, parseRetryAfter } from '../lib/query-client.js';

// ============================================================================
// Shared fetch helper — used by both query and mutation paths
// ============================================================================

/**
 * Execute a fetch against the API, applying tenant/space/auth headers
 * and converting non-2xx responses into typed `ApiError`s.
 *
 * Routes through the caller-supplied `fetchFn` — which is
 * `useApi().authFetch` in production paths — so a 401 from any wrapped
 * query/mutation triggers the same login redirect as legacy ad-hoc
 * fetch sites. Bypassing `authFetch` here would silently regress
 * session-expiry UX once Phase 2 migrations land.
 *
 * `extraHeaders` lets callers override or augment per-call (e.g. a
 * mutation that needs `If-Match`). Caller-supplied headers win over
 * the defaults from `buildHeaders` — that matters for things like
 * conditional request semantics where the wrapper's defaults must not
 * silently overwrite caller intent.
 */
async function apiFetch(opts: {
  apiUrl: string;
  path: string;
  init?: RequestInit | undefined;
  defaultHeaders: Record<string, string>;
  extraHeaders?: Record<string, string> | undefined;
  spaceIdOverride?: string | undefined;
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<unknown> {
  const url = `${opts.apiUrl}${opts.path}`;
  const headers: Record<string, string> = { ...opts.defaultHeaders };
  if (opts.spaceIdOverride) headers['X-Space-ID'] = opts.spaceIdOverride;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  const res = await opts.fetchFn(url, { ...opts.init, headers });

  if (!res.ok) {
    const retryAfterMs =
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined;
    // Best-effort body parse — many error responses are JSON, some are
    // plain text. Either way, `ApiError.body` is informational.
    let body: unknown = undefined;
    const text = await res.text().catch(() => '');
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    throw new ApiError({
      status: res.status,
      message: deriveErrorMessage(res, body),
      retryAfterMs,
      body,
    });
  }

  // Empty 2xx responses (204, etc.) return undefined.
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON 2xx (e.g. a future text/plain endpoint) — return the raw text.
    return text;
  }
}

function deriveErrorMessage(res: Response, body: unknown): string {
  if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
    // Many routes (OAuth client/policy 400/403, etc.) return `{ error }`
    // with no `message` — fall back to it so the actionable text reaches
    // the user instead of a bare HTTP status line.
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string' && e.length > 0) return e;
  }
  return `${String(res.status)} ${res.statusText || 'Request failed'}`;
}

// ============================================================================
// useApiQuery
// ============================================================================

export interface UseApiQueryOptions {
  /** Query key — follow the conventions documented at the top of this file. */
  key: QueryKey;
  /** Request path, e.g. `/users/me` or `/spaces/${spaceId}/action-center`. */
  path: string;
  /**
   * Optional fetch init (method defaults to GET; rarely overridden in queries).
   *
   * NOTE: `init` is intentionally excluded from the `queryFn` memo deps
   * — a fresh object identity on every render would defeat memoization
   * for callers who don't memoize `init` themselves. If a caller needs
   * the fetch behaviour to change (different method, signal), bump
   * `key` or `path` instead.
   */
  init?: RequestInit | undefined;
  /** Override the `X-Space-ID` header for this query (rare; usually inherited from `useApi`). */
  spaceId?: string;
  /** Extra headers to merge into the request. Caller-supplied headers win. */
  headers?: Record<string, string>;
  /** Per-query stale window. Falls back to `QueryClient` default (10s). */
  staleTime?: number;
  /** Per-query gc window. Falls back to `QueryClient` default (5min). */
  gcTime?: number;
  /** Suspend the query (don't fetch). Mirrors TanStack semantics. */
  enabled?: boolean;
  /**
   * Refetch interval in ms. Use sparingly — SSE is the live channel.
   * Polling is reserved for endpoints with no event stream.
   */
  refetchInterval?: number;
  /**
   * Whether an observer mounting onto an already-errored query may start a
   * fresh retry schedule. TanStack's default is `true`, which is right for a
   * query a screen holds once: coming back to it retries.
   *
   * Set `false` on a key many components hold at once. There, each mount would
   * otherwise spend another full schedule against a server that is already
   * refusing, and the cost of a refusal scales with the number of holders
   * again — the retry policy only fixes the observers present when it started.
   */
  retryOnMount?: boolean;
}

export function useApiQuery<TData = unknown>(
  opts: UseApiQueryOptions,
): UseQueryResult<TData, ApiError> {
  const api = useApi();

  // `useApi`'s `headers()` is a function (not a value) because the
  // underlying state — token, spaceId, tenantId — can shift between
  // renders. Capturing it in the queryFn closure picks up the live
  // value at fetch time, not the one frozen at hook mount.
  const apiRef = useRef(api);
  apiRef.current = api;

  const queryFn = useMemo(
    () =>
      async (_ctx: QueryFunctionContext): Promise<TData> => {
        const live = apiRef.current;
        const data = await apiFetch({
          apiUrl: live.apiUrl,
          path: opts.path,
          init: opts.init,
          defaultHeaders: live.headers(),
          fetchFn: live.authFetch,
          ...(opts.headers ? { extraHeaders: opts.headers } : {}),
          ...(opts.spaceId ? { spaceIdOverride: opts.spaceId } : {}),
        });
        devLogFetch('query', opts.key, opts.path);
        return data as TData;
      },
    // queryFn identity is irrelevant to TanStack's dedupe (it dedupes by
    // queryKey), but we re-memoize when key inputs change so closure
    // captures stay correct under StrictMode double-mount. opts.init
    // is intentionally excluded — a new RequestInit object identity on
    // every render would defeat memoization without changing behaviour
    // (the underlying fetch still uses the current ref).
    [opts.path, JSON.stringify(opts.key), opts.spaceId, JSON.stringify(opts.headers ?? null)],
  );

  return useQuery<TData, ApiError>({
    queryKey: opts.key,
    queryFn,
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
    ...(opts.gcTime !== undefined ? { gcTime: opts.gcTime } : {}),
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    ...(opts.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
    ...(opts.retryOnMount !== undefined ? { retryOnMount: opts.retryOnMount } : {}),
    // Retry policy — including the 429 schedule — is set on the QueryClient
    // default, where TanStack runs it once per query rather than once per
    // mounted observer. Reasserting it here would override that.
  });
}

// ============================================================================
// useApiBackwardQuery
// ============================================================================

export interface UseApiBackwardQueryOptions {
  /** Query key — follow the conventions documented at the top of this file. */
  key: QueryKey;
  /** Path builder. Receives the cursor for the page being asked for. */
  path: (cursor: string | undefined) => string;
  /** Override the `X-Space-ID` header for this query. */
  spaceId?: string;
  /** Extra headers to merge into the request. Caller-supplied headers win. */
  headers?: Record<string, string>;
  staleTime?: number;
  gcTime?: number;
  enabled?: boolean;
}

/** What a backward-paged endpoint has to answer with. */
export interface BackwardPage<TItem> {
  events: TItem[];
  /** Position for the next page back; absent when the history is exhausted. */
  olderCursor?: string;
  hasOlder?: boolean;
}

/**
 * One chronological list from pages that were fetched newest-first.
 *
 * Page 0 is the newest and each later page is older, so the PAGES reverse while
 * the events inside each one keep their order. Reversing the events too would
 * render a conversation backwards; not reversing the pages would render its
 * blocks out of order — both look like data corruption rather than a paging
 * bug, so this is asserted rather than eyeballed.
 */
export function flattenBackwardPages<TItem extends { eventId?: string }>(
  pages: Array<BackwardPage<TItem>>,
): TItem[] {
  const flat = [...pages].reverse().flatMap((p) => p.events);

  // Deduped because React keys must be unique, not because the pages are
  // expected to overlap. A repeated key does not degrade the render, it makes
  // it unsupported — children get duplicated or dropped — so the render
  // contract is held here rather than left to whatever produced the pages.
  const seen = new Set<string>();
  return flat.filter((item) => {
    const id = item.eventId;
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * The position to ask for the next page back, or nothing when done.
 *
 * A cursor offered with nothing behind it leaves the caller fetching a page
 * that comes back empty every time, which presents as a spinner that never
 * resolves rather than as an end of history.
 */
export function nextBackwardPageParam<TItem>(last: BackwardPage<TItem>): string | undefined {
  return last.hasOlder ? last.olderCursor : undefined;
}

/**
 * A history read that starts at the newest page and walks backward.
 *
 * The direction is the point. A read that starts at the beginning of a long
 * session shows its oldest events and needs the whole history fetched before it
 * can show the recent ones; starting at the end shows what matters immediately
 * and fetches the rest only if someone scrolls for it.
 *
 * Pages are returned oldest-first and flattened in reverse page order, so the
 * caller receives one chronological list however many pages have been loaded.
 */
export function useApiBackwardQuery<TItem extends { eventId?: string }>(
  opts: UseApiBackwardQueryOptions,
): Omit<UseInfiniteQueryResult<InfiniteData<BackwardPage<TItem>>, ApiError>, 'data'> & {
  items: TItem[];
  hasOlder: boolean;
} {
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;

  const queryFn = useMemo(
    () =>
      async (ctx: QueryFunctionContext): Promise<BackwardPage<TItem>> => {
        const live = apiRef.current;
        const cursor = ctx.pageParam as string | undefined;
        const path = opts.path(cursor);
        const data = await apiFetch({
          apiUrl: live.apiUrl,
          path,
          defaultHeaders: live.headers(),
          fetchFn: live.authFetch,
          ...(opts.headers ? { extraHeaders: opts.headers } : {}),
          ...(opts.spaceId ? { spaceIdOverride: opts.spaceId } : {}),
        });
        devLogFetch('query', opts.key, path);
        return data as BackwardPage<TItem>;
      },
    [JSON.stringify(opts.key), opts.spaceId, JSON.stringify(opts.headers ?? null)],
  );

  const query = useInfiniteQuery<
    BackwardPage<TItem>,
    ApiError,
    InfiniteData<BackwardPage<TItem>>,
    QueryKey,
    string | undefined
  >({
    queryKey: opts.key,
    queryFn,
    initialPageParam: undefined,
    // Only offered when the server says something is behind it. Returning a
    // position with nothing to fetch leaves the UI showing "loading more"
    // against a page that comes back empty every time.
    getNextPageParam: nextBackwardPageParam,
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
    ...(opts.gcTime !== undefined ? { gcTime: opts.gcTime } : {}),
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
  });

  const { data, ...rest } = query;

  const items = useMemo(() => (data ? flattenBackwardPages(data.pages) : []), [data]);

  return { ...rest, items, hasOlder: query.hasNextPage };
}

// ============================================================================
// useApiMutation
// ============================================================================

export interface UseApiMutationOptions<TInput, TOutput> {
  /** Path can be static or derived from the mutation input. */
  path: string | ((input: TInput) => string);
  /** HTTP method. Defaults to POST. */
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Override `X-Space-ID` for this mutation. */
  spaceId?: string;
  /** Extra headers to merge in. Caller-supplied headers win. */
  headers?: Record<string, string>;
  /**
   * Query keys to invalidate on success. Pass the broadest sensible
   * keys (e.g. `[['space', spaceId, 'action-center']]`) — TanStack
   * matches by prefix.
   */
  invalidate?: QueryKey[];
  /**
   * Body serializer. Defaults to `JSON.stringify`. Override for
   * `FormData`, `URLSearchParams`, etc.
   */
  serialize?: (input: TInput) => BodyInit;
  /** Called on success after invalidation, for side effects. */
  onSuccess?: (output: TOutput, input: TInput) => void;
  /**
   * Called on failure. When omitted, the error surfaces as a danger toast —
   * supply a handler to own the error UI (inline card text, form errors, …).
   */
  onError?: (error: ApiError, input: TInput) => void;
}

/**
 * Write a server resource through the shared cache.
 *
 * Default behaviour:
 *   - Method: POST.
 *   - Body:   `JSON.stringify(input)`, `Content-Type: application/json`.
 *   - Retry:  off (mutations are not idempotent by default).
 *   - On success: invalidates the keys in `opts.invalidate`, then calls
 *     `opts.onSuccess`.
 *
 * Returns the standard TanStack `UseMutationResult`. Consumers call
 * `mutate(input)` / `mutateAsync(input)` and read `isPending` etc.
 */
export function useApiMutation<TInput = void, TOutput = unknown>(
  opts: UseApiMutationOptions<TInput, TOutput>,
): UseMutationResult<TOutput, ApiError, TInput> {
  const api = useApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const apiRef = useRef(api);
  apiRef.current = api;

  return useMutation<TOutput, ApiError, TInput>({
    mutationFn: async (input: TInput): Promise<TOutput> => {
      const live = apiRef.current;
      const path = typeof opts.path === 'function' ? opts.path(input) : opts.path;
      const method = opts.method ?? 'POST';
      const body = opts.serialize ? opts.serialize(input) : JSON.stringify(input);
      const data = await apiFetch({
        apiUrl: live.apiUrl,
        path,
        init: { method, body },
        defaultHeaders: live.headers(),
        fetchFn: live.authFetch,
        ...(opts.headers ? { extraHeaders: opts.headers } : {}),
        ...(opts.spaceId ? { spaceIdOverride: opts.spaceId } : {}),
      });
      devLogFetch('mutation', [method, path], path);
      return data as TOutput;
    },
    onSuccess: (output, input) => {
      if (opts.invalidate) {
        for (const key of opts.invalidate) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
      opts.onSuccess?.(output, input);
    },
    onError: (error, input) => {
      if (opts.onError) {
        opts.onError(error, input);
        return;
      }
      toast({
        title: 'Something went wrong',
        description: error.message,
        tone: 'danger',
      });
    },
  });
}

// ============================================================================
// Dev logging
// ============================================================================

function devLogFetch(kind: 'query' | 'mutation', key: QueryKey | unknown[], path: string): void {
  if (process.env['NODE_ENV'] === 'production') return;
  // Mirrors the [session-events-broker] dev-log style. Useful for
  // corroborating React Query Devtools entries against the browser
  // network panel during diagnosis.
  console.debug(`[api-${kind}]`, JSON.stringify(key), '→', path);
}
