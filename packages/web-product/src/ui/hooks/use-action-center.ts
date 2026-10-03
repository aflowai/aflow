'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { PostInstallTask } from '@aflow/schemas';

import { useApi } from '../components/providers.js';
import { useApiQuery } from './useApiQuery.js';
import * as broker from './action-center-broker.js';
import { useResumeOnUnblock } from './use-resume-on-unblock.js';
import { partitionLanes, type ActionCenterLanes } from './use-action-center-lanes.js';
import type { ActionCenterItem, CoachProposalExtension } from './use-action-center-types.js';

// Re-export the types so existing imports
// (`import type { ActionCenterItem } from './use-action-center.js'`)
// keep working. Phase 3 didn't relocate the types; it just split the
// transport into its own module.
export type {
  ActionCenterItem,
  ActionCenterItemKind,
  ActionCenterItemOrigin,
  ActionCenterAllowedAction,
  ActionCenterFocusEvent,
} from './use-action-center-types.js';

// ============================================================================
// Public types unique to this hook
// ============================================================================

export type ActionCenterResolution =
  | { kind: 'submit'; payload: unknown }
  | { kind: 'approve'; comment?: string }
  | { kind: 'reject'; reason?: string }
  | { kind: 'ratify' }
  | { kind: 'dismiss'; reason?: string }
  | { kind: 'reassign'; assigneeUserId: string; reason?: string };

export interface ActionCenterCounts {
  total: number;
  byKind: {
    human_input: number;
    human_approval: number;
    ratification: number;
    platform_issue: number;
    coach_activity: number;
    trigger_armed: number;
    needs_oauth_consent: number;
    write_approval: number;
    session_invitation: number;
    browser_handoff: number;
  };
  highPriority: number;
  /**
   * Items a human can act on right now (approvals + inputs + connections +
   * coach proposals). Attention badges use this, never `total` — informational
   * kinds (coach_activity, trigger_armed, platform_issue) would show counts with
   * nothing to do.
   */
  actionable: number;
}

export interface ActionCenterResolveResult {
  ok: boolean;
  /** Server-translated error message — UI surfaces in a banner. */
  error?: string;
  /**
   * Stale-CAS path returns the freshly-read item so the client can
   * re-render without an extra round-trip. Hook stamps it into state.
   */
  latestItem?: ActionCenterItem;
  /** Post-install setup tasks from a store_install ratification — render inline. */
  setupChecklist?: PostInstallTask[];
}

export interface UseActionCenterResult {
  /** Open items, sorted by requestedAt desc. Pre-grouped lanes via getters. */
  items: ActionCenterItem[];

  /** Convenience lanes — derived from `items`. */
  lanes: {
    /** `human_approval` items (paused-step gates, compute egress, etc.). */
    approvals: ActionCenterItem[];
    coachProposals: ActionCenterItem[];
    inputs: ActionCenterItem[];
    platformIssues: ActionCenterItem[];
    notices: ActionCenterItem[];
    /** `needs_oauth_consent` items (Plan 185 §9.3 — "Connect {provider}"). */
    connections: ActionCenterItem[];
  };

  /** Counts mirror of `lanes.length` plus high-priority subset. */
  counts: ActionCenterCounts;

  status: 'loading' | 'ready' | 'error';
  lastError: string | null;

  /** Per-item resolve state (idle/submitting/error). Drives <HitlResolution state>. */
  resolveStateById: Record<string, 'idle' | 'submitting' | 'error'>;
  resolveErrorById: Record<string, string | undefined>;

  /** Resolve action — returns the result so callers can chain on success. */
  resolve: (
    itemId: string,
    resolution: ActionCenterResolution,
  ) => Promise<ActionCenterResolveResult>;

  /** Manual refresh — both list and counts. */
  refresh: () => Promise<void>;

  /**
   * Phase 4.7 — proposal detail loader used by the shared `<ProposalCard>`
   * for items whose origin is a Coach proposal (kinds `ratification` and
   * `platform_issue`). The card calls this on expand; we proxy to the
   * existing `/spaces/:id/proposals/:id` endpoint and shape the result
   * into `ProposalCardDetail`.
   */
  loadProposalDetail: (proposalId: string) => Promise<ProposalCardDetail | null>;
}

/**
 * Shape returned by the Coach proposal detail endpoint. Top-level
 * fields mirror StagedChange's stored shape: `proposal.summary` /
 * `proposal.rationale` / `proposal.confidence` live one level down, while
 * timing + status live on the envelope.
 */
interface RawProposalDetail {
  id: string;
  kind: string;
  status?: string;
  proposal: {
    summary?: string;
    rationale?: string;
    confidence?: string;
    ops: Array<{ op: string; [key: string]: unknown }>;
    validations?: unknown;
  };
  evidence: {
    reflectionRefs?: Array<{
      runId: string;
      taskId: string;
      reflectionField: string;
      excerpt: string;
    }>;
  };
  targetWorkflowSlug?: string | null;
  proposedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  lastRatificationError?: CoachProposalExtension['lastRatificationError'];
  rebaseState?: 'stale' | 'clean';
  staleSummary?: CoachProposalExtension['staleSummary'];
}

/**
 * Subset shape consumed by `<ProposalCard loadDetail>`. Carries enough
 * summary fields for Action Center cards (where the list projection is
 * intentionally lean) to render header chrome (rationale, confidence,
 * op preview, validation badges) without a second round-trip.
 */
export interface ProposalCardDetail {
  kind: string;
  status?: string;
  summary?: string;
  rationale?: string;
  confidence?: string;
  opKinds?: string[];
  targetWorkflowSlug?: string | null;
  proposedAt?: string;
  lastRatificationError?: CoachProposalExtension['lastRatificationError'];
  rebaseState?: 'stale' | 'clean';
  staleSummary?: CoachProposalExtension['staleSummary'];
  proposal: {
    ops: Array<{ op: string; [key: string]: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validations?: any;
  };
  evidence?: {
    reflectionRefs?: Array<{
      runId: string;
      taskId: string;
      reflectionField: string;
      excerpt: string;
    }>;
  };
}

// ============================================================================
// Hook
// ============================================================================

function itemsQueryKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'action-center'];
}

interface ItemsPayload {
  items?: ActionCenterItem[];
}

// Re-export the lane partition helper that lives in its own React-free
// file (so tests can import it without dragging in TanStack Query).
// Consumers that need just the helper can import from either path.
// Re-exports use the local bindings imported at the top of the file —
// `export ... from '...'` works in tsc but Turbopack's resolver doesn't
// honor the `.js`-extension-to-`.ts` rewrite for relative paths inside
// this app, so we go through local bindings to keep both happy.
export { partitionLanes };
export type { ActionCenterLanes };

export function useActionCenter(spaceId: string | null): UseActionCenterResult {
  const { apiUrl, headers, authFetch, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const queryClient = useQueryClient();

  // Initial load + reconciliation reads. The broker writes
  // `setQueryData` on every broker event so subsequent re-renders come
  // from the cache, not the network.
  const queryKey = useMemo(() => (spaceId ? itemsQueryKey(spaceId) : ['__none__']), [spaceId]);
  const itemsQuery = useApiQuery<ItemsPayload>({
    key: queryKey,
    path: spaceId ? `/spaces/${spaceId}/action-center` : '/spaces',
    staleTime: 30_000,
    enabled: spaceId !== null,
    ...(spaceId ? { spaceId } : {}),
  });

  // ---- broker lifecycle ----------------------------------------------------

  // Latest refs — the broker callbacks close over these so they always
  // see fresh values without re-subscribing on every render.
  const apiRef = useRef({ apiUrl, headers, authFetch, sessionExpired });
  apiRef.current = { apiUrl, headers, authFetch, sessionExpired };
  useResumeOnUnblock(broker.resume);
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  // §4.2.3 reconciliation bookkeeping.
  // - `hadConnectedRef`: have we EVER seen `isConnected: true` for this
  //   acquire? Stays true once set so the first-connect transition
  //   doesn't get mistaken for a reconnect.
  // - `pendingReconcileRef`: an actual disconnect happened after a
  //   prior connect. Set on every true → false transition; cleared
  //   when the reconnect-driven invalidate fires.
  // - `lastReconcileAtRef`: last time we fired `invalidateQueries`
  //   (any trigger). The visibility-return trigger uses this to
  //   throttle reconciliations to ≥10s cadence.
  const hadConnectedRef = useRef(false);
  const pendingReconcileRef = useRef(false);
  const lastReconcileAtRef = useRef(0);
  const RECONCILE_THROTTLE_MS = 10_000;

  // Stream-level errors surface here; React state so the hook can
  // expose `lastError` to consumers. Resets to null on reconnect.
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    if (!spaceId) return;

    const reconcile = (): void => {
      lastReconcileAtRef.current = Date.now();
      void queryClientRef.current.invalidateQueries({ queryKey: itemsQueryKey(spaceId) });
    };

    const ctx: broker.BrokerContext = {
      apiUrl: apiRef.current.apiUrl,
      headers: () => apiRef.current.headers(),
      authFetch: (input, init) => apiRef.current.authFetch(input, init),
      isSessionExpired: () => apiRef.current.sessionExpired,
    };

    broker.acquire(spaceId, ctx);

    // Snapshot: replace the cached items entirely. Cancel any in-flight
    // `useApiQuery` fetch first so the network result can't land AFTER
    // the snapshot and clobber it. Without this guard, the initial
    // GET that's still resolving when the snapshot broker event arrives
    // would overwrite the snapshot the moment it settles, dropping any
    // insert/update events that landed in between.
    //
    // Phase 3 review follow-up: `await cancelQueries` (in an IIFE)
    // before `setQueryData` so the abort propagation is fully drained
    // before we write. Fire-and-forget left a narrow window where a
    // late-resolving fetch could still slip through; the IIFE shape
    // closes it without blocking the broker event loop.
    const unsubSnapshot = broker.subscribeSnapshot(spaceId, (items) => {
      void (async () => {
        await queryClientRef.current.cancelQueries({
          queryKey: itemsQueryKey(spaceId),
          exact: true,
        });
        queryClientRef.current.setQueryData<ItemsPayload>(itemsQueryKey(spaceId), { items });
        lastReconcileAtRef.current = Date.now();
      })();
    });

    // Insert / update: merge by id into the cached list. Authoritative
    // payload (the event ships full items), so no follow-up refetch.
    const unsubUpdate = broker.subscribeItemsUpdate(spaceId, (updates) => {
      queryClientRef.current.setQueryData<ItemsPayload>(itemsQueryKey(spaceId), (prev) => {
        const prevItems = prev?.items ?? [];
        return { items: mergeItems(prevItems, updates) };
      });
    });

    // Resolve: remove the matching ids from the cached list.
    const unsubResolve = broker.subscribeResolve(spaceId, (ids) => {
      queryClientRef.current.setQueryData<ItemsPayload>(itemsQueryKey(spaceId), (prev) => {
        const prevItems = prev?.items ?? [];
        const idSet = new Set(ids);
        return { items: prevItems.filter((it) => !idSet.has(it.id)) };
      });
    });

    // §4.2.3 trigger #1 — reconnect reconciliation.
    // Fires only when the broker transitions from a TRUE disconnect
    // back to connected — never on first-ever-connect. Without the
    // `pendingReconcileRef` gate, every mount would invalidate
    // immediately after the live stream came up, racing with the
    // initial `useApiQuery` fetch and the snapshot event for a third
    // write to the same cache key.
    const unsubStatus = broker.subscribeStatus(spaceId, (status) => {
      if (status.isConnected) {
        if (pendingReconcileRef.current) {
          reconcile();
          pendingReconcileRef.current = false;
        }
        hadConnectedRef.current = true;
        setStreamError(null);
      } else if (hadConnectedRef.current) {
        // Real disconnect after a prior connect — arm reconcile for
        // the next connected state. (The initial `false` we get
        // synchronously on subscribe is filtered by the
        // `hadConnectedRef` gate.)
        pendingReconcileRef.current = true;
      }
    });

    // Stream-level errors (server-emitted `error` event) — surface to UI.
    const unsubError = broker.subscribeStreamError(spaceId, (message) => {
      setStreamError(message);
    });

    // §4.2.3 trigger #2 — visibility-return reconcile, throttled to
    // ≥10s cadence so tab-switch storms don't hammer the endpoint. If
    // a snapshot landed within the throttle window the cache is
    // already fresh, so a refetch would be redundant.
    const onVisibility = (): void => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastReconcileAtRef.current < RECONCILE_THROTTLE_MS) return;
      reconcile();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      unsubSnapshot();
      unsubUpdate();
      unsubResolve();
      unsubStatus();
      unsubError();
      broker.release(spaceId);
    };
  }, [spaceId]);

  // ---- derived items/lanes/counts -----------------------------------------

  const items = useMemo<ActionCenterItem[]>(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);

  const lanes = useMemo<ActionCenterLanes>(() => partitionLanes(items), [items]);

  // A badge is a claim on one person's attention, so it counts only what is
  // waiting on them. Requests addressed to a teammate still render — a blocked
  // team must not look idle — but a bell lit by work you cannot do is a bell
  // people learn to ignore.
  const mine = useMemo(() => items.filter((it) => it.audience !== 'someone_else'), [items]);
  const mineLanes = useMemo<ActionCenterLanes>(() => partitionLanes(mine), [mine]);

  const counts = useMemo<ActionCenterCounts>(() => {
    const tally: ActionCenterCounts = {
      total: mine.length,
      actionable:
        mineLanes.approvals.length +
        mineLanes.inputs.length +
        mineLanes.connections.length +
        mineLanes.coachProposals.length,
      byKind: {
        human_input: 0,
        human_approval: 0,
        ratification: 0,
        platform_issue: 0,
        coach_activity: 0,
        trigger_armed: 0,
        needs_oauth_consent: 0,
        write_approval: 0,
        session_invitation: 0,
        browser_handoff: 0,
      },
      highPriority: 0,
    };
    for (const it of mine) {
      tally.byKind[it.kind] += 1;
      if (it.priority === 'high') tally.highPriority += 1;
    }
    return tally;
  }, [mine, mineLanes]);

  // ---- status + last-error projection -------------------------------------

  const status = useMemo<'loading' | 'ready' | 'error'>(() => {
    if (!spaceId) return 'ready';
    if (itemsQuery.isError) return 'error';
    if (itemsQuery.isLoading) return 'loading';
    return 'ready';
  }, [spaceId, itemsQuery.isError, itemsQuery.isLoading]);

  const lastError = streamError ?? (itemsQuery.error ? itemsQuery.error.message : null);

  // ---- resolve / loadProposalDetail (HTTP, unchanged shape) ---------------

  const [resolveStateById, setResolveStateById] = useState<
    Record<string, 'idle' | 'submitting' | 'error'>
  >({});
  const [resolveErrorById, setResolveErrorById] = useState<Record<string, string | undefined>>({});

  const resolve = useCallback(
    async (
      itemId: string,
      resolution: ActionCenterResolution,
    ): Promise<ActionCenterResolveResult> => {
      if (!spaceId) return { ok: false, error: 'No active space' };
      const currentItems = queryClientRef.current.getQueryData<ItemsPayload>(
        itemsQueryKey(spaceId),
      );
      const current = (currentItems?.items ?? []).find((it) => it.id === itemId);
      if (!current) return { ok: false, error: 'Item not found' };

      setResolveStateById((s) => ({ ...s, [itemId]: 'submitting' }));
      setResolveErrorById((s) => ({ ...s, [itemId]: undefined }));

      try {
        const res = await apiRef.current.authFetch(
          `${apiRef.current.apiUrl}/spaces/${spaceId}/action-center/${encodeURIComponent(itemId)}/resolve`,
          {
            method: 'POST',
            headers: { ...apiRef.current.headers(), 'X-Space-ID': spaceId },
            body: JSON.stringify({ origin: current.origin, resolution }),
          },
        );
        if (res.ok) {
          interface ResolveBody {
            setupChecklist?: PostInstallTask[];
            item?: unknown;
          }
          let setupChecklist: PostInstallTask[] | undefined;
          let resolvedBody: ResolveBody | null = null;
          try {
            resolvedBody = (await res.json()) as ResolveBody;
            setupChecklist = resolvedBody.setupChecklist;
          } catch {
            /* non-JSON */
          }
          // A reassignment leaves the request open on someone else's desk, so
          // the item is replaced with the routed version; every other
          // resolution closes it and it disappears. The broker's next event
          // confirms either way.
          queryClientRef.current.setQueryData<ItemsPayload>(itemsQueryKey(spaceId), (prev) => {
            const prevItems = prev?.items ?? [];
            if (resolution.kind === 'reassign') {
              const routed = (resolvedBody?.item ?? null) as ActionCenterItem | null;
              return {
                items: routed ? prevItems.map((it) => (it.id === itemId ? routed : it)) : prevItems,
              };
            }
            return { items: prevItems.filter((it) => it.id !== itemId) };
          });
          setResolveStateById((s) => ({ ...s, [itemId]: 'idle' }));
          return { ok: true, ...(setupChecklist !== undefined ? { setupChecklist } : {}) };
        }
        // Stale → 409 with latestItem in body. Other errors → message.
        let body: { message?: unknown; error?: unknown; latestItem?: unknown } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          /* non-JSON */
        }
        const message =
          typeof body.message === 'string'
            ? body.message
            : typeof body.error === 'string'
              ? body.error
              : `Resolve failed (HTTP ${String(res.status)})`;

        if (body.latestItem) {
          // 409 (stale CAS) + 422 (RATIFICATION_APPLY_FAILED) both
          // embed the freshly-loaded item so the client re-renders
          // with the new `resolutionError` / `lastRatificationError`
          // without an extra round-trip.
          const latest = body.latestItem as ActionCenterItem;
          queryClientRef.current.setQueryData<ItemsPayload>(itemsQueryKey(spaceId), (prev) => {
            const prevItems = prev?.items ?? [];
            return { items: mergeItems(prevItems, [latest]) };
          });
        }
        setResolveStateById((s) => ({ ...s, [itemId]: 'error' }));
        setResolveErrorById((s) => ({ ...s, [itemId]: message }));
        return {
          ok: false,
          error: message,
          ...(body.latestItem ? { latestItem: body.latestItem as ActionCenterItem } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setResolveStateById((s) => ({ ...s, [itemId]: 'error' }));
        setResolveErrorById((s) => ({ ...s, [itemId]: message }));
        return { ok: false, error: message };
      }
    },
    [spaceId],
  );

  const loadProposalDetail = useCallback(
    async (proposalId: string): Promise<ProposalCardDetail | null> => {
      if (!spaceId) {
        throw new Error('No active space');
      }
      const res = await apiRef.current.authFetch(
        `${apiRef.current.apiUrl}/spaces/${spaceId}/proposals/${encodeURIComponent(proposalId)}`,
        { headers: { ...apiRef.current.headers(), 'X-Space-ID': spaceId } },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { error?: unknown; message?: unknown };
          detail =
            typeof body.error === 'string'
              ? body.error
              : typeof body.message === 'string'
                ? body.message
                : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(`HTTP ${String(res.status)}${detail ? `: ${detail}` : ''}`);
      }
      const body = (await res.json()) as { proposal: RawProposalDetail };
      const sc = body.proposal;
      const reflectionRefs = sc.evidence.reflectionRefs;
      const opKinds = sc.proposal.ops.map((o) => o.op);
      return {
        kind: sc.kind,
        ...(sc.status ? { status: sc.status } : {}),
        ...(sc.proposal.summary ? { summary: sc.proposal.summary } : {}),
        ...(sc.proposal.rationale ? { rationale: sc.proposal.rationale } : {}),
        ...(sc.proposal.confidence ? { confidence: sc.proposal.confidence } : {}),
        opKinds,
        ...(sc.targetWorkflowSlug !== undefined
          ? { targetWorkflowSlug: sc.targetWorkflowSlug }
          : {}),
        ...(sc.proposedAt ? { proposedAt: sc.proposedAt } : {}),
        ...(sc.lastRatificationError !== undefined
          ? { lastRatificationError: sc.lastRatificationError }
          : {}),
        ...(sc.rebaseState ? { rebaseState: sc.rebaseState } : {}),
        ...(sc.staleSummary !== undefined ? { staleSummary: sc.staleSummary } : {}),
        proposal: {
          ops: sc.proposal.ops,
          validations: sc.proposal.validations,
        },
        ...(reflectionRefs && reflectionRefs.length > 0 ? { evidence: { reflectionRefs } } : {}),
      };
    },
    [spaceId],
  );

  // Manual refresh — force a refetch via the cache (the broker fills
  // in any subsequent live updates).
  const refresh = useCallback(async () => {
    if (!spaceId) return;
    await queryClientRef.current.invalidateQueries({ queryKey: itemsQueryKey(spaceId) });
  }, [spaceId]);

  return {
    items,
    lanes,
    counts,
    status,
    lastError,
    resolveStateById,
    resolveErrorById,
    resolve,
    refresh,
    loadProposalDetail,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Merge updated items into the array, replacing matches by id, sorted by requestedAt desc. */
function mergeItems(prev: ActionCenterItem[], updates: ActionCenterItem[]): ActionCenterItem[] {
  const map = new Map(prev.map((it) => [it.id, it]));
  for (const u of updates) map.set(u.id, u);
  const merged = Array.from(map.values());
  merged.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  return merged;
}
