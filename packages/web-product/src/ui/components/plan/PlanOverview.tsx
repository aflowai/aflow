'use client';

/**
 * The plan page's landing view (Plan 332 D1, D7): three lanes of one-line
 * rows across every open plan — **Needs you** with each step's reason,
 * **In flight** with the runs on it, **Up next** with the one step the loop
 * takes next per plan — each tagged with its plan. A row opens the shared
 * rail for its step; a blocked step's **Approve** sends the open write from
 * the row itself, against the revision the lanes read, so the step moves on
 * without its plan being opened. Up next carries no reorder: ordering steps
 * is the board's (D6). Each lane is headed in its column's colour and holds
 * its rows on one contained surface; a row reads plan, step, where it stands,
 * then age and action, and the selected one is filled and barred in the
 * accent as the plan list's is (Plan 332 P6).
 */
import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Column, Row, Text } from '@aflow/design-system';
import type { PlanLaneItem, PlanOverviewLanes } from '@aflow/schemas';
import { spaceRoute } from '../../lib/space-routes.js';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_BOARD_COLUMNS,
  PLAN_LANES,
  PLAN_LANE_EMPTY_CUT,
  PLAN_LANES_TRUNCATION_LINE,
  phaseLabel,
  planAge,
  planLaneCount,
  planLaneMore,
  planTag,
  runKindLabel,
  type PlanLaneId,
} from '../../lib/plan-board.js';
import type { PlanNodeOpener } from './PlanNodeOpenControl.js';
import { HeadingDot, MetaSep, NextMarker, PullRequestChip } from './PlanParts.js';

const linkStyle = { color: 'var(--color-text-link)' } as const;

/** What a row says of where its step stands, beside its title. */
function RowState({
  lane,
  item,
  spaceSlug,
}: {
  lane: PlanLaneId;
  item: PlanLaneItem;
  spaceSlug: string;
}) {
  if (lane === 'needs_you' && item.reason !== undefined) {
    return <Badge variant="warning">{NEEDS_YOU_REASON_LABEL[item.reason]}</Badge>;
  }
  if (lane === 'up_next') return <NextMarker />;
  const runs = item.runs ?? [];
  if (runs.length === 0) {
    return (
      <Text size="xs" variant="muted">
        {item.status === 'waiting'
          ? 'Its run ended; the loop advances it when it returns'
          : 'A run is on a step under it'}
      </Text>
    );
  }
  const more = (item.runsTotal ?? runs.length) - runs.length;
  return (
    <Row gap="xs" align="center" wrap>
      {runs.map((run) => (
        <Row key={run.runId} gap="xs" align="center" data-plan-lane-run={run.runId}>
          <Link
            href={spaceRoute(spaceSlug, `/runs/${encodeURIComponent(run.runId)}`)}
            style={linkStyle}
          >
            {runKindLabel(run.slug)}
          </Link>
          <Badge variant={run.status}>{run.status}</Badge>
        </Row>
      ))}
      {more > 0 && <Text size="xs" variant="muted">{`and ${String(more)} more`}</Text>}
    </Row>
  );
}

/** **Approve** on a blocked row: the open write against the revision the lanes read. */
function ApproveFromRow({ item, onOpen }: { item: PlanLaneItem; onOpen: PlanNodeOpener }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    setPending(true);
    setError(null);
    const answer = await onOpen({ nodeId: item.nodeId, expectedRevision: item.revision });
    setPending(false);
    if (!answer.ok) setError(answer.message);
  };
  return (
    <Column gap="xs" data-plan-lane-approve={item.nodeId}>
      <Button
        size="sm"
        variant="primary"
        loading={pending}
        disabled={pending}
        onClick={() => {
          void approve();
        }}
      >
        Approve
      </Button>
      {error !== null && (
        <Text size="xs" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </Column>
  );
}

/**
 * One step on a lane, in D10's order: its plan's code, then the step (its
 * phase and title), where it stands (the reason, its runs, its PR) and its
 * note, then how long since it was written and the action that answers it.
 * The whole row opens the rail; its links and its action stand above that.
 */
function LaneRow({
  lane,
  item,
  selected,
  now,
  spaceSlug,
  onSelect,
  onDecide,
  onOpen,
}: {
  lane: PlanLaneId;
  item: PlanLaneItem;
  selected: boolean;
  now: Date;
  spaceSlug: string;
  onSelect: (item: PlanLaneItem) => void;
  onDecide: (item: PlanLaneItem) => void;
  onOpen: PlanNodeOpener;
}) {
  return (
    <li
      data-plan-lane-row={item.nodeId}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      className="plan-selectable plan-lane-row"
    >
      <Text size="xs" variant="mono" className="plan-lane-row__plan" data-plan-lane-plan>
        {planTag(item.rootTitle)}
      </Text>
      <div className="plan-lane-row__main">
        <button
          type="button"
          className="plan-lane-row__select"
          aria-pressed={selected}
          onClick={() => {
            onSelect(item);
          }}
        >
          {item.phaseTitle !== undefined && (
            <>
              <Text size="xs" variant="muted" data-plan-lane-phase>
                {phaseLabel(item.phaseTitle)}
              </Text>
              <MetaSep />
            </>
          )}
          <Text size="sm" weight={selected ? 'semibold' : 'medium'} className="plan-row__title">
            {item.title}
          </Text>
        </button>
        <div className="plan-row__meta">
          <RowState lane={lane} item={item} spaceSlug={spaceSlug} />
          {item.pullRequest !== undefined && <PullRequestChip pullRequest={item.pullRequest} />}
        </div>
        {item.noteHead !== undefined && (
          <Text size="xs" variant="muted" className="plan-lane-row__note" data-plan-lane-note>
            {item.noteHead}
          </Text>
        )}
      </div>
      <span className="plan-lane-row__actions">
        <Text size="xs" variant="muted" data-plan-lane-age>
          {planAge(item.updatedAt, now)}
        </Text>
        {lane === 'needs_you' && item.reason === 'blocked' && (
          // Keyed by revision: a row read again at a new revision starts afresh.
          <ApproveFromRow
            key={`${item.nodeId}:${String(item.revision)}`}
            item={item}
            onOpen={onOpen}
          />
        )}
        {lane === 'needs_you' && item.reason === 'decide' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onDecide(item);
            }}
          >
            Decide
          </Button>
        )}
      </span>
    </li>
  );
}

export interface PlanOverviewProps {
  lanes: PlanOverviewLanes;
  /** The step whose rail is open, where a lane holds it. */
  selectedId: string | undefined;
  now: Date;
  spaceSlug: string;
  onSelect: (item: PlanLaneItem) => void;
  /** A decision's **Decide**: the rail, its decide form open. */
  onDecide: (item: PlanLaneItem) => void;
  onOpen: PlanNodeOpener;
}

export function PlanOverview({
  lanes,
  selectedId,
  now,
  spaceSlug,
  onSelect,
  onDecide,
  onOpen,
}: PlanOverviewProps) {
  return (
    <Column gap="lg" data-plan-overview>
      {PLAN_LANES.map(({ id, key, label, empty }) => {
        const lane = lanes[key];
        const more = planLaneMore(lane);
        const color = PLAN_BOARD_COLUMNS.find((column) => column.id === id)?.color;
        return (
          <Column key={id} gap="sm" data-plan-lane={id}>
            <Row gap="xs" align="center">
              {color !== undefined && <HeadingDot color={color} />}
              <Text size="sm" weight="medium">{`${label} · ${planLaneCount(lane, lanes)}`}</Text>
            </Row>
            {lane.items.length === 0 ? (
              <Text size="sm" variant="muted" style={{ paddingLeft: 'var(--space-4)' }}>
                {lanes.truncated !== undefined ? PLAN_LANE_EMPTY_CUT : empty}
              </Text>
            ) : (
              <ul className="plan-lane-list" aria-label={label}>
                {lane.items.map((item) => (
                  <LaneRow
                    key={item.nodeId}
                    lane={id}
                    item={item}
                    selected={item.nodeId === selectedId}
                    now={now}
                    spaceSlug={spaceSlug}
                    onSelect={onSelect}
                    onDecide={onDecide}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            )}
            {more !== undefined && (
              <Text
                size="xs"
                variant="muted"
                style={{ paddingLeft: 'var(--space-4)' }}
                data-plan-lane-more
              >
                {more}
              </Text>
            )}
          </Column>
        );
      })}
      {lanes.truncated !== undefined && (
        <Text size="xs" variant="muted" data-plan-lanes-truncated>
          {PLAN_LANES_TRUNCATION_LINE[lanes.truncated.bound](lanes.truncated.value)}
        </Text>
      )}
    </Column>
  );
}
