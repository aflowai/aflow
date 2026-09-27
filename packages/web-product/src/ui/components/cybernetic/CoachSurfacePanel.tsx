'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  Icon,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import { useNavigation } from '../navigation-provider.js';
import { useSpace } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { ProposalCard } from './ProposalCard.js';
import {
  useCoachSurface,
  shouldShowActiveReview,
  formatSystemStatusLine,
} from '../../hooks/use-coach-surface.js';
import type {
  CoachProposalSummary,
  CoachAnomalySummary,
  CoachActionResult,
  CoachProposalDetail,
} from '../../hooks/use-coach-surface.js';
import { useActionCenter } from '../../hooks/use-action-center.js';
import type { ActionCenterResolution } from '../../hooks/use-action-center.js';
import { toCoachProposalSummary } from '../../hooks/to-coach-proposal-summary.js';

// ============================================================================
// Public API
// ============================================================================

export interface CoachSurfacePanelProps {
  spaceId: string;
  /** Optional root session — scopes the system-status footer's recent-run line. */
  rootSessionId?: string | null;
  /**
   * Layout variant. `compact` is for the indicator drill-in PeekPanel;
   * `wide` is for the Activity tab. Phase 2 ships a single layout — the
   * variant only tunes the Coach-health footer's collapsed-by-default
   * state. Use this hook in Phase 3 to differentiate further if needed.
   */
  variant?: 'compact' | 'wide';
}

// ============================================================================
// Component
// ============================================================================

export function CoachSurfacePanel({
  spaceId,
  rootSessionId,
  variant = 'compact',
}: CoachSurfacePanelProps) {
  const surface = useCoachSurface(spaceId, rootSessionId);
  const ac = useActionCenter(spaceId);
  const [actionError, setActionError] = useState<CoachActionResult | null>(null);

  const handleAction = useCallback(async (run: () => Promise<CoachActionResult>) => {
    const result = await run();
    if (!result.ok) {
      setActionError(result);
    } else {
      setActionError(null);
    }
  }, []);

  // Adapter: standard ratify/reject/dismiss now go through ac.resolve.
  // The Coach hook surface used to give us `(rawProposalId) => CoachActionResult`;
  // ac.resolve takes a prefixed AC item id + ActionCenterResolution and
  // returns ActionCenterResolveResult. This wraps the call back into
  // the CoachActionResult shape the existing `handleAction` consumes,
  // so `<ProposalsSection>` / `<PlatformIssuesSection>` props don't
  // need to change.
  const acResolveAsCoach = useCallback(
    async (
      rawProposalId: string,
      resolution: ActionCenterResolution,
    ): Promise<CoachActionResult> => {
      const itemId = `proposal:${rawProposalId}`;
      const result = await ac.resolve(itemId, resolution);
      if (result.ok) return { ok: true };
      return { ok: false, ...(result.error ? { error: result.error } : {}) };
    },
    [ac],
  );

  const ratifyProposalForceWithAcRefresh = useCallback(
    async (rawProposalId: string): Promise<CoachActionResult> => {
      const result = await surface.ratifyProposalForce(rawProposalId);
      void ac.refresh();
      return result;
    },
    [surface, ac],
  );
  const regenerateProposalWithAcRefresh = useCallback(
    async (rawProposalId: string): Promise<CoachActionResult> => {
      const result = await surface.regenerateProposal(rawProposalId);
      void ac.refresh();
      return result;
    },
    [surface, ac],
  );

  // Coach-shaped proposal lists derived from AC lanes via the pure
  // mapper. Filter to items that carry the coach_proposal extension —
  // defensive; in practice every ratification/platform_issue item from
  // coachProposalSource has one, but lanes may grow other kinds in
  // the future and the mapper throws on a missing extension.
  const proposals = useMemo(
    () =>
      ac.lanes.coachProposals
        .filter((it) => it.extension?.kind === 'coach_proposal')
        .map(toCoachProposalSummary),
    [ac.lanes.coachProposals],
  );
  const platformIssues = useMemo(
    () =>
      ac.lanes.platformIssues
        .filter((it) => it.extension?.kind === 'coach_proposal')
        .map(toCoachProposalSummary),
    [ac.lanes.platformIssues],
  );

  // Loading state — show spinner only while BOTH the AC list and the
  // Coach side (anomalies + lifecycle) are still settling AND nothing
  // is yet rendered. Either one becoming `ready` with content
  // displaces the spinner. The old gate was on `surface.proposals`
  // (now empty since the hook still owns its query but we ignore it
  // here in Phase B) so it'd have shown spinner forever post-refactor
  // until Phase C trimmed the field — using `proposals.length` from
  // the AC lane is the right load signal now.
  const isLoading =
    (surface.status === 'loading' || ac.status === 'loading') &&
    proposals.length === 0 &&
    surface.anomalies.length === 0;
  if (isLoading) {
    return (
      <Column gap="md" style={{ padding: 'var(--space-3)' }}>
        <Row gap="sm" align="center">
          <Spinner size="sm" label="Loading Coach state" />
          <Text size="sm" variant="muted">
            Loading Coach state…
          </Text>
        </Row>
      </Column>
    );
  }

  return (
    <Column gap="md" style={{ padding: 'var(--space-3)' }}>
      {actionError && (
        <Card>
          <CardBody>
            <Row gap="sm" align="center" wrap>
              <Icon name="warning" size="sm" />
              <Text size="sm" weight="semibold">
                {actionError.error ?? 'Action failed'}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActionError(null);
                }}
              >
                Dismiss
              </Button>
            </Row>
            {actionError.detail && (
              <Text size="xs" variant="muted">
                {actionError.detail}
              </Text>
            )}
          </CardBody>
        </Card>
      )}

      {(surface.status === 'error' || ac.status === 'error') &&
        (surface.lastError || ac.lastError) && (
          <Card>
            <CardBody>
              <Column gap="xs">
                <Text size="sm" weight="semibold">
                  Could not load Coach state
                </Text>
                <Text size="xs" variant="muted">
                  {surface.lastError ?? ac.lastError}
                </Text>
                <Row>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void surface.refresh();
                      void ac.refresh();
                    }}
                  >
                    Retry
                  </Button>
                </Row>
              </Column>
            </CardBody>
          </Card>
        )}

      {/* ---- 1. Active review ---- */}
      {shouldShowActiveReview(surface.lifecycle) && (
        <ActiveReviewSection
          lifecycle={surface.lifecycle}
          coachSessionId={surface.coachSessionId}
        />
      )}

      <ProposalsSection
        proposals={proposals}
        loadDetail={surface.loadProposalDetail}
        onRatify={(id) => void handleAction(() => acResolveAsCoach(id, { kind: 'ratify' }))}
        onForceRatify={(id) => void handleAction(() => ratifyProposalForceWithAcRefresh(id))}
        onRegenerate={(id) => void handleAction(() => regenerateProposalWithAcRefresh(id))}
        onReject={(id, reason) =>
          void handleAction(() =>
            acResolveAsCoach(id, reason ? { kind: 'reject', reason } : { kind: 'reject' }),
          )
        }
        spaceId={spaceId}
      />

      <PlatformIssuesSection
        issues={platformIssues}
        loadDetail={surface.loadProposalDetail}
        onDismiss={(id, reason) =>
          void handleAction(() =>
            acResolveAsCoach(id, reason ? { kind: 'dismiss', reason } : { kind: 'dismiss' }),
          )
        }
        spaceId={spaceId}
      />

      {/* ---- 4. Anomalies ---- */}
      <AnomaliesSection
        anomalies={surface.anomalies}
        onAcknowledge={(id) => void handleAction(() => surface.acknowledgeAnomaly(id))}
      />

      {/* ---- 5. System-status footer ---- */}
      <SystemStatusFooter status={surface.systemStatus} />

      {/* Variant tail — currently no-op; keeps the prop wired for Phase 3. */}
      {variant === 'wide' && <div style={{ minHeight: 8 }} />}
    </Column>
  );
}

// ============================================================================
// Section: Active review
// ============================================================================

function ActiveReviewSection({
  lifecycle,
  coachSessionId,
}: {
  lifecycle: 'reviewing' | 'stalled' | 'idle';
  coachSessionId: string | null;
}) {
  const { push } = useNavigation();
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const tone = lifecycle === 'reviewing' ? 'success' : 'warning';
  const blurb =
    lifecycle === 'reviewing'
      ? 'Coach is reviewing a completed run.'
      : 'Coach session is paused; investigate from the session page.';

  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          <Row gap="sm" align="center" wrap>
            <Icon name="stethoscope" size="sm" />
            <Heading level={5}>Active review</Heading>
            <Badge variant={tone}>{lifecycle}</Badge>
          </Row>
          <Text size="sm" variant="muted">
            {blurb}
          </Text>
          {coachSessionId && (
            <Row>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (coachSessionId) {
                    push(spaceRoute(spaceSlug, `/sessions/${coachSessionId}`));
                  }
                }}
              >
                <Icon name="arrow-square-out" size="sm" /> Watch Coach
              </Button>
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Section: Proposals (tenant_ratification)
// ============================================================================

function ProposalsSection({
  proposals,
  loadDetail,
  onRatify,
  onForceRatify,
  onRegenerate,
  onReject,
  spaceId,
}: {
  proposals: CoachProposalSummary[];
  loadDetail: (id: string) => Promise<CoachProposalDetail | null>;
  onRatify: (id: string) => void;
  onForceRatify: (id: string) => void;
  onRegenerate: (id: string) => void;
  onReject: (id: string, reason?: string) => void;
  spaceId: string;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Icon name="pencil" size="sm" />
            <Heading level={5}>Proposals</Heading>
            <Badge variant="neutral">{String(proposals.length)}</Badge>
          </Row>
          {proposals.length === 0 ? (
            <Text size="sm" variant="muted">
              No pending proposals. Coach has nothing to suggest right now.
            </Text>
          ) : (
            proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                spaceId={spaceId}
                loadDetail={loadDetail}
                onRatify={(id) => {
                  onRatify(id);
                }}
                onForceRatify={(id) => {
                  onForceRatify(id);
                }}
                onRegenerate={(id) => {
                  onRegenerate(id);
                }}
                onReject={(id, reason) => {
                  onReject(id, reason);
                }}
              />
            ))
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Section: Platform issues (read-only)
// ============================================================================

function PlatformIssuesSection({
  issues,
  loadDetail,
  onDismiss,
  spaceId,
}: {
  issues: CoachProposalSummary[];
  loadDetail: (id: string) => Promise<CoachProposalDetail | null>;
  onDismiss: (id: string, reason?: string) => void;
  spaceId: string;
}) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Icon name="warning" size="sm" />
            <Heading level={5}>Platform issues</Heading>
            <Badge variant="info">{String(issues.length)}</Badge>
            <Text size="xs" variant="muted">
              Diagnostics for the platform team — read-only here.
            </Text>
          </Row>
          {issues.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              spaceId={spaceId}
              loadDetail={loadDetail}
              onDismiss={(id) => {
                onDismiss(id);
              }}
            />
          ))}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Section: Anomalies
// ============================================================================

function AnomaliesSection({
  anomalies,
  onAcknowledge,
}: {
  anomalies: CoachAnomalySummary[];
  onAcknowledge: (id: string) => void;
}) {
  if (anomalies.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Icon name="warning" size="sm" />
            <Heading level={5}>Anomalies</Heading>
            <Badge variant="warning">{String(anomalies.length)}</Badge>
          </Row>
          {anomalies.map((a) => (
            <Column
              key={a.id}
              gap="xs"
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-subtle)',
                background: 'var(--color-surface-1)',
                minWidth: 0,
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
                textWrap: 'auto',
              }}
            >
              <Row gap="sm" align="center" wrap>
                <Badge variant={a.severity === 'critical' ? 'danger' : 'warning'}>
                  {a.severity}
                </Badge>
                <Badge variant="neutral">{a.kind}</Badge>
              </Row>
              <Text size="sm">{a.summary}</Text>
              <Row>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onAcknowledge(a.id);
                  }}
                >
                  Acknowledge
                </Button>
              </Row>
            </Column>
          ))}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================

function SystemStatusFooter({
  status,
}: {
  status: ReturnType<typeof useCoachSurface>['systemStatus'];
}) {
  const lines = formatSystemStatusLine(status);
  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderTop: '1px solid var(--color-border-subtle)',
        background: 'transparent',
      }}
    >
      <Text size="xs" variant="muted">
        {lines.helmsman}
      </Text>
      <Text size="xs" variant="muted">
        {lines.run}
      </Text>
    </Column>
  );
}

// Re-export the hook so call sites can also subscribe without the panel.
export { useCoachSurface };
