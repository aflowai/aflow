'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Badge,
  Card,
  CardBody,
  Column,
  HitlResolution,
  type HitlResolutionItem,
  type HitlResolutionPayload,
  Icon,
  Row,
  Text,
} from '@aflow/design-system';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { useSpace } from '../providers.js';
import { useActionCenter } from '../../hooks/use-action-center.js';
import type { InlineHitlPayload } from '@aflow/run-view';

export interface HitlInlineProps {
  payload: InlineHitlPayload;
}

function buildOptimisticResolution(
  hitlKind: InlineHitlPayload['hitlKind'],
  resolution: HitlResolutionPayload,
): NonNullable<InlineHitlPayload['resolution']> {
  const now = new Date().toISOString();
  if (resolution.kind === 'submit') {
    return { kind: 'input', value: resolution.payload, providedAt: now };
  }
  if (resolution.kind === 'approve') {
    return {
      kind: 'approval',
      decision: 'approved',
      ...(resolution.comment ? { comment: resolution.comment } : {}),
      decidedAt: now,
    };
  }
  if (resolution.kind === 'reject') {
    return {
      kind: 'approval',
      decision: 'rejected',
      ...(resolution.reason ? { comment: resolution.reason } : {}),
      decidedAt: now,
    };
  }
  return hitlKind === 'human_approval'
    ? { kind: 'approval', decision: 'approved', decidedAt: now }
    : { kind: 'input', value: undefined, providedAt: now };
}

export function HitlInline({ payload }: HitlInlineProps) {
  const { activeSpaceId } = useSpace();
  const { items, resolve, refresh } = useActionCenter(activeSpaceId ?? null);
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  // Optimistic resolved state — set immediately on successful POST so the
  // card flips to the resolved view without waiting for the SSE round-trip.
  const [localResolved, setLocalResolved] = useState(false);
  const [localResolution, setLocalResolution] = useState<NonNullable<
    InlineHitlPayload['resolution']
  > | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(payload.status !== 'resolved');

  // The card is resolved either by SSE (payload.status === 'resolved') or by
  // a successful POST from this component (localResolved).
  const isResolved = payload.status === 'resolved' || localResolved;
  // Prefer the SSE-authoritative resolution once it arrives; fall back to
  // the local optimistic one until then.
  const effectiveResolution = payload.resolution ?? localResolution ?? undefined;

  useEffect(() => {
    if (isResolved) setDetailsExpanded(false);
  }, [isResolved]);

  const onResolve = useCallback(
    async (resolution: HitlResolutionPayload): Promise<void> => {
      if (!activeSpaceId) {
        setSubmitState('error');
        setErrorMessage('No active space — cannot submit.');
        return;
      }
      setSubmitState('submitting');
      setErrorMessage(undefined);
      try {
        // Resolving is compare-and-set against the item's `origin`, which
        // carries a server-derived pause token. Only the Action Center list
        // holds it, so the resolve goes through the shared path rather than
        // this card reconstructing an origin from the session event it was
        // rendered from.
        if (!items.some((it) => it.id === payload.itemId)) {
          await refresh();
        }
        const result = await resolve(payload.itemId, resolution);
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to submit.');
        }
        // Flip to resolved immediately — don't wait for the SSE round-trip.
        setLocalResolution(buildOptimisticResolution(payload.hitlKind, resolution));
        setLocalResolved(true);
        setDetailsExpanded(false);
        setSubmitState('idle');
      } catch (err) {
        setSubmitState('error');
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [activeSpaceId, items, refresh, resolve, payload.itemId, payload.hitlKind],
  );

  // Markdown body + structured `reviewData` table. Wrapped in a disclosure so
  // resolved cards do not keep long proposal text expanded in the chat log.
  const detailsContent = (
    <Column gap="sm">
      <div
        className="hitl-inline-markdown"
        style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--font-size-sm) !important' }}
      >
        <MarkdownRenderer content={payload.body} />
      </div>
      {payload.reviewData !== undefined && <ReviewDataView data={payload.reviewData} />}
    </Column>
  );

  const detailsSlot = (
    <CollapsibleDetails
      expanded={detailsExpanded}
      onToggle={() => {
        setDetailsExpanded((v) => !v);
      }}
      label={isResolved ? 'Decision details' : 'Request details'}
    >
      {detailsContent}
    </CollapsibleDetails>
  );

  // ----- resolved state — read-only audit record ----------------------
  if (isResolved) {
    return (
      <Card>
        <CardBody>
          <Column gap="md">
            {payload.title && (
              <Text size="base" weight="semibold">
                {payload.title}
              </Text>
            )}
            <ResolvedSummary resolution={effectiveResolution} hitlKind={payload.hitlKind} />
            {payload.hitlKind === 'human_input' &&
              effectiveResolution?.kind === 'input' &&
              effectiveResolution.value !== undefined && (
                <ResponseReadback value={effectiveResolution.value} />
              )}
            {detailsSlot}
          </Column>
        </CardBody>
      </Card>
    );
  }

  // ----- open state — active controls ----------------------------------
  // `summary` is intentionally empty: the design-system `<HitlResolution>`
  // renders it as a plain-text line under the title, which would surface
  // the raw Markdown source (the bug the user flagged). The Markdown-
  // rendered body lives in `bodySlot` immediately above the controls.
  const item: HitlResolutionItem = {
    id: payload.itemId,
    kind: payload.hitlKind,
    title: payload.title ?? (payload.hitlKind === 'human_approval' ? 'Approval' : 'Input'),
    summary: '',
    ...(payload.inputSchema ? { resolutionSchema: payload.inputSchema } : {}),
    ...(payload.uiHints ? { uiHints: payload.uiHints } : {}),
    allowedActions:
      payload.hitlKind === 'human_approval'
        ? (['approve', 'reject'] as const)
        : (['submit'] as const),
  };

  return (
    <HitlResolution
      item={item}
      onResolve={onResolve}
      state={submitState}
      bodySlot={detailsSlot}
      controlsStyle={{ marginTop: 'var(--space-3)' }}
      {...(errorMessage ? { errorMessage } : {})}
    />
  );
}

// ============================================================================
// CollapsibleDetails — compact long proposal / request bodies in chat.
// ============================================================================

function CollapsibleDetails({
  expanded,
  onToggle,
  label,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <Column gap="sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: 'var(--space-1) var(--space-2)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-surface-1, transparent)',
          color: 'var(--color-text-muted, var(--color-content-muted))',
          fontSize: 'var(--font-size-xs)',
          cursor: 'pointer',
        }}
      >
        <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" />
        <span>
          {expanded ? 'Hide' : 'Show'} {label.toLowerCase()}
        </span>
      </button>
      {expanded && children}
    </Column>
  );
}

// ============================================================================
// ReviewData — primitive key/value object → table; otherwise JSON code block.
// ============================================================================

function ReviewDataView({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;

  // Strings render as Markdown so reviewData can carry a Markdown blob.
  if (typeof data === 'string') {
    return (
      <div className="hitl-inline-markdown">
        <MarkdownRenderer content={data} />
      </div>
    );
  }

  // Flat object of primitives → key/value table — easier to scan than JSON.
  if (typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    const allPrimitive = entries.every(
      ([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
    if (allPrimitive && entries.length > 0) {
      return (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 'var(--font-size-xs)',
            background: 'var(--color-surface-1, transparent)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <th
                  scope="row"
                  style={{
                    textAlign: 'left',
                    padding: 'var(--space-2) var(--space-3)',
                    fontWeight: 'var(--font-weight-medium)',
                    color: 'var(--color-text-muted, var(--color-content-muted))',
                    width: '40%',
                    verticalAlign: 'top',
                  }}
                >
                  {k}
                </th>
                <td
                  style={{
                    padding: 'var(--space-2) var(--space-3)',
                    wordBreak: 'break-word',
                  }}
                >
                  {v === null ? (
                    <em style={{ opacity: 0.6 }}>null</em>
                  ) : (
                    // The `allPrimitive` filter above narrows `v` to
                    // string | number | boolean. Pin the cast so
                    // `String(v)` doesn't pick up Object's
                    // `[object Object]` toString fallback (eslint hint).
                    String(v as string | number | boolean)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }

  // Fallback — nested / arrays / mixed shapes → preformatted JSON.
  return (
    <pre
      style={{
        margin: 0,
        padding: 'var(--space-3)',
        background: 'var(--color-surface-1, transparent)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-xs)',
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

// ============================================================================
// ResolvedSummary — uses design-system icons (not Unicode emoji).
// ============================================================================

function ResolvedSummary({
  resolution,
  hitlKind,
}: {
  resolution: InlineHitlPayload['resolution'];
  hitlKind: InlineHitlPayload['hitlKind'];
}) {
  if (!resolution) {
    return (
      <Badge variant="neutral">{hitlKind === 'human_approval' ? 'Decided' : 'Responded'}</Badge>
    );
  }
  if (resolution.kind === 'approval') {
    const isApproved = resolution.decision === 'approved';
    return (
      <Row gap="sm" align="center" wrap>
        <Badge variant={isApproved ? 'success' : 'danger'}>
          <Row gap="xs" align="center">
            <Icon name={isApproved ? 'check' : 'x'} size="sm" />
            <span>{isApproved ? 'Approved' : 'Rejected'}</span>
          </Row>
        </Badge>
        {resolution.decidedBy && (
          <Text size="xs" variant="muted">
            by {resolution.decidedBy}
          </Text>
        )}
        <Text size="xs" variant="muted">
          {formatTimestamp(resolution.decidedAt)}
        </Text>
        {resolution.comment && (
          <Text size="xs" variant="muted">
            — {resolution.comment}
          </Text>
        )}
      </Row>
    );
  }
  return (
    <Row gap="sm" align="center" wrap>
      <Badge variant="success">
        <Row gap="xs" align="center">
          <Icon name="check" size="sm" />
          <span>Responded</span>
        </Row>
      </Badge>
      {resolution.providedBy && (
        <Text size="xs" variant="muted">
          by {resolution.providedBy}
        </Text>
      )}
      <Text size="xs" variant="muted">
        {formatTimestamp(resolution.providedAt)}
      </Text>
      {/*
       * The response value used to render here as muted trailing text
       * ("— value"). That made it easy to miss and forced operators
       * into the tool-response collapsible to see what they had
       * typed. Moved out to `<ResponseReadback>` in the resolved-
       * state container above — prominent, single source.
       */}
    </Row>
  );
}

// ============================================================================
// ResponseReadback — prominent block for the operator's typed answer.
// ============================================================================

/**
 * Renders the operator's response from a resolved `input`-kind HITL
 * card. Strings get the Markdown renderer (input often comes in as
 * plain text but may carry simple formatting); non-string values fall
 * back to a JSON code block.
 *
 * The card already shows the question via `bodySlot`; this is the
 * answer. Together they form the question/answer record without the
 * operator needing to expand the tool-response entry below the card.
 */
function ResponseReadback({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return (
      <Column gap="xs">
        <Text size="xs" variant="muted" weight="medium">
          Response
        </Text>
        <div
          style={{
            padding: 'var(--space-3)',
            background: 'var(--color-surface-1, transparent)',
            borderRadius: 'var(--radius-sm)',
            borderLeft: '3px solid var(--color-success-default, var(--color-border-subtle))',
          }}
        >
          <MarkdownRenderer content={value} />
        </div>
      </Column>
    );
  }
  return (
    <Column gap="xs">
      <Text size="xs" variant="muted" weight="medium">
        Response
      </Text>
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-3)',
          background: 'var(--color-surface-1, transparent)',
          borderRadius: 'var(--radius-sm)',
          borderLeft: '3px solid var(--color-success-default, var(--color-border-subtle))',
          fontSize: 'var(--font-size-xs)',
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </Column>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
