'use client';

import { Badge, Column, Row, Text } from '@aflow/design-system';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { useCoachSurface } from '../../hooks/use-coach-surface.js';
import { ActionCenterItemCard } from '../actionCenter/ActionCenterLane.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { WorkbenchLink, WorkbenchSection } from './WorkbenchSection.js';

/**
 * Coach (Plan 228 §3.2b). Coach is a background reviewer — it watches skill
 * runs and proposes improvements; it never chats and only triggers
 * conditionally. So it gets its own quiet, self-explaining section rather than
 * being mixed into Helmsman or the blocking needs-attention lane. It shows a
 * light lifecycle status (reviewing / stalled) and a **review queue** of
 * proposals to ratify/reject — rendered `accent`, not `warning`, to read as
 * "review when you can", not "blocking". Hidden when Coach is idle with
 * nothing to review.
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
  const proposals = state.lanes.coachProposals;
  const active = coach.lifecycle !== 'idle';

  if (proposals.length === 0 && !active) return null;

  return (
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
        <Column gap="sm">
          {proposals.map((item) => (
            <ActionCenterItemCard
              key={item.id}
              item={item}
              state={state}
              onNavigate={(t) => {
                if (t.type === 'workflow') {
                  window.open(
                    spaceRoute(spaceSlug, `/skills/${encodeURIComponent(t.id)}`),
                    '_blank',
                  );
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
      ) : (
        <Text size="sm" variant="muted">
          Watching — no proposals to review right now.
        </Text>
      )}
    </WorkbenchSection>
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
