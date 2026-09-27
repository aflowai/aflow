'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  ActiveSurfaceCoachLifecycle,
  ActiveSurfaceRunLifecycle,
  CoachSurfaceSnapshot,
  RatificationApplyReason,
} from '@aflow/schemas';
import { useApi } from '../components/providers.js';
import { useCybernetic } from '../components/cybernetic-provider.js';
import { useActiveSurface } from './use-active-surface.js';
import { useApiQuery } from './useApiQuery.js';
import * as coachSurfaceBroker from './coach-surface-broker.js';
import { useResumeOnUnblock } from './use-resume-on-unblock.js';

// ============================================================================
// DTOs (mirror server response shapes — kept narrow on purpose)
// ============================================================================

export interface CoachProposalSummary {
  id: string;
  kind: string;
  status: string;
  summary: string;
  rationale: string;
  confidence: string;
  targetWorkflowSlug: string | null;
  opCount: number;
  opKinds: string[];
  authorityLevel: 'auto_apply' | 'stage_for_review' | 'require_operator';
  resolutionRoute: 'tenant_ratification' | 'platform_issue';
  proposedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  hasReflectionEvidence: boolean;
  lastRatificationError?: {
    reason: RatificationApplyReason;
    op: string;
    detail: string;
    at: string;
  };
  rebaseState?: 'clean' | 'stale';
  staleSummary?: {
    conflictCount: number;
    firstOpKind: string | null;
  };
  validationsSummary?: {
    overallSafe: boolean;
    warningCount: number;
    blockerCount?: number;
  };
  applyPreviewStatus?: {
    result: 'ok';
    previewedAt: string;
    workflowRevisionAtPreview: number | null;
  };
}

export interface CoachAnomalySummary {
  id: string;
  kind: string;
  severity: string;
  summary: string;
  reportedAt: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  coachSessionId?: string;
  relatedStagedChangeId?: string;
}

export interface CoachProposalDetail {
  id: string;
  kind: string;
  status: string;
  proposal: {
    summary: string;
    rationale: string;
    confidence: string;
    ops: Array<{ op: string; [key: string]: unknown }>;
  };
  evidence?: {
    sourceSessionIds?: string[];
    reflectionRefs?: Array<{
      runId: string;
      taskId: string;
      reflectionField: string;
      excerpt: string;
    }>;
    warrant?: {
      claim: string;
      evidenceSummary: string;
      warrant: string;
      expectedEffect: string;
      risk?: string;
      rollback?: string;
    };
    applyPreview?: {
      attempted: true;
      result: 'ok';
      previewedAt: string;
      workflowRevisionAtPreview: number | null;
    };
  };
  proposedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  lastRatificationError?: CoachProposalSummary['lastRatificationError'];
  rebaseState?: 'clean' | 'stale';
  pinnedRevision?: number;
  staleDetails?: {
    detectedAt: string;
    conflictingOpIndices: number[];
    conflicts: Array<{
      opIndex: number;
      opKind: string;
      descriptor: Record<string, unknown>;
      pinnedHash: string | null;
      currentHash: string | null;
    }>;
  };
}

export interface CoachActionResult {
  ok: boolean;
  /** Stable error code from the server, when present (e.g. `USE_DISMISS_FOR_PLATFORM_ISSUE`). */
  error?: string;
  /** Human-readable detail. */
  detail?: string;
}

export interface CoachSystemStatus {
  helmsmanLifecycle: ActiveSurfaceRunLifecycle | null;
  recentRun: {
    runId: string;
    workflowSlug: string;
    skillName: string | null;
    lifecycle: ActiveSurfaceRunLifecycle;
    endedAt: string | null;
  } | null;
}

export interface UseCoachSurfaceResult {
  // ---- Coach state from the active-surface aggregator ----
  lifecycle: ActiveSurfaceCoachLifecycle;
  coachSessionId: string | null;

  // ---- Lists ----
  anomalies: CoachAnomalySummary[];

  // ---- Counts (Coach-shaped only — anomalies) ----
  counts: {
    pendingAnomalies: number;
  };

  // ---- Status ----
  status: 'loading' | 'ready' | 'error';
  lastError: string | null;

  // ---- System status footer ----
  systemStatus: CoachSystemStatus;

  // ---- Actions (Coach-specific only) ----
  ratifyProposalForce: (proposalId: string) => Promise<CoachActionResult>;
  regenerateProposal: (proposalId: string) => Promise<CoachActionResult>;
  acknowledgeAnomaly: (anomalyId: string) => Promise<CoachActionResult>;
  loadProposalDetail: (proposalId: string) => Promise<CoachProposalDetail | null>;

  // ---- Imperative refresh ----
  refresh: () => Promise<void>;
}

// ============================================================================
// Pure helpers (testable without DOM / network)
// ============================================================================

export type FailedApplyVariant = 'stale_target' | 'transient';

export function failedApplyVariant(
  err: CoachProposalSummary['lastRatificationError'] | undefined,
): FailedApplyVariant | null {
  if (!err) return null;
  switch (err.reason) {
    case 'target_skill_missing':
    case 'workflow_not_found':
    case 'platform_artifact_read_only':
      return 'stale_target';
    case 'precondition_missing':
      return 'stale_target';
    case 'post_validation':
    case 'transient':
    case 'unknown':
    default:
      return 'transient';
  }
}

/**
 * The Coach section is collapsible per Shape 1. This decides whether the
 * "Active review" header should render based on lifecycle. `coachSessionId`
 * absence is tolerated — the panel can still show the lifecycle pill even
 * when the representative session isn't resolvable yet.
 */
export function shouldShowActiveReview(lifecycle: ActiveSurfaceCoachLifecycle): boolean {
  return lifecycle !== 'idle';
}

/**
 * Compose the system-status footer copy from the aggregator's helmsman
 * lifecycle and the most-recent surfaced run. Kept pure so the panel and
 * (later) the activity-tab variant can render the same string from the
 * same inputs.
 */
export function formatSystemStatusLine(status: CoachSystemStatus): {
  helmsman: string;
  run: string;
} {
  const helmsmanLabel = status.helmsmanLifecycle ?? 'idle';
  if (!status.recentRun) {
    return {
      helmsman: `Helmsman · ${helmsmanLabel}`,
      run: 'no recent run',
    };
  }
  const r = status.recentRun;
  const name = r.skillName ?? r.workflowSlug;
  return {
    helmsman: `Helmsman · ${helmsmanLabel}`,
    run: `last skill · ${name} · ${r.lifecycle}`,
  };
}

// ============================================================================
// Hook
// ============================================================================

function anomaliesQueryKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'anomalies', 'pending'];
}

export function useCoachSurface(
  spaceId: string,
  rootSessionId?: string | null,
): UseCoachSurfaceResult {
  const { apiUrl, headers, authFetch, blockedSession } = useApi();
  const { registerImperativeRefresh } = useCybernetic();
  const queryClient = useQueryClient();

  const activeSurface = useActiveSurface(spaceId, rootSessionId ?? null);

  const anomaliesQuery = useApiQuery<{ anomalies: CoachAnomalySummary[] }>({
    key: anomaliesQueryKey(spaceId),
    path: `/spaces/${spaceId}/anomalies?onlyPending=true&limit=100`,
    staleTime: 0,
    spaceId,
  });

  const anomalies = useMemo<CoachAnomalySummary[]>(
    () => anomaliesQuery.data?.anomalies ?? [],
    [anomaliesQuery.data],
  );
  const status: 'loading' | 'ready' | 'error' = anomaliesQuery.isError
    ? 'error'
    : anomaliesQuery.isLoading
      ? 'loading'
      : 'ready';
  const lastError = anomaliesQuery.error?.message ?? null;

  // Keep a live ref to the active-surface refresh — `useActiveSurface`
  // returns a fresh callback whenever its inputs change, but the combined
  // refresh below is registered with `registerImperativeRefresh` once and
  // must stay stable. The ref breaks that dependency without re-creating
  // the combined refresh (and thus re-subscribing) on every render.
  const activeSurfaceRefreshRef = useRef(activeSurface.refresh);
  activeSurfaceRefreshRef.current = activeSurface.refresh;

  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  // --------------------------------------------------------------------------
  // Reconciliation primitives — `invalidateQueries` is the canonical
  // "go re-read both lists" signal. Direct fetch was the pre-§4.4
  // pattern; with the shared cache, surgical invalidation is the
  // single source of truth.
  // --------------------------------------------------------------------------

  const invalidateLists = useCallback((): void => {
    void queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) });
  }, [spaceId]);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([
      activeSurfaceRefreshRef.current(),
      queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) }),
    ]);
  }, [spaceId]);

  // --------------------------------------------------------------------------
  const apiRef = useRef({ apiUrl, headers, authFetch, blockedSession });
  apiRef.current = { apiUrl, headers, authFetch, blockedSession };
  useResumeOnUnblock(coachSurfaceBroker.resume);
  useEffect(() => {
    const ctx: coachSurfaceBroker.BrokerContext = {
      apiUrl: apiRef.current.apiUrl,
      headers: () => apiRef.current.headers(),
      authFetch: (input, init) => apiRef.current.authFetch(input, init),
      isSessionExpired: () => apiRef.current.blockedSession !== null,
    };
    coachSurfaceBroker.acquire(spaceId, ctx);

    const unsubSnapshot = coachSurfaceBroker.subscribeSnapshot(
      spaceId,
      (snap: CoachSurfaceSnapshot) => {
        void (async () => {
          const key = anomaliesQueryKey(spaceId);
          await queryClientRef.current.cancelQueries({ queryKey: key, exact: true });
          queryClientRef.current.setQueryData<{ anomalies: CoachAnomalySummary[] }>(key, {
            anomalies: snap.anomalies as CoachAnomalySummary[],
          });
        })();
      },
    );

    const unsubAdded = coachSurfaceBroker.subscribeAnomalyAdded(spaceId, (anomaly) => {
      queryClientRef.current.setQueryData<{ anomalies: CoachAnomalySummary[] }>(
        anomaliesQueryKey(spaceId),
        (prev) => {
          const list = prev?.anomalies ?? [];
          if (list.some((a) => a.id === anomaly.id)) return prev;
          return { anomalies: [anomaly as CoachAnomalySummary, ...list] };
        },
      );
    });

    const unsubResolved = coachSurfaceBroker.subscribeAnomalyResolved(spaceId, (anomalyId) => {
      queryClientRef.current.setQueryData<{ anomalies: CoachAnomalySummary[] }>(
        anomaliesQueryKey(spaceId),
        (prev) => {
          if (!prev) return prev;
          const next = prev.anomalies.filter((a) => a.id !== anomalyId);
          if (next.length === prev.anomalies.length) return prev;
          return { anomalies: next };
        },
      );
    });

    let hadConnected = false;
    const unsubError = coachSurfaceBroker.subscribeStreamError(spaceId, () => {
      void queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) });
    });
    const unsubReconcile = coachSurfaceBroker.subscribeReconcileRequired(spaceId, () => {
      void queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) });
    });
    const unsubBrokerStatus = coachSurfaceBroker.subscribeStatus(spaceId, (status) => {
      if (status.isConnected) {
        if (hadConnected) {
          void queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) });
        }
        hadConnected = true;
      } else if (hadConnected) {
        // Disconnect after a prior connect — REST refetch closes the
        // gap until reconnect lands.
        void queryClientRef.current.invalidateQueries({ queryKey: anomaliesQueryKey(spaceId) });
      }
    });

    return () => {
      unsubSnapshot();
      unsubAdded();
      unsubResolved();
      unsubError();
      unsubReconcile();
      unsubBrokerStatus();
      coachSurfaceBroker.release(spaceId);
    };
  }, [spaceId]);

  // Register with the imperative-refresh fanout so chat-side
  // `triggerCyberneticRefresh()` (post-action, interrupt, etc.) also
  useEffect(() => {
    return registerImperativeRefresh(refreshAll);
  }, [registerImperativeRefresh, refreshAll]);

  // --------------------------------------------------------------------------
  // Action handlers — every one returns CoachActionResult instead of
  // throwing or silently swallowing, so the panel can surface errors.
  // --------------------------------------------------------------------------

  const postAction = useCallback(
    async (path: string, body: unknown): Promise<CoachActionResult> => {
      try {
        const res = await authFetch(`${apiUrl}${path}`, {
          method: 'POST',
          headers: { ...headers(), 'X-Space-ID': spaceId },
          body: JSON.stringify(body ?? {}),
        });
        invalidateLists();
        if (res.ok) {
          return { ok: true };
        }
        let detail: string | undefined;
        let error: string | undefined;
        try {
          const parsed = (await res.json()) as { error?: string; detail?: string };
          error = parsed.error;
          detail = parsed.detail;
        } catch {
          // Non-JSON error body — leave fields blank.
        }
        return {
          ok: false,
          error: error ?? `HTTP ${String(res.status)}`,
          ...(detail !== undefined ? { detail } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          error: 'NETWORK_ERROR',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [apiUrl, authFetch, headers, spaceId, invalidateLists],
  );

  const ratifyProposalForce = useCallback(
    (proposalId: string) =>
      postAction(`/spaces/${spaceId}/proposals/${proposalId}/ratify?force=true`, {}),
    [postAction, spaceId],
  );

  const regenerateProposal = useCallback(
    (proposalId: string) => postAction(`/spaces/${spaceId}/proposals/${proposalId}/regenerate`, {}),
    [postAction, spaceId],
  );

  const acknowledgeAnomaly = useCallback(
    (anomalyId: string) => postAction(`/spaces/${spaceId}/anomalies/${anomalyId}/acknowledge`, {}),
    [postAction, spaceId],
  );

  // Detail loader stays on a direct authFetch (not useApiQuery) — it
  // fires on-demand from the proposal row's expand handler, returns a
  // single shape, and doesn't benefit from caching across multiple
  // call sites the way the list endpoints do. The single concern this
  // PR addresses is auth-aware routing (authFetch instead of raw
  // fetch) so a session expiry on detail-load redirects properly.
  const loadProposalDetail = useCallback(
    async (proposalId: string): Promise<CoachProposalDetail | null> => {
      try {
        const res = await authFetch(`${apiUrl}/spaces/${spaceId}/proposals/${proposalId}`, {
          headers: { ...headers(), 'X-Space-ID': spaceId },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { proposal: CoachProposalDetail };
        return body.proposal;
      } catch {
        return null;
      }
    },
    [apiUrl, authFetch, headers, spaceId],
  );

  // --------------------------------------------------------------------------
  // Derived state
  // --------------------------------------------------------------------------

  const coachState = activeSurface.snapshot?.coach;
  const lifecycle: ActiveSurfaceCoachLifecycle = coachState?.lifecycle ?? 'idle';
  const coachSessionId = coachState?.coachSessionId ?? null;

  const counts = useMemo(
    () => ({ pendingAnomalies: coachState?.pendingAnomalies ?? 0 }),
    [coachState?.pendingAnomalies],
  );

  const systemStatus = useMemo<CoachSystemStatus>(() => {
    const snap = activeSurface.snapshot;
    if (!snap) return { helmsmanLifecycle: null, recentRun: null };
    const firstRun = snap.surfacedRuns[0];
    return {
      helmsmanLifecycle: snap.helmsman.lifecycle,
      recentRun: firstRun
        ? {
            runId: firstRun.runId,
            workflowSlug: firstRun.workflowSlug,
            skillName: firstRun.skillName ?? null,
            lifecycle: firstRun.lifecycle,
            endedAt: firstRun.endedAt,
          }
        : null,
    };
  }, [activeSurface.snapshot]);

  return {
    lifecycle,
    coachSessionId,
    anomalies,
    counts,
    status,
    lastError,
    systemStatus,
    ratifyProposalForce,
    regenerateProposal,
    acknowledgeAnomaly,
    loadProposalDetail,
    refresh: refreshAll,
  };
}
