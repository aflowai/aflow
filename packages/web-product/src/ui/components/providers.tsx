'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ToastProvider } from '@aflow/design-system';
import { ThemeProvider } from '../providers/theme.js';
import { NavigationProvider } from './navigation-provider.js';
import {
  RECOVERY_MARKER,
  createSessionRecovery,
  provesAuthenticated,
  PROXY_RESPONSE_HEADER,
  type BlockedSession,
  type SessionRecovery,
} from '@aflow/web-product';

import { createQueryClient, type ApiError } from '../lib/query-client.js';
import { useApiQuery } from '../hooks/useApiQuery.js';

// Dev-only React Query Devtools. The dynamic import lets Next.js
// tree-shake the devtools chunk out of production bundles entirely —
// a `NODE_ENV` guard alone would hide the component at render time
// but still ship the JS. SSR is disabled because Devtools is a
// client-only UI surface.
const ReactQueryDevtools =
  process.env['NODE_ENV'] === 'production'
    ? null
    : dynamic(() => import('@tanstack/react-query-devtools').then((m) => m.ReactQueryDevtools), {
        ssr: false,
      });

// =============================================================================
// Theme Context
// =============================================================================

// =============================================================================

export interface SpaceInfo {
  id: string;
  name: string;
  slug: string;
  /** Explicit membership rows — solo (≤1) renders as a personal space */
  memberCount: number;
  /** User's role in this space, null = no access (unless tenant admin) */
  myRole: 'admin' | 'editor' | 'viewer' | null;
  defaultAgentId: string | null;
}

export function isSoloSpace(space: Pick<SpaceInfo, 'memberCount'>): boolean {
  return space.memberCount <= 1;
}

interface SpaceContextValue {
  spaces: SpaceInfo[];
  accessibleSpaces: SpaceInfo[];
  activeSpaceId: string | null;
  activeSpace: SpaceInfo | null;
  setActiveSpaceId: (id: string) => void;
  isLoading: boolean;
  loadError: ApiError | null;
  refresh: () => void;
}

interface ActiveSpaceStateValue {
  activeSpaceId: string | null;
  setActiveSpaceId: (id: string) => void;
}

interface SpaceDataValue {
  spaces: SpaceInfo[];
  isLoading: boolean;
  loadError: ApiError | null;
  refresh: () => void;
}

const ActiveSpaceStateContext = createContext<ActiveSpaceStateValue | null>(null);
const SpaceDataContext = createContext<SpaceDataValue | null>(null);

export function useSpace(): SpaceContextValue {
  const state = useContext(ActiveSpaceStateContext);
  const data = useContext(SpaceDataContext);
  if (!state || !data) {
    throw new Error('useSpace must be used within SpaceProvider');
  }
  const activeSpace = data.spaces.find((s) => s.id === state.activeSpaceId) ?? null;
  const accessibleSpaces = data.spaces.filter((s) => s.myRole !== null);
  return {
    spaces: data.spaces,
    accessibleSpaces,
    activeSpaceId: state.activeSpaceId,
    activeSpace,
    setActiveSpaceId: state.setActiveSpaceId,
    isLoading: data.isLoading,
    loadError: data.loadError,
    refresh: data.refresh,
  };
}

// =============================================================================

export interface RouteSpace extends SpaceInfo {
  /** The slug from the URL, normalized through the spaces list. */
  slugFromRoute: string;
}

export function useSpaceFromRoute(): RouteSpace | null {
  const params = useParams<{ space?: string }>();
  const data = useContext(SpaceDataContext);
  const slug = typeof params.space === 'string' ? params.space : null;
  if (!slug || !data) return null;
  const space = data.spaces.find((s) => s.slug === slug);
  if (!space) return null;
  return { ...space, slugFromRoute: slug };
}

function RouteSpaceBridge() {
  const params = useParams<{ space?: string }>();
  const data = useContext(SpaceDataContext);
  const state = useContext(ActiveSpaceStateContext);
  const slug = typeof params.space === 'string' ? params.space : null;

  useEffect(() => {
    if (!slug || !data || !state) return;
    const space = data.spaces.find((s) => s.slug === slug);
    // myRole null = no content access (e.g. a foreign personal space in the
    // admin's tenant-wide list) — activating it would strand the UI on a
    // space whose content requests all 403.
    if (!space?.myRole) return;
    if (state.activeSpaceId !== space.id) {
      state.setActiveSpaceId(space.id);
    }
  }, [slug, data, state]);

  return null;
}

const SPACE_STORAGE_KEY = 'aflow:active-space-id';

function ActiveSpaceStateProvider({ children }: { children: ReactNode }) {
  const [activeSpaceId, setActiveSpaceIdState] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Track the previous id so the invalidation effect fires only on
  // genuine switches, not on the initial mount.
  const prevSpaceIdRef = useRef<string | null>(null);

  // Restore previously-selected space from localStorage on first mount.
  // The data loader will overwrite this via auto-select if the saved
  // id no longer matches an accessible space.
  useEffect(() => {
    const saved = localStorage.getItem(SPACE_STORAGE_KEY);
    if (saved) setActiveSpaceIdState(saved);
  }, []);

  const setActiveSpaceId = useCallback((id: string) => {
    setActiveSpaceIdState(id);
    localStorage.setItem(SPACE_STORAGE_KEY, id);
  }, []);

  useEffect(() => {
    const prev = prevSpaceIdRef.current;
    if (prev !== null && activeSpaceId !== null && prev !== activeSpaceId) {
      void queryClient.invalidateQueries({ queryKey: ['space', prev] });
    }
    prevSpaceIdRef.current = activeSpaceId;
  }, [activeSpaceId, queryClient]);

  return (
    <ActiveSpaceStateContext.Provider value={{ activeSpaceId, setActiveSpaceId }}>
      {children}
    </ActiveSpaceStateContext.Provider>
  );
}

interface SpacesPayload {
  spaces?: SpaceInfo[];
}

interface TenantPayload {
  defaultSpaceId?: string | null;
}

function SpaceDataLoader({ children }: { children: ReactNode }) {
  const { activeSpaceId, setActiveSpaceId } = useContext(ActiveSpaceStateContext)!;

  const spacesQuery = useApiQuery<SpacesPayload>({
    key: ['spaces'],
    path: '/spaces',
    staleTime: 30_000,
  });
  const tenantQuery = useApiQuery<TenantPayload>({
    key: ['tenant'],
    path: '/tenant',
    staleTime: 5 * 60_000,
  });

  const spaces = useMemo<SpaceInfo[]>(() => {
    return spacesQuery.data?.spaces ?? [];
  }, [spacesQuery.data]);

  // Auto-select default space once the data lands. Re-runs when the
  // spaces list changes (e.g. user joins a new space) so a stale
  // selection cleared from `accessibleSpaces` gets replaced. Runs only
  // when `activeSpaceId` is empty or no longer accessible.
  useEffect(() => {
    if (spaces.length === 0) return;
    if (activeSpaceId && spaces.some((s) => s.id === activeSpaceId && s.myRole !== null)) {
      return;
    }
    const accessible = spaces.filter((s) => s.myRole !== null);
    const tenantDefault = tenantQuery.data?.defaultSpaceId
      ? accessible.find((s) => s.id === tenantQuery.data?.defaultSpaceId)
      : undefined;
    // The tenant's own default, or the first space this account can reach. A
    // space whose slug is `general` used to be preferred between the two, from
    // when the first space every tenant got was named that; a tenant that names
    // its default says so in `defaultSpaceId`.
    const autoSpace = tenantDefault ?? accessible[0];
    if (autoSpace) setActiveSpaceId(autoSpace.id);
  }, [spaces, tenantQuery.data, activeSpaceId, setActiveSpaceId]);

  // No recovery here. `useApiQuery` fetches through `authFetch`, so a 401 on this
  // query has already reached the one place that coordinates recovery — and a
  // second redirect consulting nothing could spend the single automatic attempt
  // twice, which is the loop that coordination exists to prevent.

  const refresh = useCallback((): void => {
    void spacesQuery.refetch();
    void tenantQuery.refetch();
  }, [spacesQuery, tenantQuery]);

  const isLoading = spacesQuery.isLoading;

  return (
    <SpaceDataContext.Provider
      value={{ spaces, isLoading, loadError: spacesQuery.error ?? null, refresh }}
    >
      {children}
    </SpaceDataContext.Provider>
  );
}

// =============================================================================
// API Context
// =============================================================================

interface ApiContextValue {
  apiUrl: string;
  spaceId: string | null;
  /** Pre-built headers with tenant and space. Use in every fetch call. */
  headers: () => Record<string, string>;
  /** Authentication-aware fetch: one coordinated recovery attempt per 401. */
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Set while authenticated traffic is blocked, with what to tell the visitor. */
  blockedSession: BlockedSession | null;
  /**
   * Try to recover now, because the visitor asked.
   *
   * Spends an attempt whatever the automatic gating says — the asking is what the
   * gating exists to substitute for.
   */
  retrySession: () => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function useApi() {
  const context = useContext(ApiContext);
  if (!context) {
    throw new Error('useApi must be used within ApiProvider');
  }
  return context;
}

function ApiProvider({
  children,
  recovery,
  tenantId,
}: {
  children: ReactNode;
  /** What this distribution does when the API says the caller is not authenticated. */
  recovery: SessionRecovery;
  /** This browser's tenant, or `null` where the API pins one. */
  tenantId: string | null;
}) {
  const [blockedSession, setBlockedSession] = useState<BlockedSession | null>(null);
  const activeSpaceState = useContext(ActiveSpaceStateContext);
  if (!activeSpaceState) {
    throw new Error('ApiProvider must be mounted inside ActiveSpaceStateProvider');
  }
  const activeSpaceId = activeSpaceState.activeSpaceId;

  const apiUrl = '/api';

  // One coordinator for the lifetime of the provider. Its own guard is a plain
  // variable rather than React state, because several requests can fail in the
  // same tick and a state update is not visible to the others until the next
  // render — which is how concurrent failures become concurrent redirects.
  const [coordinator] = useState(() =>
    createSessionRecovery(recovery, {
      currentLocation: () =>
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      navigate: (href) => {
        window.location.href = href;
      },
      storage: () => {
        try {
          // Touched, not just read: a private-mode window exposes the object and
          // throws on write, and a coordinator that cannot record an attempt
          // cannot promise one.
          window.sessionStorage.setItem(RECOVERY_MARKER + '.probe', '1');
          window.sessionStorage.removeItem(RECOVERY_MARKER + '.probe');
          return window.sessionStorage;
        } catch {
          return null;
        }
      },
    }),
  );

  const retrySession = useCallback((): void => {
    setBlockedSession(coordinator.retry());
  }, [coordinator]);

  const buildHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // Sent only where there is one to send. The proxy supplies its own default
    // for an API that accepts a selector, and drops it for an API that pins a
    // tenant — so inventing one here could only ever name the wrong tenant.
    if (tenantId !== null) h['X-Tenant-ID'] = tenantId;
    if (activeSpaceId) h['X-Space-ID'] = activeSpaceId;
    return h;
  }, [tenantId, activeSpaceId]);

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // Read before the request goes out, so a response can be judged against the
      // failure state it began under rather than the one it comes back to.
      const startedAt = coordinator.generation();
      const response = await fetch(input, init);
      if (response.status === 401) {
        setBlockedSession(coordinator.onUnauthenticated());
      } else if (
        provesAuthenticated(
          response.status,
          response.headers.get(PROXY_RESPONSE_HEADER) !== null,
        ) &&
        coordinator.onAuthenticated(startedAt)
      ) {
        // Accepted as evidence, so the attempt is spent and the session is open
        // again. Not conditional on what this provider remembers: the redirect
        // destroyed the previous one, and the first success after it is what has to
        // clear the marker.
        setBlockedSession(null);
      }
      return response;
    },
    [coordinator],
  );

  return (
    <ApiContext.Provider
      value={{
        apiUrl,
        spaceId: activeSpaceId,
        headers: buildHeaders,
        authFetch,
        blockedSession,
        retrySession,
      }}
    >
      {children}
    </ApiContext.Provider>
  );
}

// =============================================================================

/**
 * Mounts a single `QueryClient` per app instance for the lifetime of
 * `<Providers>`. The client is created via `useState`'s lazy
 * initializer — React's canonical "one-shot per mount" — so a
 * Strict Mode remount in dev (mount → unmount → remount) gets a fresh
 * client at remount but doesn't double-construct on the first render.
 * Production runs the initializer exactly once.
 *
 * Dev-only React Query Devtools panel is mounted alongside the
 * provider — the floating button in the bottom-left of the page
 * opens it. The component itself is a dynamic-imported chunk that
 * Next.js excludes from production bundles entirely.
 */
function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={client}>
      {children}
      {ReactQueryDevtools ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  );
}

// =============================================================================
// Combined Providers
// =============================================================================

export function Providers({
  children,
  recovery,
  tenantId,
}: {
  children: ReactNode;
  recovery: SessionRecovery;
  tenantId: string | null;
}) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <QueryProvider>
          <ActiveSpaceStateProvider>
            <ApiProvider recovery={recovery} tenantId={tenantId}>
              <SpaceDataLoader>
                <RouteSpaceBridge />
                <NavigationProvider>{children}</NavigationProvider>
              </SpaceDataLoader>
            </ApiProvider>
          </ActiveSpaceStateProvider>
        </QueryProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

// =============================================================================
// Public-page providers
// =============================================================================

/**
 * Api context for pages outside the dashboard (invite accept, request
 * access): no space state, no token persistence, and a 401 is an answer
 * the page renders ("sign in first") — never an automatic login redirect,
 * which would drop the page's query params.
 */
function PublicApiProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ApiContextValue>(
    () => ({
      apiUrl: '/api',
      spaceId: null,
      headers: () => ({ 'Content-Type': 'application/json' }),
      // Deliberately not `authFetch`: a 401 is an answer these pages render
      // ("sign in first"), and recovery would navigate away from the invitation
      // the visitor arrived holding.
      authFetch: (input, init) => fetch(input, init),
      blockedSession: null,
      // Nothing to recover: a 401 is an answer these pages render.
      retrySession: () => undefined,
    }),
    [],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

/** Minimal stack that lets public pages use `useApiQuery`/`useApiMutation`. */
export function PublicPageProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <PublicApiProvider>{children}</PublicApiProvider>
    </QueryProvider>
  );
}
