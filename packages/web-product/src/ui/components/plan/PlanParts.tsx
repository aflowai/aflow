'use client';

/**
 * The plan page's shared pieces (Plan 332 P6), so the list, the lanes, the
 * board and the rail say the same thing the same way: a plan's or a step's
 * state as the run surface's orb (Plan 332 P7), a run on a step as the run
 * surface's row, progress as a meter, a pull request as the PR it is, the
 * step the loop takes next by name, a folding group heading, and **Move up** / **Move
 * down** as quiet icon controls that show where the row or card is pointed
 * at, focused or selected — reordering is rare (J3), so it is never the
 * loudest thing on a row. Each piece is styled inline on the design system's
 * tokens, as the skill designer's outline and inspector are.
 */
import { useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AnimatedHeight,
  Badge,
  Column,
  Icon,
  IconButton,
  Text,
  Tooltip,
  useMediaQuery,
} from '@aflow/design-system';
import type { PlanBoardColumn, PlanNodeRun, PlanRootState } from '@aflow/schemas';
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

/**
 * A step's card or lane row, its surface saying where it stands: tinted as a
 * pause where it needs the operator, as a run where one is on it, neutral
 * otherwise. Pointed at, the hover tint lies over that surface rather than
 * replacing it, and the selected one is ringed. The surface is translucent, so
 * it blurs the canvas's dots under it as a design-system card does.
 */
export function planItemSurface({
  column,
  running,
  selected,
  hovered,
}: {
  column: PlanBoardColumn;
  running: boolean;
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
    backgroundColor:
      column === 'needs_you'
        ? 'var(--color-status-paused-bg)'
        : running
          ? 'var(--color-status-running-bg)'
          : 'var(--color-surface-2)',
    backgroundImage: hovered ? `linear-gradient(${HOVER_TINT}, ${HOVER_TINT})` : 'none',
    ...(selected
      ? {
          boxShadow: `0 0 0 ${String(SELECTED_RING)}px var(--color-interactive-default), var(--shadow-md)`,
        }
      : {}),
    cursor: 'pointer',
  };
}

/**
 * The designer outline's row: filled and barred in the interactive colour
 * when current, tinted while pointed at otherwise.
 */
export function selectableStyle(current: boolean, hovered = false): CSSProperties {
  return {
    ...hoverTransition,
    background: current
      ? 'var(--color-surface-3, var(--color-surface-2))'
      : hovered
        ? HOVER_TINT
        : 'transparent',
    borderLeft: `2px solid ${current ? 'var(--color-interactive-default)' : 'transparent'}`,
    color: current ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
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
 * table or code block scrolls inside the rail rather than widening it.
 */
export function RailMarkdown({
  content,
  ...data
}: {
  content: string;
  [dataAttribute: `data-${string}`]: boolean | undefined;
}) {
  return (
    <div {...data} style={railMarkdownFrame}>
      <MarkdownRenderer content={content} style={railMarkdownStyle} />
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
 * 28px box its state does not read. The rail's header is larger.
 */
export const PLAN_ORB_SIZE = { row: 28, header: 28, rail: 36 } as const;

/**
 * An orb that shows a state the words beside it name (Plan 332 P6). It is
 * decorative, so a screen reader reads the state once, in those words.
 */
function StateOrb({
  kind,
  size,
  hidden,
  data,
}: {
  kind: OrbKind;
  size: number;
  hidden: boolean;
  data: Record<`data-${string}`, string>;
}) {
  return (
    <span
      data-plan-orb={kind}
      {...data}
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        opacity: hidden ? 0 : 1,
        transition: 'opacity var(--transition-duration-fast) var(--transition-timing-default)',
      }}
    >
      <StatusOrb kind={kind} size={size} />
    </span>
  );
}

/** A plan's state as its orb; the words beside it name the state. */
export function PlanStateOrb({
  state,
  size = PLAN_ORB_SIZE.row,
  hidden = false,
}: {
  state: PlanRootState;
  size?: number;
  /** Controls stand in the orb's place, so it gives way to them. */
  hidden?: boolean;
}) {
  return (
    <StateOrb
      kind={orbForPlanState(state)}
      size={size}
      hidden={hidden}
      data={{ 'data-state': state }}
    />
  );
}

/** A step's state as its orb, by its column and whether a run is on it; its words beside it. */
export function PlanStepOrb({
  column,
  runInFlight,
  size = PLAN_ORB_SIZE.row,
}: {
  column: PlanBoardColumn;
  runInFlight: boolean;
  size?: number;
}) {
  return (
    <StateOrb
      kind={orbForPlanStep(column, { runInFlight })}
      size={size}
      hidden={false}
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

/**
 * **Move up** and **Move down** (Plan 332 D6), on an Up next card and on an
 * open row of the plan list: each puts the node before or after its nearest
 * open sibling on screen, and shows only where there is one. The write is
 * pinned to the revision the page read. The controls are quiet icons that
 * show while `shown` holds (the host pointed at, focused or selected) or a
 * move is pending. A refusal is its own element, so the host says it where
 * it reads, and it is never hidden with the controls.
 */
export function useMoveControls(
  node: PlanMovable,
  moves: { above?: { nodeId: string }; below?: { nodeId: string } } | undefined,
  onPlace: PlanNodePlacer,
  shown: boolean,
  direction: 'row' | 'column' = 'row',
): { controls: ReactNode; error: ReactNode } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const above = moves?.above;
  const below = moves?.below;
  if (above === undefined && below === undefined) return { controls: null, error: null };
  const place = async (anchor: { before: string } | { after: string }) => {
    setPending(true);
    setError(null);
    const answer = await onPlace({
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      ...anchor,
    });
    setPending(false);
    if (!answer.ok) setError(answer.message);
  };
  const control = (label: string, icon: 'caret-up' | 'caret-down', send: () => void) => (
    <Tooltip content={label} side="top">
      <IconButton
        size="sm"
        variant="ghost"
        aria-label={label}
        icon={<Icon name={icon} size={14} weight="bold" />}
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation();
          send();
        }}
      />
    </Tooltip>
  );
  return {
    controls: (
      <span
        role="group"
        aria-label="Order"
        data-plan-move={node.nodeId}
        {...(pending ? { 'data-pending': 'true' } : {})}
        style={{
          display: 'inline-flex',
          flexDirection: direction,
          alignItems: 'center',
          opacity: shown || pending ? 1 : 0,
        }}
      >
        {above !== undefined &&
          control('Move up', 'caret-up', () => {
            void place({ before: above.nodeId });
          })}
        {below !== undefined &&
          control('Move down', 'caret-down', () => {
            void place({ after: below.nodeId });
          })}
      </span>
    ),
    error:
      error === null ? null : (
        <Text size="xs" tone="danger" role="alert">
          {error}
        </Text>
      ),
  };
}
