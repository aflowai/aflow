'use client';

/**
 * The space's plans as a list (Plan 332 D2): open plans in position order —
 * the order the loop takes them — each with its state, its progress and its
 * non-zero counts of steps needing the operator and in flight, with **Move up**
 * and **Move down**; then **Finished**, open plans whose every step is closed,
 * each with **Close plan**; then **Closed**, folded. The selected row scrolls
 * into view. Below 900px the list is a disclosure above the content.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Badge,
  Button,
  Column,
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
import { MoveControls, type PlanNodePlacer } from './PlanBoard.js';
import { isClosedStatus, usePinnedNode, type PlanNodeCloser } from './PlanNodeCloseControl.js';
import { freshRead, planNodePath } from './PlanRail.js';

export const PLAN_LIST_WIDTH = '280px';

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

const rowButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
};

const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };

function PlanRowView({
  row,
  selected,
  onSelect,
  rowRef,
  children,
}: {
  row: PlanRootRow;
  selected: boolean;
  onSelect: (rootId: string) => void;
  rowRef: (element: HTMLLIElement | null) => void;
  children?: React.ReactNode;
}) {
  const progress = planRowProgress(row);
  return (
    <li
      ref={rowRef}
      data-plan-row={row.nodeId}
      data-state={row.state}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        ...(selected ? { background: 'var(--color-surface-2)' } : {}),
      }}
    >
      <Column gap="xs">
        <button
          type="button"
          style={rowButtonStyle}
          aria-pressed={selected}
          onClick={() => {
            onSelect(row.nodeId);
          }}
        >
          <Column gap="xs">
            <Text size="sm" weight={selected ? 'semibold' : 'medium'}>
              {row.title}
            </Text>
            <Row gap="xs" align="center" wrap>
              <Badge variant={PLAN_STATE_BADGE[row.state]}>{PLAN_STATE_LABEL[row.state]}</Badge>
              {progress !== undefined && (
                <Text size="xs" variant="muted" data-plan-row-progress>
                  {progress}
                </Text>
              )}
              {row.counts !== undefined && row.counts.needsYou > 0 && (
                <Badge variant="warning">{`${String(row.counts.needsYou)} need you`}</Badge>
              )}
              {row.counts !== undefined && row.counts.inFlight > 0 && (
                <Badge variant="running">{`${String(row.counts.inFlight)} in flight`}</Badge>
              )}
              {row.truncated !== undefined && (
                <Text size="xs" variant="muted" data-plan-row-truncated>
                  {PLAN_ROW_TRUNCATION_LINE[row.truncated.bound](row.truncated.value)}
                </Text>
              )}
            </Row>
          </Column>
        </button>
        {children}
      </Column>
    </li>
  );
}

export interface PlanListProps {
  /** Every root, in position order. */
  rows: readonly PlanRootRow[];
  selectedId: string | undefined;
  onSelect: (rootId: string) => void;
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
  const rowOf = (row: PlanRootRow, controls?: React.ReactNode) => (
    <PlanRowView
      key={row.nodeId}
      row={row}
      selected={row.nodeId === selectedId}
      onSelect={select}
      rowRef={refFor(row.nodeId)}
    >
      {controls}
    </PlanRowView>
  );

  const body = (
    <Column gap="md">
      <ul style={listStyle} aria-label="Open plans" data-plan-list-section="open">
        {open.map((row) =>
          rowOf(
            row,
            <MoveControls
              node={row}
              moves={planRowMoveTargets(open, row.nodeId)}
              onPlace={onPlace}
            />,
          ),
        )}
      </ul>
      {open.length === 0 && (
        <Text size="sm" variant="muted">
          No open plan
        </Text>
      )}
      <Column gap="xs" data-plan-list-section="finished">
        <Text variant="label" size="xs">{`Finished · ${String(finished.length)}`}</Text>
        {finished.length > 0 && (
          <ul style={listStyle} aria-label="Finished plans">
            {finished.map((row) =>
              rowOf(
                row,
                <PlanRootCloseControl rootId={row.nodeId} spaceId={spaceId} onClose={onClose} />,
              ),
            )}
          </ul>
        )}
      </Column>
      <Column gap="xs" data-plan-list-section="closed">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={closedShown}
          style={{ justifyContent: 'flex-start' }}
          onClick={() => {
            setClosedOpen(!closedShown);
          }}
        >
          {`Closed · ${String(closed.length)}`}
        </Button>
        {closedShown && closed.length > 0 && (
          <ul style={listStyle} aria-label="Closed plans">
            {closed.map((row) => rowOf(row))}
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
          style={{ justifyContent: 'flex-start' }}
          onClick={() => {
            setDisclosed(!disclosed);
          }}
        >
          {selected !== undefined
            ? `Plans · ${String(rows.length)} — ${selected.title}`
            : `Plans · ${String(rows.length)}`}
        </Button>
        {disclosed && body}
      </Column>
    );
  }

  return (
    <nav
      aria-label="Plans"
      data-plan-list
      data-layout="column"
      style={{
        width: PLAN_LIST_WIDTH,
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        maxHeight: '100vh',
        overflowY: 'auto',
        borderRight: '1px solid var(--color-border-subtle)',
        paddingRight: 'var(--space-2)',
      }}
    >
      {body}
    </nav>
  );
}
