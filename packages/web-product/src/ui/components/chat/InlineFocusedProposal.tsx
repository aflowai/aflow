'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, Spinner, Text } from '@aflow/design-system';
import { useApi, useSpace } from '../providers.js';
import * as actionCenterBroker from '../../hooks/action-center-broker.js';
import {
  ProposalCard,
  type ProposalCardPayload,
  type ProposalCardSummary,
} from '../cybernetic/ProposalCard.js';

export interface InlineFocusedProposalProps {
  itemId: string;
  reason?: string;
}

interface ResolveState {
  state: 'idle' | 'submitting' | 'error';
  message?: string;
}

interface FetchedProposal {
  summary: ProposalCardSummary;
  detail: ProposalCardPayload;
  /**
   * The full Action Center item origin pulled from the server. Used
   * verbatim when calling /resolve so the CAS check passes — the server
   * computes `proposalRevision` from the proposal's current status, and
   * synthesising a 0 on the client would 409 the moment the proposal
   * transitions out of `proposed` (e.g., a prior session ratified it).
   */
  origin: Record<string, unknown>;
}

export function InlineFocusedProposal({ itemId, reason }: InlineFocusedProposalProps) {
  const { apiUrl, headers, authFetch, blockedSession } = useApi();
  const sessionExpired = blockedSession !== null;
  const { activeSpaceId } = useSpace();
  const [proposal, setProposal] = useState<FetchedProposal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState>({ state: 'idle' });

  const proposalId = parseProposalItemId(itemId);
  const unsupportedItem = proposalId === null;

  // Initial fetch — pulls BOTH the action-center item (for the origin
  // used in /resolve) AND the proposal detail (for the card body).
  // Re-runs when the id changes (e.g. chat scrolls into a different
  // focused item).
  useEffect(() => {
    if (!proposalId || !activeSpaceId) return;
    let cancelled = false;
    void (async () => {
      console.info(`[inline-focused-proposal] mount itemId=${itemId} spaceId=${activeSpaceId}`);
      try {
        // Proposal fetch is load-bearing: without it we have no card
        // body to render. Action-center item fetch is best-effort: when
        // it's missing (proposal already resolved → projection cleared,
        // OR a tiny race where the focus arrived before the projection
        // wrote), fall back to a status-derived origin so the card
        // still renders. The CAS check on resolve would catch a
        // genuinely stale origin anyway.
        const [itemRes, proposalRes] = await Promise.allSettled([
          fetch(`${apiUrl}/spaces/${activeSpaceId}/action-center/${encodeURIComponent(itemId)}`, {
            headers: { ...headers(), 'X-Space-ID': activeSpaceId },
          }),
          fetch(`${apiUrl}/spaces/${activeSpaceId}/proposals/${encodeURIComponent(proposalId)}`, {
            headers: { ...headers(), 'X-Space-ID': activeSpaceId },
          }),
        ]);

        if (proposalRes.status !== 'fulfilled') {
          throw proposalRes.reason instanceof Error
            ? proposalRes.reason
            : new Error(String(proposalRes.reason));
        }
        if (!proposalRes.value.ok) {
          throw new Error(`proposal HTTP ${String(proposalRes.value.status)}`);
        }

        let itemOrigin: Record<string, unknown> | null = null;
        if (itemRes.status === 'fulfilled' && itemRes.value.ok) {
          const itemBody = (await itemRes.value.json()) as { origin: Record<string, unknown> };
          itemOrigin = itemBody.origin;
        } else {
          console.info(
            `[inline-focused-proposal] action-center item unavailable (${
              itemRes.status === 'fulfilled'
                ? `HTTP ${String(itemRes.value.status)}`
                : 'fetch rejected'
            }); falling back to status-derived origin`,
          );
        }

        const body = (await proposalRes.value.json()) as { proposal: RawProposalDetail };
        const sc = body.proposal;
        // Status-derived origin mirrors `coachProposalSource.toActionCenterItem`:
        // revision = 0 while proposed, 1 once resolved. Used only when
        // the action-center GET above failed.
        if (!itemOrigin) {
          itemOrigin = {
            type: 'proposal',
            proposalId: sc.id,
            proposalRevision: sc.status === 'proposed' ? 0 : 1,
            resolutionRoute: sc.resolutionRoute ?? 'tenant_ratification',
          };
        }
        const opKinds = sc.proposal.ops.map((o) => o.op);
        const summary: ProposalCardSummary = {
          id: sc.id,
          kind: sc.kind,
          status: sc.status,
          summary: sc.proposal.summary ?? '',
          ...(sc.proposal.rationale ? { rationale: sc.proposal.rationale } : {}),
          ...(sc.proposal.confidence ? { confidence: sc.proposal.confidence } : {}),
          ...(sc.targetWorkflowSlug !== undefined
            ? { targetWorkflowSlug: sc.targetWorkflowSlug }
            : {}),
          ...(sc.proposedAt ? { proposedAt: sc.proposedAt } : {}),
          opKinds,
          ...(sc.lastRatificationError !== undefined
            ? { lastRatificationError: sc.lastRatificationError }
            : {}),
          ...(sc.rebaseState ? { rebaseState: sc.rebaseState } : {}),
          ...(sc.staleSummary !== undefined ? { staleSummary: sc.staleSummary } : {}),
        };
        const detail: ProposalCardPayload = {
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
          ...(sc.evidence?.reflectionRefs && sc.evidence.reflectionRefs.length > 0
            ? { evidence: { reflectionRefs: sc.evidence.reflectionRefs } }
            : {}),
        };
        if (!cancelled) {
          setProposal({ summary, detail, origin: itemOrigin });
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, activeSpaceId, proposalId, itemId]);

  const refetchProposal = useCallback(async () => {
    if (!activeSpaceId || !proposalId) return;
    try {
      // Re-fetch both the action-center item (so the `origin` reflects
      // the bumped `proposalRevision` after a resolve) and the proposal
      // detail (so the card body picks up the new status). Done in
      // parallel — both endpoints are GETs with no side effects.
      const [itemRes, proposalRes] = await Promise.all([
        fetch(`${apiUrl}/spaces/${activeSpaceId}/action-center/${encodeURIComponent(itemId)}`, {
          headers: { ...headers(), 'X-Space-ID': activeSpaceId },
        }),
        fetch(`${apiUrl}/spaces/${activeSpaceId}/proposals/${encodeURIComponent(proposalId)}`, {
          headers: { ...headers(), 'X-Space-ID': activeSpaceId },
        }),
      ]);
      if (!proposalRes.ok) return;
      const body = (await proposalRes.json()) as { proposal: RawProposalDetail };
      const sc = body.proposal;
      // 404 on the action-center item just means it's no longer open
      // (resolved + projection cleared the row). Keep the prior origin
      // — the card is about to flip to resolved anyway.
      let nextOrigin: Record<string, unknown> | null = null;
      if (itemRes.ok) {
        const itemBody = (await itemRes.json()) as { origin: Record<string, unknown> };
        nextOrigin = itemBody.origin;
      }
      setProposal((prev) =>
        prev
          ? {
              summary: {
                ...prev.summary,
                status: sc.status,
                ...(sc.lastRatificationError !== undefined
                  ? { lastRatificationError: sc.lastRatificationError }
                  : {}),
              },
              detail: {
                ...prev.detail,
                ...(sc.status ? { status: sc.status } : {}),
                ...(sc.lastRatificationError !== undefined
                  ? { lastRatificationError: sc.lastRatificationError }
                  : {}),
              },
              origin: nextOrigin ?? prev.origin,
            }
          : prev,
      );
    } catch {
      /* best-effort refresh — the next SSE event will reconcile */
    }
  }, [activeSpaceId, apiUrl, headers, proposalId, itemId]);

  // Subscribe to the action-center broker so the card reflects state
  // changes that happen anywhere — the operator's own click (whose
  // post-resolve refetch races server projection lag), a second browser
  // tab, the Activity tab, server-side flips. Without this the card
  // remained showing Approve/Reject after the resolve POST succeeded —
  // the inline render was a frozen snapshot of the item-at-mount.
  //
  // Triggering refetch (rather than merging the broker payload) keeps
  // the proposal-detail fetch as the single source of truth for the
  // card body (status, rebaseState, lastRatificationError, ops, …);
  // broker events only ship the action-center-item shape.
  useEffect(() => {
    if (!activeSpaceId || !proposalId) return;
    const ctx: actionCenterBroker.BrokerContext = {
      apiUrl,
      headers,
      authFetch,
      isSessionExpired: () => sessionExpired,
    };
    actionCenterBroker.acquire(activeSpaceId, ctx);
    const unsubUpdate = actionCenterBroker.subscribeItemsUpdate(activeSpaceId, (updates) => {
      if (updates.some((it) => it.id === itemId)) {
        void refetchProposal();
      }
    });
    const unsubResolve = actionCenterBroker.subscribeResolve(activeSpaceId, (ids) => {
      if (ids.includes(itemId)) {
        void refetchProposal();
      }
    });
    return () => {
      unsubUpdate();
      unsubResolve();
      actionCenterBroker.release(activeSpaceId);
    };
  }, [
    activeSpaceId,
    proposalId,
    itemId,
    apiUrl,
    headers,
    authFetch,
    sessionExpired,
    refetchProposal,
  ]);

  const resolveViaActionCenter = useCallback(
    async (
      resolution:
        | { kind: 'ratify' }
        | { kind: 'reject'; reason?: string }
        | { kind: 'dismiss'; reason?: string },
    ): Promise<void> => {
      if (!activeSpaceId || !proposal) return;
      setResolveState({ state: 'submitting' });
      try {
        const res = await fetch(
          `${apiUrl}/spaces/${activeSpaceId}/action-center/${encodeURIComponent(itemId)}/resolve`,
          {
            method: 'POST',
            headers: { ...headers(), 'X-Space-ID': activeSpaceId },
            body: JSON.stringify({
              // Pass the server-reported origin verbatim — it carries the
              // current `proposalRevision`, which the CAS check compares
              // against the freshly-read item. Synthesising one here
              // would 409 the moment the proposal's status moved out of
              // 'proposed' (e.g., another tab already resolved it).
              origin: proposal.origin,
              resolution,
            }),
          },
        );
        if (!res.ok) {
          let serverError: string | undefined;
          let serverCode: string | undefined;
          try {
            const body = (await res.json()) as {
              error?: unknown;
              message?: unknown;
            };
            serverCode = typeof body.error === 'string' ? body.error : undefined;
            serverError = typeof body.message === 'string' ? body.message : undefined;
          } catch {
            /* non-JSON */
          }
          // Translate platform error codes to operator-facing copy.
          // `STALE_ACTION_CENTER_ITEM` is the CAS-mismatch case — usually
          // means another surface (or another browser tab) already
          // resolved this proposal. Refetch + tell the user to retry if
          // they still need to act.
          if (res.status === 409 && serverCode === 'STALE_ACTION_CENTER_ITEM') {
            await refetchProposal();
            throw new Error(
              'This proposal has changed since the card loaded — most likely it was already ' +
                'resolved from another surface. The card has been refreshed; try again if it ' +
                'still needs your decision.',
            );
          }
          throw new Error(serverError || `Request failed (HTTP ${String(res.status)})`);
        }
        // Refresh proposal so the status field flips and ProposalCard
        // re-renders into its resolved form (status !== 'proposed' hides
        // the controls).
        setResolveState({ state: 'idle' });
        await refetchProposal();
      } catch (err) {
        setResolveState({
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeSpaceId, apiUrl, headers, itemId, proposal, refetchProposal],
  );

  if (unsupportedItem) {
    // Should be unreachable now — the schema regex rejects bare/non-prefixed
    // itemIds at parse time, so the agent can't focus something we don't
    // know how to render. Kept as a defensive last line for forward-compat:
    // if a new prefix (e.g. `record:`) ships before the inline renderer
    // does, the operator sees a clear "platform-side gap" message instead
    // of dev jargon, and we get a server log to triage.
    return (
      <Card>
        <CardBody>
          <Text size="sm" variant="muted">
            The agent pointed at an Action Center item this chat can&apos;t display inline (
            <code style={{ background: 'var(--color-surface-1)', padding: '0 4px' }}>{itemId}</code>
            ). Open the Action Center panel to act on it, or ask the agent to retry.
          </Text>
        </CardBody>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardBody>
          <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
            Failed to load proposal {proposalId}: {loadError}
          </Text>
        </CardBody>
      </Card>
    );
  }

  if (!proposal) {
    return (
      <Card>
        <CardBody>
          <Spinner size="sm" label="Loading proposal" />
        </CardBody>
      </Card>
    );
  }

  return (
    <ProposalCard
      proposal={proposal.summary}
      spaceId={activeSpaceId ?? ''}
      // Already loaded inline — provide a passthrough so ProposalCard's
      // Details toggle doesn't fire a second fetch.
      loadDetail={() => Promise.resolve(proposal.detail)}
      initiallyExpanded
      onRatify={async () => {
        await resolveViaActionCenter({ kind: 'ratify' });
      }}
      onReject={async (_id, rejectReason) => {
        await resolveViaActionCenter(
          rejectReason ? { kind: 'reject', reason: rejectReason } : { kind: 'reject' },
        );
      }}
      onDismiss={async (_id, dismissReason) => {
        await resolveViaActionCenter(
          dismissReason ? { kind: 'dismiss', reason: dismissReason } : { kind: 'dismiss' },
        );
      }}
      actionError={
        resolveState.state === 'error' && resolveState.message
          ? { ok: false, error: resolveState.message }
          : null
      }
      metadataSlot={
        reason ? (
          <Text size="xs" variant="muted" style={{ fontStyle: 'italic' }}>
            {reason}
          </Text>
        ) : null
      }
    />
  );
}

// ============================================================================
// Helpers
// ============================================================================

function parseProposalItemId(itemId: string): string | null {
  if (!itemId.startsWith('proposal:')) return null;
  const id = itemId.slice('proposal:'.length);
  return id.length > 0 ? id : null;
}

/** Local mirror of the proposal detail endpoint shape. */
interface RawProposalDetail {
  id: string;
  kind: string;
  status: string;
  source?: string;
  resolutionRoute?: 'tenant_ratification' | 'platform_issue';
  targetWorkflowSlug?: string | null;
  proposedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  lastRatificationError?: ProposalCardSummary['lastRatificationError'];
  rebaseState?: 'stale' | 'clean';
  staleSummary?: ProposalCardSummary['staleSummary'];
  proposal: {
    summary?: string;
    rationale?: string;
    confidence?: string;
    ops: Array<{ op: string; [key: string]: unknown }>;
    validations?: ProposalCardPayload['proposal']['validations'];
  };
  evidence: {
    reflectionRefs?: Array<{
      runId: string;
      taskId: string;
      reflectionField: string;
      excerpt: string;
    }>;
  };
}
