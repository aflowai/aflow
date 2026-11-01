'use client';

/**
 * The space's plans as a list (Plan 332 D2), below **Overview**, which returns
 * to the lanes across every plan (D1): open plans in position order —
 * the order the loop takes them, which dragging a row changes — each with its
 * state, its progress and its non-zero counts of steps needing the operator
 * and in flight; then **Finished**, open plans whose every step is closed,
 * each with a quiet **Close plan**; then **Closed**, folded. Each row stands
 * on a surface that says its state, as a lane row does, and the selected one
 * is ringed and scrolls into view. The list fills the page's left pane, as the
 * skill designer's outline does. Below 900px it is a disclosure above the
 * content.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Button,
  Column,
  DropIndicator,
  Icon,
  Panel,
  Row,
  Text,
  Textarea,
  type BadgeVariant,
  type DragReorderItemProps,
  type DropSide,
} from '@aflow/design-system';
import type { PlanNodeDetailOutput, PlanRootRow, PlanRootState } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import {
  PLAN_STATE_LABEL,
  planCountNoun,
  planListSections,
  planRowMoveTargets,
  planRowProgress,
} from '../../lib/plan-board.js';
import type { PlanNodePlacer } from './PlanBoard.js';
import { isClosedStatus, usePinnedNode, type PlanNodeCloser } from './PlanNodeCloseControl.js';
import {
  Disclosure,
  GroupLabel,
  ItemsBody,
  MetaSep,
  PLAN_ITEM_GAP,
  PLAN_ORB_SIZE,
  PlanStateOrb,
  ProgressMeter,
  planItemSurface,
  planRootTone,
  srOnly,
  useHover,
  usePlanReorder,
  type PlanReorderItem,
} from './PlanParts.js';
import { freshRead, planNodePath } from './PlanRail.js';

export const PLAN_STATE_BADGE: Record<PlanRootState, BadgeVariant> = {
  needs_you: 'warning',
  in_flight: 'running',
  queued: 'accent',
  finished: 'success',
  closed: 'neutral',
  empty: 'neutral',
};

/** A row whose steps the list's read did not all count: its board counts them on its own. */
const PLAN_ROW_TRUNCATION_LINE: Record<'limit' | 'depth' | 'nodes', (value: number) => string> = {
  limit: (value) => `Counted short: the first ${String(value)} steps`,
  depth: (value) => `Counted short: steps deeper than ${String(value)} levels left out`,
  nodes: (value) => `Counted short: the list counts ${String(value)} steps across its plans`,
};

/**
 * The form behind **Close plan**: the existing close write on the root, done
 * with how its criteria were met. It reads the root fresh when it opens and
 * writes against the revision that read showed, as the rail's close form does,
 * so a plan written since is refused rather than closed over.
 */
function PlanRootCloseForm({
  rootId,
  spaceId,
  onClose,
  onDone,
}: {
  rootId: string;
  spaceId: string;
  onClose: PlanNodeCloser;
  onDone: () => void;
}) {
  const detail = useApiQuery<PlanNodeDetailOutput>({
    key: ['space', spaceId, 'plan', 'node', rootId, 'head'],
    path: planNodePath(spaceId, rootId, 'limit=1'),
    staleTime: 0,
  });
  const read = freshRead(detail);
  const { shown, movedSinceOpened, setPinned } = usePinnedNode(read, true);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outcome = text.trim();
  const closedNow =
    read.node !== undefined && isClosedStatus(read.node.status) ? read.node.status : undefined;

  const submit = async () => {
    if (!shown) return;
    setPending(true);
    setError(null);
    const answer = await onClose({
      nodeId: rootId,
      expectedRevision: shown.revision,
      status: 'done',
      outcome,
    });
    setPending(false);
    if (answer.ok) {
      onDone();
    } else {
      setError(answer.message);
      setPinned(await read.refetch());
    }
  };

  return (
    <Column gap="xs" data-plan-close-root={rootId}>
      {shown === undefined && read.error === null && (
        <Text size="sm" variant="muted">
          Reading the plan…
        </Text>
      )}
      {read.error !== null && (
        <Text size="sm" tone="danger" role="alert">
          {`This plan could not be read: ${read.error.message}`}
        </Text>
      )}
      {movedSinceOpened && (
        <Text size="xs" variant="muted" data-plan-close-moved>
          This plan changed since this form opened; a write now is refused and shows it as it
          stands.
        </Text>
      )}
      {shown !== undefined && (
        <Text size="xs" variant="muted" style={{ whiteSpace: 'pre-wrap' }}>
          {`Done when: ${shown.criteria}`}
        </Text>
      )}
      {closedNow !== undefined && (
        <Text size="sm" tone="danger" role="alert">
          {`This plan is ${closedNow} now.`}
        </Text>
      )}
      <Textarea
        aria-label="How the plan’s criteria were met"
        placeholder="How the plan’s criteria were met"
        value={text}
        rows={3}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {error !== null && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
      <Row gap="xs" align="center">
        <Button
          size="sm"
          variant="primary"
          loading={pending}
          disabled={pending || shown === undefined || closedNow !== undefined || outcome === ''}
          onClick={() => {
            void submit();
          }}
        >
          Close plan
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </Row>
    </Column>
  );
}

/** **Close plan** on a finished plan: the form opens, and reads the root, only when asked. */
export function PlanRootCloseControl({
  rootId,
  spaceId,
  onClose,
}: {
  rootId: string;
  spaceId: string;
  onClose: PlanNodeCloser;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Row>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Icon name="check" size={12} weight="bold" />}
          onClick={() => {
            setOpen(true);
          }}
        >
          Close plan
        </Button>
      </Row>
    );
  }
  return (
    <PlanRootCloseForm
      rootId={rootId}
      spaceId={spaceId}
      onClose={onClose}
      onDone={() => {
        setOpen(false);
      }}
    />
  );
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: PLAN_ITEM_GAP,
};

/** A row: the state orb at its side, the main area that is its hit target, a quiet action at its end. */
const rowGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `${String(PLAN_ORB_SIZE.item)}px minmax(0, 1fr) auto`,
  alignItems: 'center',
  columnGap: 'var(--space-2-5)',
  padding: 'var(--space-2) var(--space-2-5)',
};

const rowButton: CSSProperties = {
  gridRow: 1,
  gridColumn: 2,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const titleClamp: CSSProperties = {
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
};

const metaLine: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-1)',
};

/** What needs the operator: the one filled element of a row. */
const attentionCount: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 20,
  height: 20,
  padding: '0 var(--space-1-5)',
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-warning-default)',
  color: 'var(--color-content-inverse)',
  fontSize: 'var(--font-size-xs)',
  fontWeight: 'var(--font-weight-semibold)',
  fontVariantNumeric: 'tabular-nums',
};

/** Where a row's plan stands, as its meta line names it: its state, or how many steps are in flight where that is its state. */
function rowStateLine(row: PlanRootRow): string {
  const inFlight = row.counts?.inFlight ?? 0;
  return row.state === 'in_flight' && inFlight > 0
    ? `${String(inFlight)} ${planCountNoun('in_flight')}`
    : PLAN_STATE_LABEL[row.state];
}

/**
 * One plan in the list, read in one order: what the plan is (its title),
 * where it stands (its state, named and as its orb, and its steps
 * closed of all), and what needs the operator (the count at the end, the one
 * filled element of the row). An open row is dragged to reorder it.
 */
function PlanRowView({
  row,
  selected,
  onSelect,
  rowRef,
  reorderProps,
  dropSide,
  trailing,
  below,
}: {
  row: PlanRootRow;
  selected: boolean;
  onSelect: (rootId: string) => void;
  rowRef: (element: HTMLLIElement | null) => void;
  /** What makes an open row draggable and a place to drop one. */
  reorderProps?: DragReorderItemProps;
  /** Where a row dragged over this one would land. */
  dropSide?: DropSide | undefined;
  /** A quiet action at the row's end. */
  trailing?: ReactNode;
  /** What opens under the row: a refusal, a form. */
  below?: ReactNode;
}) {
  const progress = planRowProgress(row);
  const needsYou = row.counts?.needsYou ?? 0;
  const inFlight = row.counts?.inFlight ?? 0;
  const hover = useHover();
  const running = row.state === 'in_flight';
  return (
    <li
      ref={rowRef}
      className={running ? 'ds-enter-rise ds-card--running' : 'ds-enter-rise'}
      data-plan-row={row.nodeId}
      data-state={row.state}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      {...reorderProps}
      {...hover.hoverProps}
      style={{
        ...rowGrid,
        ...planItemSurface({ tone: planRootTone(row.state), selected, hovered: hover.hovered }),
        ...(reorderProps?.['data-dragging'] !== undefined ? { opacity: 0.5 } : {}),
      }}
    >
      <DropIndicator gap={PLAN_ITEM_GAP} side={dropSide} />
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => {
          onSelect(row.nodeId);
        }}
        style={rowButton}
      >
        <span
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            gap: 2,
            minWidth: 0,
          }}
        >
          <Text
            size="sm"
            weight={selected ? 'semibold' : 'medium'}
            style={titleClamp}
            data-plan-row-title
          >
            {row.title}
          </Text>
          <span style={metaLine}>
            <Text size="xs" variant="muted" data-plan-row-state>
              {rowStateLine(row)}
            </Text>
            {progress !== undefined && row.counts !== undefined && (
              <>
                <MetaSep />
                <ProgressMeter
                  done={row.counts.done + row.counts.dropped}
                  total={row.counts.steps}
                />
                <Text size="xs" variant="muted" data-plan-row-progress>
                  {progress}
                </Text>
              </>
            )}
            {row.state !== 'in_flight' && inFlight > 0 && (
              <>
                <MetaSep />
                <Text size="xs" variant="muted" data-plan-row-in-flight>
                  {`${String(inFlight)} ${planCountNoun('in_flight')}`}
                </Text>
              </>
            )}
          </span>
          {row.truncated !== undefined && (
            <Text size="xs" variant="muted" data-plan-row-truncated>
              {PLAN_ROW_TRUNCATION_LINE[row.truncated.bound](row.truncated.value)}
            </Text>
          )}
        </span>
        {needsYou > 0 && (
          <span
            data-plan-row-needs-you={needsYou}
            title={`${String(needsYou)} ${planCountNoun('needs_you')}`}
            style={attentionCount}
          >
            {String(needsYou)}
            <span style={srOnly}> {planCountNoun('needs_you')}</span>
          </span>
        )}
      </button>
      {/* After the row's button in reading order; the grid draws it first. */}
      <span style={{ gridRow: 1, gridColumn: 1, display: 'inline-flex' }}>
        <PlanStateOrb state={row.state} status={row.status} />
      </span>
      {trailing !== undefined && (
        <span style={{ gridRow: 1, gridColumn: 3, display: 'inline-flex', alignItems: 'center' }}>
          {trailing}
        </span>
      )}
      {below !== undefined && below !== null && (
        <div style={{ gridRow: 2, gridColumn: '2 / -1', paddingTop: 'var(--space-1)' }}>
          {below}
        </div>
      )}
    </li>
  );
}

interface RowPlacement {
  row: PlanRootRow;
  selected: boolean;
  onSelect: (rootId: string) => void;
  rowRef: (element: HTMLLIElement | null) => void;
}

/** An open plan: dragged among the open plans to reorder it, a refusal under the row. */
function OpenPlanRow({
  open,
  reorder,
  ...placement
}: RowPlacement & { open: readonly PlanRootRow[]; reorder: ReturnType<typeof usePlanReorder> }) {
  const { row } = placement;
  const item: PlanReorderItem = {
    nodeId: row.nodeId,
    revision: row.revision,
    moves: planRowMoveTargets(open, row.nodeId),
    // Every open plan is a sibling of every other: all are roots.
    accepts: (draggedId) => open.some((r) => r.nodeId === draggedId),
  };
  return (
    <PlanRowView
      {...placement}
      reorderProps={reorder.itemProps(item)}
      dropSide={reorder.dropSide(row.nodeId)}
      below={reorder.refusal(row.nodeId)}
    />
  );
}

/**
 * A finished plan: **Close plan** a quiet action at the row's end; the form
 * opens under the row, and reads the root, only when asked.
 */
function FinishedPlanRow({
  spaceId,
  onClose,
  ...placement
}: RowPlacement & { spaceId: string; onClose: PlanNodeCloser }) {
  const [closing, setClosing] = useState(false);
  return (
    <PlanRowView
      {...placement}
      trailing={
        closing ? undefined : (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="check" size={12} weight="bold" />}
            onClick={() => {
              setClosing(true);
            }}
          >
            Close plan
          </Button>
        )
      }
      below={
        closing ? (
          <PlanRootCloseForm
            rootId={placement.row.nodeId}
            spaceId={spaceId}
            onClose={onClose}
            onDone={() => {
              setClosing(false);
            }}
          />
        ) : undefined
      }
    />
  );
}

export interface PlanListProps {
  /** Every root, in position order. */
  rows: readonly PlanRootRow[];
  /** The plan whose board is showing; undefined on the overview. */
  selectedId: string | undefined;
  onSelect: (rootId: string) => void;
  /** Back to the overview, the lanes across every plan. */
  onOverview: () => void;
  onPlace: PlanNodePlacer;
  onClose: PlanNodeCloser;
  spaceId: string;
  /** Below 900px the list is a disclosure above the content. */
  narrow: boolean;
}

export function PlanList({
  rows,
  selectedId,
  onSelect,
  onOverview,
  onPlace,
  onClose,
  spaceId,
  narrow,
}: PlanListProps) {
  const { open, finished, closed } = planListSections(rows);
  const [closedOpen, setClosedOpen] = useState(false);
  const [disclosed, setDisclosed] = useState(false);
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const selectedClosed = closed.some((r) => r.nodeId === selectedId);
  const closedShown = closedOpen || selectedClosed;
  const bodyShown = !narrow || disclosed;

  useEffect(() => {
    if (selectedId === undefined || !bodyShown) return;
    const element = rowElements.current.get(selectedId);
    // jsdom and some older engines have no scrollIntoView.
    if (typeof element?.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId, bodyShown, closedShown]);

  const refFor = (nodeId: string) => (element: HTMLLIElement | null) => {
    if (element) rowElements.current.set(nodeId, element);
    else rowElements.current.delete(nodeId);
  };
  const select = (rootId: string) => {
    if (narrow) setDisclosed(false);
    onSelect(rootId);
  };
  const placementOf = (row: PlanRootRow): RowPlacement & { key: string } => ({
    key: row.nodeId,
    row,
    selected: row.nodeId === selectedId,
    onSelect: select,
    rowRef: refFor(row.nodeId),
  });

  const overview = selectedId === undefined;
  const overviewHover = useHover();
  const reorder = usePlanReorder(onPlace);
  const body = (
    <Column gap="md">
      <button
        type="button"
        aria-pressed={overview}
        {...(overview ? { 'aria-current': 'true' as const } : {})}
        data-plan-list-overview
        {...overviewHover.hoverProps}
        onClick={() => {
          if (narrow) setDisclosed(false);
          onOverview();
        }}
        style={{
          ...rowButton,
          ...rowGrid,
          width: '100%',
          ...planItemSurface({
            tone: 'neutral',
            selected: overview,
            hovered: overviewHover.hovered,
          }),
        }}
      >
        <span style={{ display: 'inline-flex', justifyContent: 'center' }}>
          <Icon name="squares-four" size="sm" />
        </span>
        <Text size="sm" weight={overview ? 'semibold' : 'medium'}>
          Overview
        </Text>
      </button>
      <Column gap="xs" data-plan-list-section="open">
        <GroupLabel>{`Open · ${String(open.length)}`}</GroupLabel>
        <ItemsBody>
          <ul style={listStyle} aria-label="Open plans">
            {open.map((row) => {
              const { key, ...placement } = placementOf(row);
              return <OpenPlanRow key={key} {...placement} open={open} reorder={reorder} />;
            })}
          </ul>
          {open.length === 0 && (
            <Text size="sm" variant="muted">
              No open plan
            </Text>
          )}
        </ItemsBody>
      </Column>
      <Column gap="xs" data-plan-list-section="finished">
        <GroupLabel>{`Finished · ${String(finished.length)}`}</GroupLabel>
        <ItemsBody>
          {finished.length > 0 && (
            <ul style={listStyle} aria-label="Finished plans">
              {finished.map((row) => {
                const { key, ...placement } = placementOf(row);
                return (
                  <FinishedPlanRow key={key} {...placement} spaceId={spaceId} onClose={onClose} />
                );
              })}
            </ul>
          )}
        </ItemsBody>
      </Column>
      <Column gap="xs" data-plan-list-section="closed">
        <Disclosure
          expanded={closedShown}
          onToggle={() => {
            setClosedOpen(!closedShown);
          }}
        >
          {`Closed · ${String(closed.length)}`}
        </Disclosure>
        <ItemsBody>
          {closedShown && closed.length > 0 && (
            <ul style={listStyle} aria-label="Closed plans">
              {closed.map((row) => {
                const { key, ...placement } = placementOf(row);
                return <PlanRowView key={key} {...placement} />;
              })}
            </ul>
          )}
        </ItemsBody>
      </Column>
    </Column>
  );

  if (narrow) {
    const selected = rows.find((r) => r.nodeId === selectedId);
    return (
      <Column gap="sm" data-plan-list data-layout="disclosure">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={disclosed}
          style={{ justifyContent: 'space-between' }}
          rightIcon={<Icon name={disclosed ? 'caret-up' : 'caret-down'} size={12} weight="bold" />}
          onClick={() => {
            setDisclosed(!disclosed);
          }}
        >
          {selected !== undefined
            ? `Plans · ${String(rows.length)} — ${selected.title}`
            : `Plans · ${String(rows.length)}`}
        </Button>
        {disclosed && (
          <Panel variant="subtle" padding="sm">
            {body}
          </Panel>
        )}
      </Column>
    );
  }

  // The outline of the designer: a pane of its own that scrolls on its own,
  // headed as the designer heads its outline.
  return (
    <nav
      aria-label="Plans"
      data-plan-list
      data-layout="column"
      style={{ height: '100%', overflow: 'auto', padding: 'var(--space-2-5)' }}
    >
      <div style={{ padding: 'var(--space-3) var(--space-2) var(--space-2)' }}>
        <Text
          style={{
            fontSize: 'var(--font-size-base)',
            textTransform: 'uppercase',
            letterSpacing: 'var(--font-letter-spacing-wide)',
            color: 'var(--color-text-primary)',
          }}
        >
          Plans
        </Text>
      </div>
      {body}
    </nav>
  );
}
