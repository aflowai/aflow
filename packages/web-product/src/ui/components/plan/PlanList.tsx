'use client';

/**
 * The space's plans as a list (Plan 332 D2), below **Overview**, which returns
 * to the lanes across every plan (D1): open plans in position order —
 * the order the loop takes them — each with its state, its progress and its
 * non-zero counts of steps needing the operator and in flight, with **Move up**
 * and **Move down** quiet in the row's dot until it is pointed at or focused;
 * then **Finished**, open plans whose every step is closed, each with a quiet
 * **Close plan**; then **Closed**, folded. The selected row is filled and
 * barred as the skill designer's outline bars its current item, and scrolls
 * into view. The list fills the page's left pane, as the outline does.
 * Below 900px it is a disclosure above the content.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Button,
  Column,
  Icon,
  Panel,
  Row,
  Text,
  Textarea,
  type BadgeVariant,
} from '@aflow/design-system';
import type { PlanNodeDetailOutput, PlanRootRow, PlanRootState } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import {
  PLAN_STATE_LABEL,
  planListSections,
  planRowMoveTargets,
  planRowProgress,
} from '../../lib/plan-board.js';
import type { PlanNodePlacer } from './PlanBoard.js';
import { isClosedStatus, usePinnedNode, type PlanNodeCloser } from './PlanNodeCloseControl.js';
import {
  Disclosure,
  GroupLabel,
  MetaSep,
  ProgressMeter,
  StateDot,
  selectableStyle,
  srOnly,
  useHover,
  useMoveControls,
  useReveal,
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

const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };

/** A row: the state dot's gutter, the main area that is its hit target, a quiet action at its end. */
const rowGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '20px minmax(0, 1fr) auto',
  alignItems: 'center',
  columnGap: 'var(--space-2)',
  padding: 'var(--space-1-5) var(--space-2)',
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
    ? `${String(inFlight)} in flight`
    : PLAN_STATE_LABEL[row.state];
}

/**
 * One plan in the list, read in one order: what the plan is (its title),
 * where it stands (its state, named and as the dot's colour, and its steps
 * closed of all), and what needs the operator (the count at the end, the one
 * filled element of the row). The dot's place doubles as the row's reorder
 * handle: on an open row pointed at or focused, Move up and Move down show
 * there instead.
 */
function PlanRowView({
  row,
  selected,
  onSelect,
  rowRef,
  hostProps,
  gutter,
  gutterShown = false,
  trailing,
  below,
}: {
  row: PlanRootRow;
  selected: boolean;
  onSelect: (rootId: string) => void;
  rowRef: (element: HTMLLIElement | null) => void;
  /** What tells the row's reveal it is pointed at or focused. */
  hostProps?: ReturnType<typeof useReveal>['hostProps'];
  /** Controls that show in the dot's place on a row pointed at or focused. */
  gutter?: ReactNode;
  /** The controls show, so the dot gives way to them. */
  gutterShown?: boolean;
  /** A quiet action at the row's end. */
  trailing?: ReactNode;
  /** What opens under the row: a refusal, a form. */
  below?: ReactNode;
}) {
  const progress = planRowProgress(row);
  const needsYou = row.counts?.needsYou ?? 0;
  const inFlight = row.counts?.inFlight ?? 0;
  const hover = useHover();
  return (
    <li
      ref={rowRef}
      data-plan-row={row.nodeId}
      data-state={row.state}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      {...hostProps}
      onMouseEnter={() => {
        hover.hoverProps.onMouseEnter();
        hostProps?.onMouseEnter();
      }}
      onMouseLeave={() => {
        hover.hoverProps.onMouseLeave();
        hostProps?.onMouseLeave();
      }}
      style={{ ...rowGrid, ...selectableStyle(selected, hover.hovered) }}
    >
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
                  {`${String(inFlight)} in flight`}
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
            title={`${String(needsYou)} need you`}
            style={attentionCount}
          >
            {String(needsYou)}
            <span style={srOnly}> need you</span>
          </span>
        )}
      </button>
      {/* After the row's button in reading and tab order; the grid draws it first. */}
      <span
        style={{
          gridRow: 1,
          gridColumn: 1,
          display: 'grid',
          alignSelf: 'stretch',
          placeItems: 'center',
        }}
      >
        <span style={{ gridArea: '1 / 1' }}>
          <StateDot state={row.state} hidden={gutter !== undefined && gutterShown} />
        </span>
        {gutter !== undefined && <span style={{ gridArea: '1 / 1' }}>{gutter}</span>}
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

/** An open plan: Move up and Move down in the dot's place, a refusal under the row. */
function OpenPlanRow({
  open,
  onPlace,
  ...placement
}: RowPlacement & { open: readonly PlanRootRow[]; onPlace: PlanNodePlacer }) {
  const reveal = useReveal();
  const shown = reveal.shown || placement.selected;
  const move = useMoveControls(
    placement.row,
    planRowMoveTargets(open, placement.row.nodeId),
    onPlace,
    shown,
    'column',
  );
  return (
    <PlanRowView
      {...placement}
      hostProps={reveal.hostProps}
      {...(move.controls !== null ? { gutter: move.controls, gutterShown: shown } : {})}
      below={move.error}
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
          ...selectableStyle(overview, overviewHover.hovered),
        }}
      >
        <Icon name="squares-four" size="xs" />
        <Text size="sm" weight={overview ? 'semibold' : 'medium'}>
          Overview
        </Text>
      </button>
      <Column gap="xs" data-plan-list-section="open">
        <GroupLabel>{`Open · ${String(open.length)}`}</GroupLabel>
        <ul style={listStyle} aria-label="Open plans">
          {open.map((row) => {
            const { key, ...placement } = placementOf(row);
            return <OpenPlanRow key={key} {...placement} open={open} onPlace={onPlace} />;
          })}
        </ul>
        {open.length === 0 && (
          <Text size="sm" variant="muted">
            No open plan
          </Text>
        )}
      </Column>
      <Column gap="xs" data-plan-list-section="finished">
        <GroupLabel>{`Finished · ${String(finished.length)}`}</GroupLabel>
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
        {closedShown && closed.length > 0 && (
          <ul style={listStyle} aria-label="Closed plans">
            {closed.map((row) => {
              const { key, ...placement } = placementOf(row);
              return <PlanRowView key={key} {...placement} />;
            })}
          </ul>
        )}
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
