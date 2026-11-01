'use client';

/**
 * One plan as a board (Plan 322 P3.3): five columns saying what the loop is
 * doing with each step (Plan 332 D4) — Needs you with its reason, In flight,
 * Up next in the walk's order with **Next for the loop** on the step the walk
 * takes — and a card per node carrying labels only; its text lives in the
 * rail. A card reads top down: its phase, its title beside its orb (Plan 332
 * P7), where it stands (why it needs the operator, Next, runs in flight, its
 * PR), then what it has been through (review rounds, subtasks). Move up and Move down are quiet icons
 * that show on the card pointed at, focused or selected (Plan 332 P6). A
 * card's surface says where it stands, as a lane row's does. Done
 * folds by day from the plan's own counts, so a fold shows how many it holds
 * before its cards are read.
 */
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  AnimatedHeight,
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Row,
  Text,
} from '@aflow/design-system';
import type { PlanBoardColumn, PlanRootTally, PlanTreeNode } from '@aflow/schemas';
import {
  NEEDS_YOU_REASON_LABEL,
  PLAN_BOARD_COLUMNS,
  phaseLabel,
  planBoardFiltered,
  planCardMatches,
  planCards,
  planDoneFolds,
  planDoneGroups,
  planMoveTargets,
  reviewRoundsLabel,
  runsInFlightLabel,
  waitingLine,
  type PlanBoardFilters,
  type PlanCard,
} from '../../lib/plan-board.js';
import type { PlanNodeCloseAnswer } from './PlanNodeCloseControl.js';
import {
  Disclosure,
  GroupLabel,
  MetaSep,
  NextMarker,
  PlanStepOrb,
  ProgressMeter,
  PullRequestChip,
  SELECTED_RING,
  planItemSurface,
  useMoveControls,
  useReveal,
} from './PlanParts.js';

/** What the operator asks of an Up next step or an open plan: directly before or after a sibling, against the revision the page read. */
export type PlanNodePlaceRequest = { nodeId: string; expectedRevision: number } & (
  { before: string } | { after: string }
);

export type PlanNodePlacer = (request: PlanNodePlaceRequest) => Promise<PlanNodeCloseAnswer>;

const STRIP_WIDTH = '32px';

function SubtaskBar({ done, total }: { done: number; total: number }) {
  return (
    <Row gap="xs" align="center" data-plan-progress={`${String(done)}/${String(total)}`}>
      <ProgressMeter done={done} total={total} />
      <Text size="xs" variant="muted">{`${String(done)}/${String(total)} subtasks`}</Text>
    </Row>
  );
}

function PlanCardView({
  card,
  next,
  selected,
  moves,
  onSelect,
  onDecide,
  onPlace,
}: {
  card: PlanCard;
  /** For an Up next card, the open siblings it may move past. */
  moves: { above?: PlanTreeNode; below?: PlanTreeNode } | undefined;
  onPlace: PlanNodePlacer;
  /** The step the stream walk takes next for this plan. */
  next: boolean;
  selected: boolean;
  onSelect: (card: PlanCard) => void;
  onDecide: (card: PlanCard) => void;
}) {
  const { node, column, phase } = card;
  const waiting = waitingLine(node);
  const reveal = useReveal();
  const move = useMoveControls(node, moves, onPlace, reveal.shown || selected);
  const dropped = column === 'dropped';
  const running = node.counts.inFlightRuns > 0;
  const style: CSSProperties = planItemSurface({
    column,
    running,
    selected,
    hovered: reveal.hovered,
  });
  const open = () => {
    onSelect(card);
  };
  const facts: ReactNode[] = [
    ...(node.rounds > 0
      ? [
          <Text key="rounds" size="xs" variant="muted" data-plan-card-rounds>
            {reviewRoundsLabel(node.rounds)}
          </Text>,
        ]
      : []),
    ...(node.progress !== undefined
      ? [<SubtaskBar key="progress" done={node.progress.done} total={node.progress.total} />]
      : []),
  ];
  return (
    <Card
      interactive
      running={running}
      className="ds-enter-rise"
      {...reveal.hostProps}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-plan-card={node.nodeId}
      data-column={column}
      {...(card.reason !== undefined ? { 'data-reason': card.reason } : {})}
      {...(next ? { 'data-plan-next': 'true' } : {})}
      style={style}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        // A key on a control inside the card is that control's to activate.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <CardBody>
        <Column gap="xs">
          {move.controls !== null && (
            <div
              style={{ position: 'absolute', top: 'var(--space-1-5)', right: 'var(--space-1-5)' }}
            >
              {move.controls}
            </div>
          )}
          {phase !== undefined && (
            <Text size="xs" variant="muted" data-plan-card-phase>
              {phaseLabel(phase.title)}
            </Text>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-1-5)',
              ...(move.controls !== null ? { paddingRight: 'var(--space-12)' } : {}),
            }}
          >
            <span style={{ display: 'inline-flex', marginBlock: -4 }}>
              <PlanStepOrb column={column} runInFlight={node.activity === 'in_flight'} />
            </span>
            <Text
              size="sm"
              weight="medium"
              data-plan-card-title
              style={dropped ? { textDecoration: 'line-through' } : {}}
              color={dropped ? 'muted' : 'primary'}
            >
              {node.title}
            </Text>
          </div>
          {(card.reason !== undefined ||
            next ||
            node.counts.inFlightRuns > 0 ||
            node.pullRequest !== undefined) && (
            <Row gap="xs" align="center" wrap>
              {card.reason !== undefined && (
                <Badge variant="warning">{NEEDS_YOU_REASON_LABEL[card.reason]}</Badge>
              )}
              {next && <NextMarker />}
              {node.counts.inFlightRuns > 0 && (
                <Badge variant="running">{runsInFlightLabel(node.counts.inFlightRuns)}</Badge>
              )}
              {node.pullRequest !== undefined && <PullRequestChip pullRequest={node.pullRequest} />}
            </Row>
          )}
          {facts.length > 0 && (
            <Row gap="xs" align="center" wrap>
              {facts.flatMap((fact, at) =>
                at === 0 ? [fact] : [<MetaSep key={`sep-${String(at)}`} />, fact],
              )}
            </Row>
          )}
          {waiting !== undefined && (
            <Text size="xs" variant="muted" data-plan-waiting>
              {waiting}
            </Text>
          )}
          {move.error}
          {card.reason === 'decide' && (
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
  count,
}: {
  label: string;
  /** Undefined while what it counts is still being read. */
  count: number | undefined;
}) {
  return (
    <Row gap="xs" align="center" data-plan-column-header={label}>
      <GroupLabel>{label}</GroupLabel>
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
  onPlace: PlanNodePlacer;
  /** Below ~900px the columns stack, their headers as section headers. */
  narrow: boolean;
}

export function PlanBoard({
  root,
  tally,
  filters,
  doneReadSince,
  today,
  expanded,
  onToggleGroup,
  selectedId,
  onSelect,
  onDecide,
  onPlace,
  narrow,
}: PlanBoardProps) {
  const [droppedOpen, setDroppedOpen] = useState(false);
  const cards = planCards(root, tally).filter((card) => planCardMatches(card, filters));
  const inColumn = (column: PlanBoardColumn) => cards.filter((card) => card.column === column);
  const groups = planDoneGroups(tally.doneByDay, today);
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
      next={card.node.nodeId === tally.nextNodeId}
      selected={card.node.nodeId === selectedId}
      moves={card.column === 'up_next' ? planMoveTargets(root, card.node.nodeId) : undefined}
      onSelect={onSelect}
      onDecide={onDecide}
      onPlace={onPlace}
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
          <Disclosure
            expanded={open}
            onToggle={() => {
              onToggleGroup(group.id);
            }}
          >
            {`${group.label} · ${group.shown === undefined ? '…' : String(group.shown)}`}
          </Disclosure>
          {/* AnimatedHeight clips its box, so the fold widens by the ring and pads its
              cards by it: the selected card's ring then lies inside the clip. */}
          <AnimatedHeight style={{ marginInline: -SELECTED_RING }}>
            {open && (
              <Column gap="sm" style={{ padding: SELECTED_RING }}>
                {group.cards.map(renderCard)}
              </Column>
            )}
          </AnimatedHeight>
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
          <ColumnHeader label={column.label} count={count} />
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
          <ColumnHeader label={column.label} count={count} />
          {/* A column grows and shrinks as cards come and go, widened and padded by the
              ring as a Done fold is. */}
          <AnimatedHeight style={{ marginInline: -SELECTED_RING }}>
            <Column gap="sm" style={{ padding: SELECTED_RING }}>
              {column.id === 'done' ? doneBody() : renderCards(list)}
            </Column>
          </AnimatedHeight>
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
