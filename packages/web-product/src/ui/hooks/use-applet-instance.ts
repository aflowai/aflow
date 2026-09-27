'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  APPLET_RECENT_ACTIONS_DEFAULT,
  AppletInstanceDeltaSchema,
  type AppletActionReceipt,
  type AppletInstance,
  type AppletStatePatchOp,
  type PhoenixAppletSeat,
  type PhoenixAppletViewer,
} from '@aflow/schemas';
import { applyAppletStatePatch } from '@aflow/applet-runtime';
import { getRealtimeClient } from '../lib/realtimeClient.js';
import { useApiQuery } from './useApiQuery.js';
import type { ApiError } from '../lib/query-client.js';

export interface AppletInstanceSnapshot {
  instance: AppletInstance;
  definition: Record<string, unknown>;
  state: Record<string, unknown>;
  stateVersion: number;
  /** Oldest first, bounded by the definition's recentActionsLimit. */
  recentReceipts: AppletActionReceipt[];
  viewer: PhoenixAppletViewer;
  /** Who holds which declared seat — courtesy labels, resolved server-side. */
  seats?: PhoenixAppletSeat[];
}

export function appletInstanceKey(spaceId: string, instanceId: string): QueryKey {
  return ['space', spaceId, 'applets', instanceId];
}

interface OptimisticEntry {
  actionId: string;
  patch: AppletStatePatchOp[];
}

export interface UseAppletInstanceResult {
  snapshot: AppletInstanceSnapshot | undefined;
  /** Authoritative state with unconfirmed local patches applied on top. */
  renderedState: Record<string, unknown> | undefined;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => Promise<AppletInstanceSnapshot | undefined>;
  /** Overlay a local patch until its action settles. */
  applyOptimistic: (actionId: string, patch: AppletStatePatchOp[]) => void;
  dropOptimistic: (actionId: string) => void;
  /** Fold an applied action's receipt into the authoritative snapshot. */
  confirmReceipt: (receipt: AppletActionReceipt, stateVersion: number) => void;
}

/**
 * One applet instance: snapshot via the read route, live deltas via the
 * `applet.instance` realtime topic. A delta is applied only when its
 * stateVersion chains onto the held one — a gap means refetch, because the
 * topic never replays.
 */
export function useAppletInstance(
  spaceId: string | undefined,
  instanceId: string,
): UseAppletInstanceResult {
  const queryClient = useQueryClient();
  const key = appletInstanceKey(spaceId ?? '__none__', instanceId);

  const query = useApiQuery<AppletInstanceSnapshot>({
    key,
    path: `/applets/${instanceId}`,
    enabled: !!spaceId,
    ...(spaceId ? { spaceId } : {}),
  });

  const [optimistic, setOptimistic] = useState<OptimisticEntry[]>([]);

  useEffect(() => {
    if (!spaceId) return undefined;
    const cacheKey = appletInstanceKey(spaceId, instanceId);
    const subscription = getRealtimeClient().subscribe(
      { kind: 'applet.instance', instanceId },
      {
        onEvent: (event) => {
          const parsed = AppletInstanceDeltaSchema.safeParse(event);
          if (!parsed.success) return;
          const delta = parsed.data;
          const current = queryClient.getQueryData<AppletInstanceSnapshot>(cacheKey);
          if (!current) return;
          if (delta.stateVersion <= current.stateVersion) return;
          // A delta produced under a different pinned contract: the held
          // definition and view are stale, so patching would render new state
          // through an old view — always refetch.
          if (
            delta.definitionHash !== undefined &&
            delta.definitionHash !== current.instance.definitionHash
          ) {
            void queryClient.invalidateQueries({ queryKey: cacheKey });
            return;
          }
          if (delta.stateVersion === current.stateVersion + 1) {
            try {
              const nextState = applyAppletStatePatch(current.state, delta.patch);
              queryClient.setQueryData<AppletInstanceSnapshot>(cacheKey, {
                ...current,
                state: nextState,
                stateVersion: delta.stateVersion,
                ...(delta.status !== undefined
                  ? { instance: { ...current.instance, status: delta.status } }
                  : {}),
              });
              return;
            } catch {
              // A patch the held state cannot absorb is treated as a gap.
            }
          }
          void queryClient.invalidateQueries({ queryKey: cacheKey });
        },
        onError: (code, message) => {
          if (code !== 'subscribe_denied') {
            console.warn(`[applet-instance] ${code}: ${message}`);
          }
        },
      },
    );
    // Revalidate AFTER the subscription attaches: a card often mounts because
    // an action just committed, and its delta may have been published before
    // this subscriber existed — a cached snapshot would then be stale forever
    // (the gap detection only runs when the NEXT delta arrives).
    void queryClient.invalidateQueries({ queryKey: cacheKey });
    return () => {
      subscription.unsubscribe();
    };
  }, [spaceId, instanceId, queryClient]);

  const applyOptimistic = useCallback((actionId: string, patch: AppletStatePatchOp[]) => {
    setOptimistic((prev) => [
      ...prev.filter((entry) => entry.actionId !== actionId),
      { actionId, patch },
    ]);
  }, []);

  const dropOptimistic = useCallback((actionId: string) => {
    setOptimistic((prev) => prev.filter((entry) => entry.actionId !== actionId));
  }, []);

  const confirmReceipt = useCallback(
    (receipt: AppletActionReceipt, stateVersion: number) => {
      setOptimistic((prev) => prev.filter((entry) => entry.actionId !== receipt.actionId));
      if (!spaceId) return;
      const cacheKey = appletInstanceKey(spaceId, instanceId);
      const current = queryClient.getQueryData<AppletInstanceSnapshot>(cacheKey);
      if (!current) return;
      if (stateVersion <= current.stateVersion) return;
      if (receipt.beforeVersion === current.stateVersion) {
        try {
          const nextState = applyAppletStatePatch(current.state, receipt.patch);
          queryClient.setQueryData<AppletInstanceSnapshot>(cacheKey, {
            ...current,
            state: nextState,
            stateVersion: receipt.afterVersion,
            recentReceipts: appendReceipt(current, receipt),
            ...(receipt.effects.ending
              ? { instance: { ...current.instance, status: 'ended' as const } }
              : {}),
          });
          return;
        } catch {
          // Fall through to refetch.
        }
      }
      void queryClient.invalidateQueries({ queryKey: cacheKey });
    },
    [spaceId, instanceId, queryClient],
  );

  const snapshot = query.data;
  const renderedState = useMemo(() => {
    if (!snapshot) return undefined;
    let state = snapshot.state;
    for (const entry of optimistic) {
      try {
        state = applyAppletStatePatch(state, entry.patch);
      } catch {
        // An overlay the current state rejects is simply not shown.
      }
    }
    return state;
  }, [snapshot, optimistic]);

  const queryRefetch = query.refetch;
  const refetch = useCallback(async () => {
    const result = await queryRefetch();
    return result.data;
  }, [queryRefetch]);

  return {
    snapshot,
    renderedState,
    isLoading: query.isLoading,
    error: query.error,
    refetch,
    applyOptimistic,
    dropOptimistic,
    confirmReceipt,
  };
}

function appendReceipt(
  snapshot: AppletInstanceSnapshot,
  receipt: AppletActionReceipt,
): AppletActionReceipt[] {
  const limitRaw = snapshot.definition['recentActionsLimit'];
  const limit =
    typeof limitRaw === 'number' && limitRaw > 0 ? limitRaw : APPLET_RECENT_ACTIONS_DEFAULT;
  const next = [...snapshot.recentReceipts, receipt];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
