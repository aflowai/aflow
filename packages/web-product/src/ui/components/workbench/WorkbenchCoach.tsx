'use client';

import { Badge, Column, Row, Text } from '@aflow/design-system';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { useCoachSurface } from '../../hooks/use-coach-surface.js';
import { ActionCenterItemCard } from '../actionCenter/ActionCenterLane.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { groupBySource } from '../../lib/proposal-provenance.js';
import { WorkbenchLink, WorkbenchSection, useWorkbenchSectionFold } from './WorkbenchSection.js';

/**
 * Coach (Plan 228 §3.2b), and the proposals other sources made beside it.
 * Coach is a background reviewer — it watches skill runs and proposes
 * improvements; it never chats and only triggers conditionally. So it gets its own quiet, self-explaining section rather than
 * being mixed into Helmsman or the blocking needs-attention lane. It shows a
 * light lifecycle status (reviewing / stalled) and a **review queue** of
 * proposals to ratify/reject — rendered `accent`, not `warning`, to read as
 * "review when you can", not "blocking". Outside a fold it is hidden when
 * Coach is idle with nothing to review. Under a fold (the Workbench mounts it
 * only on expand, Plan 338 D3) it always renders, because the operator asked.
 * Every proposal sits under its Source line: a Coach review here, any other
 * source under a heading of its own (`WorkbenchProposalSources`).
 */
export function WorkbenchCoach({
  state,
  spaceId,
  spaceSlug,
}: {
  state: UseActionCenterResult;
  spaceId: string;
  spaceSlug: string;
}) {
  const coach = useCoachSurface(spaceId);
  const fold = useWorkbenchSectionFold();
  const proposals = coachReviewProposals(state);
  const active = coach.lifecycle !== 'idle';

  return (
    <>
      {(proposals.length > 0 || active || fold) && (
        <WorkbenchSection
          title={COACH_REVIEW}
          icon="stethoscope"
          meta={
            proposals.length > 0 ? <Badge variant="accent">{String(proposals.length)}</Badge> : null
          }
          trailing={
            <CoachStatus
              lifecycle={coach.lifecycle}
              coachSessionId={coach.coachSessionId}
              spaceSlug={spaceSlug}
            />
          }
        >
          <Text size="xs" variant="muted">
            Reviews your skill runs and proposes improvements — ratify or reject.
          </Text>
          {proposals.length > 0 ? (
            <ProposalItems items={proposals} state={state} spaceSlug={spaceSlug} />
          ) : (
            <Text size="sm" variant="muted">
              {active
                ? 'Watching — no proposals to review right now.'
                : 'Idle — no proposals to review.'}
            </Text>
          )}
        </WorkbenchSection>
      )}
    </>
  );
}

/** The Coach's own proposals, which the folded Coach header counts without a read. */
export function coachReviewProposals(state: UseActionCenterResult): ActionCenterItem[] {
  return (
    groupBySource(state.lanes.coachProposals, proposalHeading).find(
      (group) => group.heading === COACH_REVIEW,
    )?.items ?? []
  );
}

/**
 * Proposals from every source other than the Coach, each under its Source
 * line. They come from the Action Center the board already holds, so they
 * render without a fold.
 */
export function WorkbenchProposalSources({
  state,
  spaceSlug,
}: {
  state: UseActionCenterResult;
  spaceSlug: string;
}) {
  const otherSources = groupBySource(state.lanes.coachProposals, proposalHeading).filter(
    (group) => group.heading !== COACH_REVIEW,
  );
  return (
    <>
      {otherSources.map((group) => (
        <WorkbenchSection
          key={group.heading}
          title={group.heading}
          icon="pencil"
          meta={<Badge variant="accent">{String(group.items.length)}</Badge>}
        >
          <ProposalItems items={group.items} state={state} spaceSlug={spaceSlug} />
        </WorkbenchSection>
      ))}
    </>
  );
}

export const COACH_REVIEW = 'Coach review';

/** The section a proposal sits under: its Source line. */
function proposalHeading(item: ActionCenterItem): string {
  return item.extension?.kind === 'coach_proposal'
    ? item.extension.provenance.sourceLabel
    : item.requestedBy.label;
}

function ProposalItems({
  items,
  state,
  spaceSlug,
}: {
  items: ActionCenterItem[];
  state: UseActionCenterResult;
  spaceSlug: string;
}) {
  return (
    <Column gap="sm">
      {items.map((item) => (
        <ActionCenterItemCard
          key={item.id}
          item={item}
          state={state}
          onNavigate={(t) => {
            if (t.type === 'workflow') {
              window.open(spaceRoute(spaceSlug, `/skills/${encodeURIComponent(t.id)}`), '_blank');
            } else if (t.type === 'session') {
              window.open(
                spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(t.id)}`),
                '_blank',
              );
            }
          }}
        />
      ))}
    </Column>
  );
}

function CoachStatus({
  lifecycle,
  coachSessionId,
  spaceSlug,
}: {
  lifecycle: 'reviewing' | 'stalled' | 'idle';
  coachSessionId: string | null;
  spaceSlug: string;
}) {
  if (lifecycle === 'idle') return null;
  const reviewing = lifecycle === 'reviewing';
  return (
    <Row gap="xs" align="center">
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: reviewing ? 'var(--color-success-default)' : 'var(--color-warning-default)',
        }}
      />
      <Text size="xs" variant="muted">
        {reviewing ? 'Reviewing' : 'Stalled'}
      </Text>
      {coachSessionId && (
        <WorkbenchLink
          href={spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(coachSessionId)}`)}
          label="Watch"
        />
      )}
    </Row>
  );
}
