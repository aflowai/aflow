'use client';

import { Badge, Column, Row, Text } from '@aflow/design-system';
import { PLAN_STATE_LABELS, type PlanLaneItem, type PlanOverviewOutput } from '@aflow/schemas';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { usePlanLiveRefresh } from '../../hooks/use-plan-live-refresh.js';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_LANES,
  PLAN_LANE_EMPTY_CUT,
  planLaneCount,
  planLaneMore,
  planTag,
  planViewQuery,
  type PlanLaneId,
} from '../../lib/plan-board.js';
import type { PlanPendingCount } from '../../lib/plan-pending-count.js';
import { spaceRoute } from '../../lib/space-routes.js';
import {
  WorkbenchSection,
  WorkbenchSectionPending,
  useWorkbenchSectionHeld,
} from './WorkbenchSection.js';

export const WORKBENCH_PLAN = 'Plan';

/** The lanes the Workbench lists: the steps pending on the operator, then the steps in flight. */
const WORKBENCH_PLAN_LANES = PLAN_LANES.filter(
  (lane) => lane.id === 'needs_you' || lane.id === 'in_flight',
);

/** The plan board, which the Plan header links to folded and open. */
export function planBoardLink(spaceSlug: string): { href: string; label: string } {
  return { href: spaceRoute(spaceSlug, '/plan'), label: 'Board' };
}

/** Where a step opens on the plan page: its plan's board with the step's rail open. */
export function planStepHref(spaceSlug: string, item: Pick<PlanLaneItem, 'rootId' | 'nodeId'>) {
  return spaceRoute(
    spaceSlug,
    `/plan?${planViewQuery('', { plan: item.rootId, node: item.nodeId })}`,
  );
}

/**
 * The folded Plan header's count: the plan steps waiting on a person, from
 * the Action Center the board already holds, as the sidebar's Plan entry
 * counts them. It needs no read of its own.
 */
export function FoldedPlanPendingCount({ pending }: { pending: PlanPendingCount }) {
  if (pending.count === 0) return null;
  return (
    <Badge variant="warning" title={`${pending.label} ${PLAN_STATE_LABELS.pendingCountNoun}`}>
      {pending.label}
    </Badge>
  );
}

/**
 * Plan: the steps pending on the operator and the steps in flight across
 * every open plan, each by its title with a link to it on the plan page. It
 * reads the overview the plan page reads, under the same key, and only once
 * the operator expands it. Queued steps are left to the board, because
 * nothing about them waits on anyone.
 */
export function WorkbenchPlan({
  spaceId,
  spaceSlug,
  pending,
}: {
  spaceId: string;
  spaceSlug: string;
  pending: PlanPendingCount;
}) {
  const query = useApiQuery<PlanOverviewOutput>({
    key: ['space', spaceId, 'plan', 'rows'],
    path: `/spaces/${spaceId}/plan`,
    enabled: spaceId.length > 0,
  });
  usePlanLiveRefresh(spaceId.length > 0 ? spaceId : null);
  const lanes = query.data?.lanes;
  useWorkbenchSectionHeld(
    lanes !== undefined && WORKBENCH_PLAN_LANES.some(({ key }) => lanes[key].items.length > 0),
  );

  if (!lanes) {
    return query.isLoading ? (
      <WorkbenchSectionPending title={WORKBENCH_PLAN} icon="flag" />
    ) : (
      <WorkbenchSection
        title={WORKBENCH_PLAN}
        icon="flag"
        meta={<FoldedPlanPendingCount pending={pending} />}
        link={planBoardLink(spaceSlug)}
      >
        <Text size="sm" variant="muted">
          The plan could not be read.
        </Text>
      </WorkbenchSection>
    );
  }

  return (
    <WorkbenchSection
      title={WORKBENCH_PLAN}
      icon="flag"
      meta={<FoldedPlanPendingCount pending={pending} />}
      link={planBoardLink(spaceSlug)}
    >
      <Column gap="md">
        {WORKBENCH_PLAN_LANES.map(({ id, key, label, empty }) => {
          const lane = lanes[key];
          const more = planLaneMore(lane);
          return (
            <Column key={id} gap="xs" data-workbench-plan-lane={id}>
              <Text size="xs" variant="muted" weight="medium">
                {`${label} · ${planLaneCount(lane, lanes)}`}
              </Text>
              {lane.items.length === 0 ? (
                <Text size="sm" variant="muted">
                  {lanes.truncated !== undefined ? PLAN_LANE_EMPTY_CUT : empty}
                </Text>
              ) : (
                lane.items.map((item) => (
                  <PlanStepRow key={item.nodeId} lane={id} item={item} spaceSlug={spaceSlug} />
                ))
              )}
              {more !== undefined && (
                <Text size="xs" variant="muted">
                  {more}
                </Text>
              )}
            </Column>
          );
        })}
      </Column>
    </WorkbenchSection>
  );
}

/** One step: its plan's tag, its title as a link to it on the plan page, and why it waits where it does. */
function PlanStepRow({
  lane,
  item,
  spaceSlug,
}: {
  lane: PlanLaneId;
  item: PlanLaneItem;
  spaceSlug: string;
}) {
  return (
    <Row gap="xs" align="center" data-workbench-plan-step={item.nodeId} style={{ minWidth: 0 }}>
      <Text size="xs" variant="mono" style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}>
        {planTag(item.rootTitle)}
      </Text>
      {/* A side trip, so a new tab, as every other link on the board. */}
      <a
        href={planStepHref(spaceSlug, item)}
        target="_blank"
        rel="noreferrer"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-text-primary)',
        }}
      >
        {item.title}
      </a>
      {lane === 'needs_you' && item.reason !== undefined && (
        <Badge variant="warning">{NEEDS_YOU_REASON_LABEL[item.reason]}</Badge>
      )}
    </Row>
  );
}
