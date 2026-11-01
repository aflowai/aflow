'use client';

/**
 * The plan page's shared pieces (Plan 332 P6), so the list, the lanes, the
 * board and the rail say the same thing the same way: a plan's or a step's
 * state as the run surface's orb (Plan 332 P7) and as the surface it stands
 * on, a run on a step as the run surface's row, progress as a meter, a pull
 * request as the PR it is, the step the loop takes next by name, a folding
 * group heading, and reordering by drag, with Alt+ArrowUp and Alt+ArrowDown
 * from the keyboard. Each piece is styled inline on the design system's
 * tokens, as the skill designer's outline and inspector are.
 */
import { useRef, useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AnimatedHeight,
  Badge,
  Column,
  Icon,
  Text,
  useDragReorder,
  useMediaQuery,
  type DragReorderItemProps,
  type DragReorderMove,
  type DropSide,
} from '@aflow/design-system';
import type { PlanBoardColumn, PlanNodeRun, PlanNodeStatus, PlanRootState } from '@aflow/schemas';
import { PLAN_NEXT_LABEL, pullRequestChipLabel, runKindLabel } from '../../lib/plan-board.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { StatusOrb } from '../workflow-run-surface/StatusOrb.js';
import { useNowTicker } from '../workflow-run-surface/useNowTicker.js';
import { Pill } from '../workflow-run-surface/WorkflowRunSurfaceParts.js';
import {
  formatElapsed,
  orbForPlanState,
  orbForPlanStep,
  runPill,
  type OrbKind,
} from '../workflow-run-surface/workflowRunSurfaceHelpers.js';
import type { PlanNodePlacer } from './PlanBoard.js';

/** Read by assistive technology only. */
export const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** The tint a row, an item or a disclosure takes while pointed at, and how fast it takes it. */
export const HOVER_TINT = 'var(--color-surface-2)';
export const hoverTransition: CSSProperties = {
  transition: 'background-color var(--transition-duration-fast) var(--transition-timing-default)',
};

/** The width in pixels of the selected card's ring, drawn outside the card. */
export const SELECTED_RING = 2;

/** Where an item stands, as its surface says it. */
export type PlanItemTone = 'pending' | 'running' | 'neutral';

/** A step's tone: pending where it needs the operator, running where a run is on it. */
export function planStepTone(column: PlanBoardColumn, running: boolean): PlanItemTone {
  if (column === 'needs_you') return 'pending';
  return running ? 'running' : 'neutral';
}

/** A plan's tone, as its state names it. */
export function planRootTone(state: PlanRootState): PlanItemTone {
  if (state === 'needs_you') return 'pending';
  return state === 'in_flight' ? 'running' : 'neutral';
}

const TONE_SURFACE: Record<PlanItemTone, string> = {
  pending: 'var(--color-status-paused-bg)',
  running: 'var(--color-status-running-bg)',
  neutral: 'var(--color-surface-2)',
};

/**
 * A plan's row, a step's card or a lane row, its surface saying where it
 * stands: tinted as a pause where it needs the operator, as a run where one is
 * on it, neutral otherwise. Pointed at, the hover tint lies over that surface rather than
 * replacing it, and the selected one is ringed. The surface is translucent, so
 * it blurs the canvas's dots under it as a design-system card does.
 */
export function planItemSurface({
  tone,
  selected,
  hovered,
}: {
  tone: PlanItemTone;
  selected: boolean;
  hovered: boolean;
}): CSSProperties {
  return {
    position: 'relative',
    borderRadius: 'var(--radius-lg)',
    WebkitBackdropFilter: 'blur(12px)',
    backdropFilter: 'blur(12px)',
    transition:
      'background-color var(--transition-duration-fast) var(--transition-timing-default), box-shadow var(--transition-duration-fast) var(--transition-timing-default)',
    backgroundColor: TONE_SURFACE[tone],
    backgroundImage: hovered ? `linear-gradient(${HOVER_TINT}, ${HOVER_TINT})` : 'none',
    ...(selected
      ? {
          boxShadow: `0 0 0 ${String(SELECTED_RING)}px var(--color-interactive-default), var(--shadow-md)`,
        }
      : {}),
    cursor: 'pointer',
  };
}

/** Whether an element is pointed at, which tints it. */
export function useHover(): {
  hovered: boolean;
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
} {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    hoverProps: {
      onMouseEnter: () => {
        setHovered(true);
      },
      onMouseLeave: () => {
        setHovered(false);
      },
    },
  };
}

/** A group's uppercase label, as the designer's outline and inspector head theirs. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      size="xs"
      color="muted"
      weight="semibold"
      style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
    >
      {children}
    </Text>
  );
}

/**
 * One labelled part of the rail, as the skill inspector sections its own. Its
 * body grows and shrinks as it unfolds and folds, a note shown or All runs
 * listed.
 */
export function RailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Column gap="xs" role="group" aria-label={label} data-plan-rail-section={label}>
      <GroupLabel>{label}</GroupLabel>
      <AnimatedHeight>
        <Column gap="xs">{children}</Column>
      </AnimatedHeight>
    </Column>
  );
}

/** A rail section's text, in the inspector's prose. */
export const railProse = { lineHeight: 1.55, whiteSpace: 'pre-wrap' } as const;

const railMarkdownStyle = {
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--font-size-base)',
  lineHeight: 1.55,
  minWidth: 0,
} as const;

const railMarkdownFrame = { minWidth: 0, maxWidth: '100%', overflowX: 'auto' } as const;

/**
 * A node's own text on the rail, which its writer may put in markdown. A wide
 * table or code block scrolls inside the rail rather than widening it. Text the
 * engine writes one entry per line, a note or an outcome, asks for `lineBreaks`
 * so each entry keeps its own line.
 */
export function RailMarkdown({
  content,
  lineBreaks = false,
  ...data
}: {
  content: string;
  lineBreaks?: boolean;
  [dataAttribute: `data-${string}`]: boolean | undefined;
}) {
  return (
    <div {...data} style={railMarkdownFrame}>
      <MarkdownRenderer content={content} style={railMarkdownStyle} lineBreaks={lineBreaks} />
    </div>
  );
}

/**
 * Whether a row or card is pointed at or holds focus, which reveals its quiet
 * controls. On a screen without hover they always show.
 */
export function useReveal(): {
  shown: boolean;
  hovered: boolean;
  hostProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
} {
  const touch = useMediaQuery('(hover: none)');
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    shown: touch || hovered || focused,
    hovered,
    hostProps: {
      onMouseEnter: () => {
        setHovered(true);
      },
      onMouseLeave: () => {
        setHovered(false);
      },
      onFocus: () => {
        setFocused(true);
      },
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      },
    },
  };
}

/**
 * An orb's size by its place. An orb's core is about 60% of its box, so below a
 * 28px box its state does not read. A plan's row and a lane row carry it at
 * their side, where it can be larger than a line of text.
 */
export const PLAN_ORB_SIZE = { item: 48, header: 28, rail: 36 } as const;

/** How far an orb of something set aside, a dropped step or plan, recedes. */
const SET_ASIDE_ORB_OPACITY = 0.4;

/**
 * An orb that shows a state the words beside it name (Plan 332 P6). It is
 * decorative, so a screen reader reads the state once, in those words.
 */
function StateOrb({
  kind,
  size,
  setAside,
  data,
}: {
  kind: OrbKind;
  size: number;
  setAside: boolean;
  data: Record<`data-${string}`, string>;
}) {
  return (
    <span
      data-plan-orb={kind}
      {...data}
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        opacity: setAside ? SET_ASIDE_ORB_OPACITY : 1,
      }}
    >
      <StatusOrb kind={kind} size={size} />
    </span>
  );
}

/** A plan's state as its orb; the words beside it name the state. */
export function PlanStateOrb({
  state,
  status,
  size = PLAN_ORB_SIZE.item,
}: {
  state: PlanRootState;
  /** The root's own status, which says how a closed plan closed. */
  status: PlanNodeStatus;
  size?: number;
}) {
  return (
    <StateOrb
      kind={orbForPlanState(state, status)}
      size={size}
      setAside={state === 'closed' && status === 'dropped'}
      data={{ 'data-state': state }}
    />
  );
}

/** A step's state as its orb, by its column and whether a run is on it; its words beside it. */
export function PlanStepOrb({
  column,
  runInFlight,
  size = PLAN_ORB_SIZE.item,
}: {
  column: PlanBoardColumn;
  runInFlight: boolean;
  size?: number;
}) {
  return (
    <StateOrb
      kind={orbForPlanStep(column, { runInFlight })}
      size={size}
      setAside={column === 'dropped'}
      data={{ 'data-column': column }}
    />
  );
}

/**
 * A run on a step as the run surface writes its rows: its kind linked to the
 * run, its pill, and how long it has run, ticking while it runs. The step's
 * orb already says a run is on it, so the run carries none of its own.
 */
export function PlanRunLine({ run, spaceSlug }: { run: PlanNodeRun; spaceSlug: string }) {
  const running = run.status === 'running';
  const nowMs = useNowTicker(running);
  const pill = runPill(run.status);
  const elapsed = running ? formatElapsed(run.startedAt, nowMs) : '';
  return (
    <span
      data-plan-run={run.runId}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
    >
      <Link
        href={spaceRoute(spaceSlug, `/runs/${encodeURIComponent(run.runId)}`)}
        style={{ color: 'var(--color-text-link)' }}
      >
        {runKindLabel(run.slug)}
      </Link>
      <Pill label={pill.label} tone={pill.tone} />
      {elapsed !== '' && (
        <Text size="xs" variant="muted" data-plan-run-elapsed>
          {elapsed}
        </Text>
      )}
    </span>
  );
}

/** A hairline meter of closed of all; its count is said beside it. */
export function ProgressMeter({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 36,
        height: 4,
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-surface-3)',
        boxShadow: 'inset 0 0 0 1px var(--color-border-subtle)',
        overflow: 'hidden',
        verticalAlign: 'middle',
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${String(share)}%`,
          background: 'var(--color-success-default)',
        }}
      />
    </span>
  );
}

/** The dot between two facts on a meta line. */
export function MetaSep() {
  return (
    <span aria-hidden style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
      ·
    </span>
  );
}

/** A pull request as the PR it is: its number, and whether it merged. */
export function PullRequestChip({
  pullRequest,
}: {
  pullRequest: { url: string; merged: boolean };
}) {
  return (
    <Badge
      variant={pullRequest.merged ? 'success' : 'info'}
      icon={<Icon name="git-branch" size={12} weight="bold" />}
    >
      {pullRequestChipLabel(pullRequest)}
    </Badge>
  );
}

/** The mark on the step the stream walk takes next for its plan. */
export function NextMarker() {
  return (
    <Badge variant="accent" icon={<Icon name="play" size={10} weight="fill" />}>
      {PLAN_NEXT_LABEL}
    </Badge>
  );
}

/** A group heading that folds what is under it, in the group label's type. */
export function Disclosure({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      {...hoverProps}
      style={{
        ...hoverTransition,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        // The tint reaches past the label, while the caret stays on the label's edge.
        padding: 'var(--space-1) var(--space-1-5)',
        margin: '0 calc(-1 * var(--space-1-5))',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: hovered ? HOVER_TINT : 'transparent',
        cursor: 'pointer',
        color: hovered ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-semibold)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
      {children}
    </button>
  );
}

/** What a move names: a node, at the revision the page read. */
export interface PlanMovable {
  nodeId: string;
  revision: number;
}

/** One item the operator can reorder: its open siblings, and which dragged nodes it takes beside it. */
export interface PlanReorderItem extends PlanMovable {
  /** The nearest open siblings above and below, which Alt+ArrowUp and Alt+ArrowDown move it past. */
  moves: { above?: { nodeId: string }; below?: { nodeId: string } };
  /** Whether the node being dragged may land beside this one: an open sibling of it. */
  accepts: (draggedId: string) => boolean;
}

/** The space between two items in a list, which a drop line sits in the middle of. */
export const PLAN_ITEM_GAP = 8;

/**
 * Reordering by drag (Plan 332 D6), on an open row of the plan list and on an
 * Up next card, through the design system's drag reorder. Each move is
 * written against the revision the page read, one at a time, and a refusal is
 * said under the item it names.
 */
export function usePlanReorder(onPlace: PlanNodePlacer): {
  itemProps: (item: PlanReorderItem) => DragReorderItemProps;
  dropSide: (nodeId: string) => DropSide | undefined;
  refusal: (nodeId: string) => ReactNode;
} {
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<{ nodeId: string; message: string } | null>(null);
  const revisions = useRef(new Map<string, number>());
  const place = async ({ id, anchor }: DragReorderMove) => {
    const revision = revisions.current.get(id);
    if (revision === undefined) return;
    setPending(true);
    setRefused(null);
    const answer = await onPlace({ nodeId: id, expectedRevision: revision, ...anchor });
    setPending(false);
    if (!answer.ok) setRefused({ nodeId: id, message: answer.message });
  };
  const drag = useDragReorder(
    (move) => {
      void place(move);
    },
    { disabled: pending },
  );
  return {
    itemProps: (item) => {
      revisions.current.set(item.nodeId, item.revision);
      return drag.itemProps({
        id: item.nodeId,
        previousId: item.moves.above?.nodeId,
        nextId: item.moves.below?.nodeId,
        accepts: item.accepts,
      });
    },
    dropSide: drag.dropSide,
    refusal: (nodeId) =>
      refused?.nodeId === nodeId ? (
        <Text size="xs" tone="danger" role="alert">
          {refused.message}
        </Text>
      ) : null,
  };
}

/**
 * A list of items that grows and shrinks as they come and go. The box is
 * widened by the selected item's ring and padded by it and by half a gap, so
 * the ring and a drop line on the first or last item lie inside its clip.
 */
export function ItemsBody({ children }: { children: ReactNode }) {
  return (
    <AnimatedHeight style={{ margin: `0 -${String(SELECTED_RING)}px` }}>
      <div
        style={{
          padding: `${String(PLAN_ITEM_GAP / 2 + SELECTED_RING)}px ${String(SELECTED_RING)}px`,
        }}
      >
        {children}
      </div>
    </AnimatedHeight>
  );
}
