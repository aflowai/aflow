'use client';

import { Badge, Column, Row, Text } from '@aflow/design-system';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { useCoachSurface } from '../../hooks/use-coach-surface.js';
import { ActionCenterItemCard } from '../actionCenter/ActionCenterLane.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { groupBySource } from '../../lib/proposal-provenance.js';
import { WorkbenchLink, WorkbenchSection } from './WorkbenchSection.js';

/**
 * Coach (Plan 228 §3.2b), and the proposals other sources made beside it.
 * Coach is a background reviewer — it watches skill runs and proposes
 * improvements; it never chats and only triggers conditionally. So it gets its own quiet, self-explaining section rather than
 * being mixed into Helmsman or the blocking needs-attention lane. It shows a
 * light lifecycle status (reviewing / stalled) and a **review queue** of
 * proposals to ratify/reject — rendered `accent`, not `warning`, to read as
 * "review when you can", not "blocking". Hidden when Coach is idle with
 * nothing to review. A proposal an agent patched or a request composed sits
 * under a heading naming its source, never under the Coach.
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
  const proposals = state.lanes.coachProposals.filter(isCoachReview);
  const otherSources = groupBySource(
    state.lanes.coachProposals.filter((item) => !isCoachReview(item)),
    (item) => item.requestedBy.label,
  );
  const active = coach.lifecycle !== 'idle';

  return (
    <>
      {(proposals.length > 0 || active) && (
        <WorkbenchSection
          title="Coach"
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
              Watching — no proposals to review right now.
            </Text>
          )}
        </WorkbenchSection>
      )}
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

/** A Coach review stays under the Coach. Any other source gets a section of its own. */
function isCoachReview(item: ActionCenterItem): boolean {
  return item.extension?.kind === 'coach_proposal'
    ? item.extension.provenance.source === 'coach'
    : item.requestedBy.kind === 'coach';
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
