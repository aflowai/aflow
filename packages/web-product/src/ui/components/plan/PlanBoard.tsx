'use client';

/**
 * One plan as a board (Plan 322 P3.3): five columns, the column is the
 * status, a card per node carrying labels only — its text lives in the rail.
 * Done folds by day from the plan's own counts, so a fold shows how many it
 * holds before its cards are read.
 */
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import type { PlanBoardColumn, PlanRootTally, PlanTreeNode } from '@aflow/schemas';
import {
  PLAN_BOARD_COLUMNS,
  phaseLabel,
  planBoardFiltered,
  planCardMatches,
  planCards,
  planDoneFolds,
  planDoneGroups,
  pullRequestLabel,
  type PlanBoardFilters,
  type PlanCard,
  type PlanDoneWindow,
} from '../../lib/plan-board.js';

const STRIP_WIDTH = '32px';

function SubtaskBar({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <Row gap="xs" align="center" data-plan-progress={`${String(done)}/${String(total)}`}>
      <div
        style={{
          width: '40px',
          height: '4px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface-2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${String(share)}%`,
            height: '100%',
            background: 'var(--color-success-default)',
          }}
        />
      </div>
      <Text size="xs" variant="muted">{`${String(done)}/${String(total)}`}</Text>
    </Row>
  );
}

function PlanCardView({
  card,
  selected,
  onSelect,
  onDecide,
}: {
  card: PlanCard;
  selected: boolean;
  onSelect: (card: PlanCard) => void;
  onDecide: (card: PlanCard) => void;
}) {
  const { node, column, phase } = card;
  const style: CSSProperties = {
    cursor: 'pointer',
    ...(column === 'decide' ? { borderLeft: '3px solid var(--color-warning-default)' } : {}),
    ...(selected
      ? { outline: '2px solid var(--color-accent-default)', outlineOffset: '-1px' }
      : {}),
  };
  const open = () => {
    onSelect(card);
  };
  return (
    <Card
      interactive
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-plan-card={node.nodeId}
      data-column={column}
      style={style}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <CardBody>
        <Column gap="xs">
          <Text
            size="sm"
            weight="medium"
            style={column === 'dropped' ? { textDecoration: 'line-through' } : undefined}
            color={column === 'dropped' ? 'muted' : 'primary'}
          >
            {node.title}
          </Text>
          <Row gap="xs" align="center" wrap>
            {phase !== undefined && <Badge variant="neutral">{phaseLabel(phase.title)}</Badge>}
            {node.counts.inFlightRuns > 0 && (
              <Badge variant="running">{`Running ${String(node.counts.inFlightRuns)}`}</Badge>
            )}
            {node.pullRequest !== undefined && (
              <Badge variant={node.pullRequest.merged ? 'success' : 'info'}>
                {pullRequestLabel(node.pullRequest.url)}
              </Badge>
            )}
            {node.rounds > 0 && <Badge variant="neutral">{`Rounds ${String(node.rounds)}`}</Badge>}
            {node.progress !== undefined && (
              <SubtaskBar done={node.progress.done} total={node.progress.total} />
            )}
          </Row>
          {column === 'decide' && node.kind === 'decide' && (
            <Row>
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  onDecide(card);
                }}
              >
                Decide
              </Button>
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

function ColumnHeader({
  label,
  color,
  count,
}: {
  label: string;
  color: string;
  /** Undefined while what it counts is still being read. */
  count: number | undefined;
}) {
  return (
    <Row gap="xs" align="center" data-plan-column-header={label}>
      <span
        aria-hidden
        style={{
          width: '8px',
          height: '8px',
          borderRadius: 'var(--radius-full)',
          background: color,
          flexShrink: 0,
        }}
      />
      <Text size="sm" weight="medium">
        {label}
      </Text>
      <Text size="xs" variant="muted">
        {count === undefined ? '…' : String(count)}
      </Text>
    </Row>
  );
}

function Dash() {
  return (
    <Text size="sm" variant="muted">
      –
    </Text>
  );
}

export interface PlanBoardProps {
  root: PlanTreeNode;
  tally: PlanRootTally;
  filters: PlanBoardFilters;
  doneWindow: PlanDoneWindow;
  /** The first day of done cards the tree on screen holds, `YYYY-MM-DD`; undefined before any read. */
  doneReadSince: string | undefined;
  /** The reader's today, `YYYY-MM-DD`. */
  today: string;
  /** The Done folds open, by id. */
  expanded: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
  selectedId: string | undefined;
  onSelect: (card: PlanCard) => void;
  onDecide: (card: PlanCard) => void;
  /** Below ~900px the columns stack, their headers as section headers. */
  narrow: boolean;
}

export function PlanBoard({
  root,
  tally,
  filters,
  doneWindow,
  doneReadSince,
  today,
  expanded,
  onToggleGroup,
  selectedId,
  onSelect,
  onDecide,
  narrow,
}: PlanBoardProps) {
  const [droppedOpen, setDroppedOpen] = useState(false);
  const cards = planCards(root).filter((card) => planCardMatches(card, filters));
  const inColumn = (column: PlanBoardColumn) => cards.filter((card) => card.column === column);
  const groups = planDoneGroups(tally.doneByDay, today, doneWindow);
  const folds = planDoneFolds(groups, inColumn('done'), planBoardFiltered(filters), doneReadSince);
  const doneCount = folds.some((fold) => fold.shown === undefined)
    ? undefined
    : folds.reduce((sum, fold) => sum + (fold.shown ?? 0), 0);
  const railOpen = selectedId !== undefined;
  const droppedStrip = railOpen && !narrow && !droppedOpen;

  const renderCard = (card: PlanCard): ReactNode => (
    <PlanCardView
      key={card.node.nodeId}
      card={card}
      selected={card.node.nodeId === selectedId}
      onSelect={onSelect}
      onDecide={onDecide}
    />
  );
  const renderCards = (list: readonly PlanCard[]): ReactNode =>
    list.length === 0 ? <Dash /> : list.map(renderCard);

  const doneBody = (): ReactNode => {
    if (folds.length === 0) return <Dash />;
    return folds.map((group) => {
      const open = expanded.has(group.id);
      return (
        <Column key={group.id} gap="xs" data-plan-done-group={group.id}>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            onClick={() => {
              onToggleGroup(group.id);
            }}
            style={{ justifyContent: 'flex-start' }}
          >
            {`${group.label} · ${group.shown === undefined ? '…' : String(group.shown)}`}
          </Button>
          {open && group.cards.map(renderCard)}
        </Column>
      );
    });
  };

  const columns = PLAN_BOARD_COLUMNS.map((column) => {
    const list = inColumn(column.id);
    const count = column.id === 'done' ? doneCount : list.length;
    if (column.id === 'dropped' && droppedStrip) {
      return (
        <button
          key={column.id}
          type="button"
          data-plan-column={column.id}
          data-collapsed="true"
          aria-label={`${column.label} ${count === undefined ? '…' : String(count)}`}
          onClick={() => {
            setDroppedOpen(true);
          }}
          style={{
            all: 'unset',
            cursor: 'pointer',
            width: STRIP_WIDTH,
            writingMode: 'vertical-rl',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            paddingBlock: 'var(--space-2)',
            borderLeft: '1px solid var(--color-border-subtle)',
          }}
        >
          <ColumnHeader label={column.label} color={column.color} count={count} />
        </button>
      );
    }
    return (
      <section
        key={column.id}
        data-plan-column={column.id}
        aria-label={column.label}
        style={{ minWidth: 0 }}
      >
        <Column gap="sm">
          <ColumnHeader label={column.label} color={column.color} count={count} />
          <Column gap="sm">{column.id === 'done' ? doneBody() : renderCards(list)}</Column>
        </Column>
      </section>
    );
  });

  if (narrow) {
    return (
      <Column gap="lg" data-plan-board={root.nodeId} data-layout="stacked">
        {columns}
      </Column>
    );
  }
  return (
    <div
      data-plan-board={root.nodeId}
      data-layout="columns"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(4, minmax(180px, 1fr)) ${droppedStrip ? STRIP_WIDTH : 'minmax(180px, 1fr)'}`,
        gap: 'var(--space-3)',
        alignItems: 'start',
        overflowX: 'auto',
      }}
    >
      {columns}
    </div>
  );
}
