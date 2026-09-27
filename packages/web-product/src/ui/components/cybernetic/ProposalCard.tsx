'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardBody, Column, Row, Spinner, Text } from '@aflow/design-system';
import { FeedbackPicker } from '../feedback/FeedbackPicker.js';
import { ProposalDiffView } from './ProposalDiffView.js';
import { ProposalEvidenceList } from './ProposalEvidenceList.js';
import { ProposalValidationsChecklist } from './ProposalValidationsChecklist.js';
import type { ProposalReadiness } from './ProposalValidationsChecklist.js';
import { failedApplyVariant } from '../../hooks/use-coach-surface.js';
import type { CoachProposalSummary } from '../../hooks/use-coach-surface.js';

// ============================================================================
// Public types — superset across every surface
// ============================================================================

/** Wide summary shape — accepts both CoachProposalSummary and ProposalSummary. */
export interface ProposalCardSummary {
  id: string;
  kind: string;
  status: string; // 'proposed' | 'ratified' | 'rejected' | 'dismissed' | 'auto_applied' | 'expired'
  summary: string;
  rationale?: string;
  confidence?: string;
  targetWorkflowSlug?: string | null;
  proposedAt?: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  opKinds?: string[];
  hasReflectionEvidence?: boolean;
  resolutionRoute?: 'tenant_ratification' | 'platform_issue';
  lastRatificationError?: CoachProposalSummary['lastRatificationError'] | undefined;
  rebaseState?: 'stale' | 'clean' | undefined;
  staleSummary?:
    { conflictCount?: number | undefined; firstOpKind?: string | null | undefined } | undefined;
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

/**
 * Wide detail shape used by the diff/validations/evidence views.
 * Action Center surfaces start with a sparse `proposal` prop (just id +
 * kind + summary); when this detail loads, the card prefers its summary
 * fields so header chrome (rationale, confidence, op preview) matches
 * what the Activity tab shows.
 */
export interface ProposalCardPayload {
  /** Server-derived before→after entries — keyed by op index. */
  opDiffs?: Array<{
    opIndex: number;
    op: string;
    taskId?: string;
    entries: Array<{ field: string; before?: string; after?: string }>;
  }>;
  proposal: {
    ops: Array<{ op: string; [key: string]: unknown }>;
    validations?: ProposalReadiness | undefined;
  };
  kind: string;
  status?: string;
  summary?: string;
  rationale?: string;
  confidence?: string;
  opKinds?: string[];
  targetWorkflowSlug?: string | null;
  proposedAt?: string;
  lastRatificationError?: ProposalCardSummary['lastRatificationError'];
  rebaseState?: 'stale' | 'clean';
  staleSummary?: ProposalCardSummary['staleSummary'];
  evidence?: {
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
}

export interface ProposalCardActionResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

/**
 * A card action either does its work inline or returns a result to render. The
 * `void` arm is the inline case, which the rule reads as a union member.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
type ProposalActionReturn = void | Promise<void | ProposalCardActionResult>;
type ProposalAction<Args extends unknown[]> = (...args: Args) => ProposalActionReturn;

export interface ProposalCardProps {
  proposal: ProposalCardSummary;
  /** Space context — required when reject uses FeedbackPicker. */
  spaceId: string;

  /** Optional detail loader — enables the Details toggle + inline diff. */
  loadDetail?: (id: string) => Promise<ProposalCardPayload | null>;

  /**
   * All actions optional; the card only renders buttons whose handlers
   * are provided. Handlers may return synchronously, asynchronously,
   * or with a structured result the card surfaces via `actionError`.
   * The return is intentionally not awaited here — callers thread
   * results back through `actionError` if they want to render them.
   */

  onRatify?: ProposalAction<[id: string]> | undefined;
  onForceRatify?: ProposalAction<[id: string]> | undefined;
  onRegenerate?: ProposalAction<[id: string]> | undefined;
  onReject?: ProposalAction<[id: string, reason?: string]> | undefined;
  onDismiss?: ProposalAction<[id: string, reason?: string]> | undefined;

  /** Initial expand state. Surfaces that want the diff inline-by-default pass true. */
  initiallyExpanded?: boolean;

  /** Banner shown above the controls — typically a stale `CoachActionResult` from a prior click. */
  actionError?: ProposalCardActionResult | null;

  /** Optional top-right metadata slot — e.g. timestamp. */
  metadataSlot?: React.ReactNode;
}

// ============================================================================
// Component
// ============================================================================

const KIND_LABEL: Record<string, string> = {
  workflow_refinement: 'Workflow Refinement',
  eval_criterion_change: 'Eval Change',
  platform_issue: 'Platform Issue',
  pattern_flag: 'Pattern',
  directive_amendment: 'Directive',
  capability_binding: 'Capability Binding',
  skill_compose: 'Skill Compose',
  store_install: 'Store Install',
};

const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  proposed: 'warning',
  ratified: 'success',
  rejected: 'danger',
  dismissed: 'neutral',
  auto_applied: 'success',
  expired: 'neutral',
};

export function ProposalCard({
  proposal,
  spaceId,
  loadDetail,
  onRatify,
  onForceRatify,
  onRegenerate,
  onReject,
  onDismiss,
  initiallyExpanded = false,
  actionError,
  metadataSlot,
}: ProposalCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [detail, setDetail] = useState<ProposalCardPayload | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showRejectFeedback, setShowRejectFeedback] = useState(false);
  const [showForceConfirm, setShowForceConfirm] = useState(false);

  // Re-fetch detail when proposal id changes (e.g. after a list update).
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
  }, [proposal.id]);

  // Auto-load detail when expanded — keeps the inline diff visible
  const fetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!expanded || !loadDetail) return;
    if (fetchedForRef.current === proposal.id) return;
    fetchedForRef.current = proposal.id;
    setLoadingDetail(true);
    setDetailError(null);
    void (async () => {
      try {
        const loaded = await loadDetail(proposal.id);
        if (loaded) {
          setDetail(loaded);
        } else {
          setDetailError('Proposal not found.');
        }
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingDetail(false);
      }
    })();
  }, [expanded, loadDetail, proposal.id]);

  // Clear the fetched-for ref when the proposal id changes so the next
  // mount of the same component instance re-loads against the new id.
  useEffect(() => {
    return () => {
      fetchedForRef.current = null;
    };
  }, [proposal.id]);

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  // Merged view — detail (when loaded) wins over the sparse proposal
  // prop. This is what lets Action Center cards (which start with just
  // id + kind + summary) render the same header chrome as Activity-tab
  // cards (which carry the full CoachProposalSummary upfront).
  // `detail` is a load-once cache (guarded by `fetchedForRef`), so its
  // `status` goes stale when the parent advances the proposal's lifecycle
  // without changing the id — e.g. the inline chat card, which stays
  // mounted and flips `proposal.status` to `ratified`/`rejected` after a
  // resolve. The live prop must win once it leaves `proposed`, or the card
  // keeps `isPending` true and never drops its Ratify/Reject controls.
  // Sparse surfaces (Action Center / Coach panels) pass a hardcoded
  // `proposed` and unmount on resolve, so they still fall back to detail.
  const liveStatus =
    proposal.status !== 'proposed' ? proposal.status : (detail?.status ?? proposal.status);
  const merged = {
    summary: detail?.summary ?? proposal.summary,
    rationale: detail?.rationale ?? proposal.rationale,
    confidence: detail?.confidence ?? proposal.confidence,
    opKinds: detail?.opKinds ?? proposal.opKinds,
    targetWorkflowSlug: detail?.targetWorkflowSlug ?? proposal.targetWorkflowSlug,
    proposedAt: detail?.proposedAt ?? proposal.proposedAt,
    status: liveStatus,
    lastRatificationError: detail?.lastRatificationError ?? proposal.lastRatificationError,
    rebaseState: detail?.rebaseState ?? proposal.rebaseState,
    staleSummary: detail?.staleSummary ?? proposal.staleSummary,
  };

  const variant = failedApplyVariant(merged.lastRatificationError ?? undefined);
  const isFailed = variant !== null;
  const isStaleTarget = variant === 'stale_target';
  const isStale = merged.rebaseState === 'stale';
  const isPending = merged.status === 'proposed';
  const validations = proposal.validationsSummary;
  const validationsNeedReview =
    validations !== undefined && (!validations.overallSafe || validations.warningCount > 0);
  const ratifyDisabledForReview = validationsNeedReview && !expanded;

  // Auto-collapse the heavy detail body (diff, validations, evidence) on
  // the pending → resolved transition. The diff is decision-support while
  // the proposal is open; once acted upon it's just noise on a card that
  // stays mounted in the chat stream. The Details toggle remains, so the
  // operator can reopen it on demand. Surfaces that unmount resolved cards
  // (Action Center / Coach panels) never observe this transition.
  const wasPendingRef = useRef(isPending);
  useEffect(() => {
    if (wasPendingRef.current && !isPending) setExpanded(false);
    wasPendingRef.current = isPending;
  }, [isPending]);

  return (
    <Card style={{ backgroundColor: 'var(--color-accent-bg)' }}>
      <CardBody>
        <Column
          gap="lg"
          style={{
            borderLeft: isFailed
              ? '3px solid var(--color-danger-default)'
              : isStale
                ? '3px solid var(--color-warning-default)'
                : undefined,
            paddingLeft: isFailed || isStale ? 'var(--space-3)' : undefined,
            minWidth: 0,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            textWrap: 'auto',
          }}
        >
          {/* Header */}
          <Row gap="sm" align="center" wrap>
            <Text size="lg" weight="bold" style={{ fontFamily: 'var(--font-family-title)' }}>
              {merged.summary}
            </Text>
            <Badge variant={STATUS_VARIANT[merged.status ?? 'proposed'] ?? 'neutral'}>
              {merged.status ?? 'proposed'}
            </Badge>
            <Badge variant="neutral">{KIND_LABEL[proposal.kind] ?? proposal.kind}</Badge>
            {merged.confidence && <Badge variant="neutral">{merged.confidence}</Badge>}
            {isFailed && (
              <Badge variant="danger" title={merged.lastRatificationError?.detail}>
                won't apply: {merged.lastRatificationError?.op}
              </Badge>
            )}
            {isStale && !isFailed && (
              <Badge
                variant="warning"
                title={
                  merged.staleSummary?.conflictCount
                    ? `${String(merged.staleSummary.conflictCount)} conflict(s); first: ${
                        merged.staleSummary.firstOpKind ?? 'unknown'
                      }`
                    : 'Workflow shifted since this proposal was authored'
                }
              >
                out of date
                {merged.staleSummary?.conflictCount
                  ? ` (${String(merged.staleSummary.conflictCount)})`
                  : ''}
              </Badge>
            )}
            {validations && !validations.overallSafe && (
              <Badge variant="danger" title="One or more hard validation checks failed">
                unsafe
              </Badge>
            )}
            {validations && validations.warningCount > 0 && (
              <Badge
                variant="warning"
                title={`${String(validations.warningCount)} validation warning(s) — expand for detail`}
              >
                {String(validations.warningCount)} warning
                {validations.warningCount === 1 ? '' : 's'}
              </Badge>
            )}
            {proposal.applyPreviewStatus ? (
              <Badge
                variant="success"
                title={
                  'Pre-ratification apply-preview passed at ' +
                  new Date(proposal.applyPreviewStatus.previewedAt).toLocaleString() +
                  (proposal.applyPreviewStatus.workflowRevisionAtPreview !== null
                    ? ` (rev ${String(proposal.applyPreviewStatus.workflowRevisionAtPreview)})`
                    : '')
                }
              >
                preview ok
              </Badge>
            ) : proposal.kind === 'workflow_refinement' ||
              proposal.kind === 'eval_criterion_change' ? (
              <Badge
                variant="neutral"
                title="This proposal was authored before pre-ratification apply-preview was enabled. Apply may surface failures the preview would have caught."
              >
                preview not run
              </Badge>
            ) : null}
            {merged.targetWorkflowSlug && (
              <Text size="xs" variant="muted">
                {merged.targetWorkflowSlug}
              </Text>
            )}
            {(merged.proposedAt || metadataSlot) && (
              <span
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                {merged.proposedAt && (
                  <Text size="xs" variant="muted" title={formatTimestampTooltip(merged.proposedAt)}>
                    {formatRelativeTime(merged.proposedAt)}
                  </Text>
                )}
                {metadataSlot}
              </span>
            )}
          </Row>

          {/* Summary + rationale */}
          {merged.rationale && <Text size="xs">{merged.rationale}</Text>}

          {/* Ops preview badges */}
          {merged.opKinds && merged.opKinds.length > 0 && (
            <Row gap="xs" wrap>
              {merged.opKinds.map((op, i) => (
                <Badge key={`${op}-${String(i)}`} variant="info">
                  {op}
                </Badge>
              ))}
              {proposal.hasReflectionEvidence && (
                <Badge variant="neutral">has reflection evidence</Badge>
              )}
            </Row>
          )}

          {/* Failed-to-apply explanation */}
          {isStaleTarget && (
            <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
              {`Target ${
                merged.targetWorkflowSlug ? `"${merged.targetWorkflowSlug}"` : 'artifact'
              } is missing or invalid. Reject this proposal to clear the queue.`}
            </Text>
          )}
          {isStale && !isFailed && (
            <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
              {`The workflow has changed since this proposal was authored ` +
                `(${
                  merged.staleSummary?.firstOpKind ? `op "${merged.staleSummary.firstOpKind}" ` : ''
                }no longer matches the live subtree). ` +
                `Regenerate to get a fresh proposal from Coach against the current state, ` +
                `or Apply anyway after reviewing the diff.`}
            </Text>
          )}

          {/* Expanded body */}
          {expanded && (
            <Column gap="sm" style={{ marginTop: 'var(--space-2)' }}>
              {loadingDetail ? (
                <Spinner size="sm" label="Loading proposal detail" />
              ) : detail ? (
                <>
                  {detail.evidence?.warrant && <WarrantPanel warrant={detail.evidence.warrant} />}
                  {detail.proposal.validations && (
                    <ProposalValidationsChecklist validations={detail.proposal.validations} />
                  )}
                  {detail.evidence?.reflectionRefs && detail.evidence.reflectionRefs.length > 0 && (
                    <ProposalEvidenceList reflectionRefs={detail.evidence.reflectionRefs} />
                  )}
                  <ProposalDiffView
                    ops={detail.proposal.ops}
                    kind={detail.kind}
                    opDiffs={detail.opDiffs}
                  />
                </>
              ) : detailError ? (
                <Row gap="sm" align="center" wrap>
                  <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
                    Failed to load proposal detail: {detailError}
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!loadDetail) return;
                      // Clearing detailError + leaving expanded=true lets the
                      // auto-load effect re-fire when initiallyExpanded; for
                      // user-driven expansions we kick off a load directly.
                      setDetailError(null);
                      setLoadingDetail(true);
                      void (async () => {
                        try {
                          const loaded = await loadDetail(proposal.id);
                          if (loaded) setDetail(loaded);
                          else setDetailError('Proposal not found.');
                        } catch (err) {
                          setDetailError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setLoadingDetail(false);
                        }
                      })();
                    }}
                  >
                    Retry
                  </Button>
                </Row>
              ) : loadDetail ? (
                <Text size="xs" variant="muted">
                  No detail available.
                </Text>
              ) : null}
            </Column>
          )}

          {/* Reject feedback picker */}
          {showRejectFeedback && onReject && (
            <Column gap="xs">
              <Text size="sm" weight="semibold">
                Why are you rejecting this proposal?
              </Text>
              <FeedbackPicker
                spaceId={spaceId}
                subjectKind="proposal"
                subjectId={
                  merged.targetWorkflowSlug
                    ? `${merged.targetWorkflowSlug}:${proposal.id}`
                    : proposal.id
                }
                onSubmitted={() => {
                  setShowRejectFeedback(false);
                  void onReject(proposal.id);
                }}
                onDismiss={() => {
                  setShowRejectFeedback(false);
                  void onReject(proposal.id);
                }}
                compact
              />
            </Column>
          )}

          {showForceConfirm && !showRejectFeedback && onForceRatify && (
            <Column gap="xs">
              <Text size="sm" weight="semibold" style={{ color: 'var(--color-warning-default)' }}>
                Apply anyway?
              </Text>
              <Text size="xs" variant="muted">
                This will overwrite the current subtree(s) with this proposal's ops, even though
                another change has landed since it was authored. Review the diff above first.
              </Text>
              <Row gap="sm" align="center" wrap>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setShowForceConfirm(false);
                    void onForceRatify(proposal.id);
                  }}
                >
                  Yes, apply anyway
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForceConfirm(false);
                  }}
                >
                  Cancel
                </Button>
              </Row>
            </Column>
          )}

          {/* Server-reported action error from a prior click. Rendered
              immediately above the action buttons so it's in the same
              visual unit as the controls — the operator's eyes are
              already there. The card body (markdown summary,
              validations checklist, diff) can be long enough that an
              error at the top of the card scrolls off-screen by the
              time it appears. */}
          {actionError && !actionError.ok && !showRejectFeedback && !showForceConfirm && (
            <div
              role="alert"
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-danger-default)',
                background: 'var(--color-danger-subtle, rgba(239, 68, 68, 0.08))',
              }}
            >
              <Text size="sm">{actionError.error ?? 'Action failed'}</Text>
              {actionError.detail && (
                <Text size="xs" variant="muted">
                  {actionError.detail}
                </Text>
              )}
            </div>
          )}

          {/* Actions row */}
          {!showRejectFeedback && !showForceConfirm && (
            <Row gap="sm" align="center" wrap>
              {loadDetail && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toggleExpanded();
                  }}
                >
                  {expanded ? 'Collapse' : 'Details'}
                </Button>
              )}
              {isPending && onRatify && !isFailed && !isStale && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={ratifyDisabledForReview}
                  title={
                    ratifyDisabledForReview
                      ? 'Expand details to review validation flags before ratifying.'
                      : undefined
                  }
                  onClick={() => {
                    void onRatify(proposal.id);
                  }}
                >
                  Ratify
                </Button>
              )}
              {isPending && onRatify && variant === 'transient' && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void onRatify(proposal.id);
                  }}
                >
                  Retry
                </Button>
              )}
              {isPending && onRegenerate && isStale && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void onRegenerate(proposal.id);
                  }}
                >
                  Regenerate
                </Button>
              )}
              {isPending && onForceRatify && isStale && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!expanded) toggleExpanded();
                    setShowForceConfirm(true);
                  }}
                >
                  Apply anyway…
                </Button>
              )}
              {isPending && onReject && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setShowRejectFeedback(true);
                  }}
                >
                  Reject
                </Button>
              )}
              {isPending && onDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void onDismiss(proposal.id);
                  }}
                >
                  Dismiss
                </Button>
              )}
              {proposal.resolvedBy && !isPending && (
                <Text size="xs" variant="muted">
                  by {proposal.resolvedBy}
                  {proposal.resolvedAt ? ` on ${proposal.resolvedAt}` : ''}
                </Text>
              )}
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================

function formatRelativeTime(iso: string): string {
  // `new Date(bad).getTime()` returns NaN rather than throwing, so a try/catch
  // wouldn't protect this — validate the parsed time explicitly.
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${String(min)}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${String(hrs)}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${String(days)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full-timestamp tooltip — falls back to the raw string for an unparseable date. */
function formatTimestampTooltip(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

// ============================================================================

/**
 * Renders the Coach's structured warrant (claim → evidence → expected
 * effect → risk → rollback) so operators decide on the warrant + apply
 * preview, not on rationale prose alone.
 */
function WarrantPanel({
  warrant,
}: {
  warrant: NonNullable<NonNullable<ProposalCardPayload['evidence']>['warrant']>;
}): React.ReactElement {
  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-default)',
        background: 'var(--color-surface-subtle)',
      }}
    >
      <Text size="xs" weight="semibold" variant="muted">
        Warrant
      </Text>
      <Text size="sm" weight="semibold">
        {warrant.claim}
      </Text>
      <Text size="xs">
        <Text as="span" size="xs" weight="semibold">
          Evidence:{' '}
        </Text>
        {warrant.evidenceSummary}
      </Text>
      <Text size="xs">
        <Text as="span" size="xs" weight="semibold">
          Why:{' '}
        </Text>
        {warrant.warrant}
      </Text>
      <Text size="xs">
        <Text as="span" size="xs" weight="semibold">
          Expected effect:{' '}
        </Text>
        {warrant.expectedEffect}
      </Text>
      {warrant.risk && (
        <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
          <Text as="span" size="xs" weight="semibold">
            Risk:{' '}
          </Text>
          {warrant.risk}
        </Text>
      )}
      {warrant.rollback && (
        <Text size="xs" variant="muted">
          <Text as="span" size="xs" weight="semibold">
            Rollback:{' '}
          </Text>
          {warrant.rollback}
        </Text>
      )}
    </Column>
  );
}
