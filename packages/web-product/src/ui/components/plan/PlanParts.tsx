'use client';

/**
 * The plan page's shared pieces (Plan 332 P6), so the list, the lanes, the
 * board and the rail say the same thing the same way: a plan's state as a
 * dot, progress as a meter, a pull request as the PR it is, the step the loop
 * takes next by name, a folding group heading, and **Move up** / **Move
 * down** as quiet icon controls that show where the row or card is pointed
 * at, focused or selected — reordering is rare (J3), so it is never the
 * loudest thing on a row. Each piece is styled inline on the design system's
 * tokens, as the skill designer's outline and inspector are.
 */
import { useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { Badge, Icon, IconButton, Pulse, Text, Tooltip, useMediaQuery } from '@aflow/design-system';
import type { PlanRootState } from '@aflow/schemas';
import { PLAN_NEXT_LABEL, PLAN_STATE_COLOR, pullRequestChipLabel } from '../../lib/plan-board.js';
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
 * Whether a row or card is pointed at or holds focus, which reveals its quiet
 * controls. On a screen without hover they always show.
 */
export function useReveal(): {
  shown: boolean;
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

/** A plan's state as a dot in its colour; the words beside it name the state. */
export function StateDot({ state, hidden = false }: { state: PlanRootState; hidden?: boolean }) {
  const color = PLAN_STATE_COLOR[state];
  const ring = state === 'closed' || state === 'empty';
  const dot = (
    <span
      aria-hidden
      data-state={state}
      style={{
        display: 'block',
        width: 8,
        height: 8,
        borderRadius: 'var(--radius-full)',
        background: ring ? 'transparent' : color,
        boxShadow: ring ? `inset 0 0 0 1.5px ${color}` : 'none',
        opacity: hidden ? 0 : 1,
      }}
    />
  );
  return state === 'in_flight' && !hidden ? (
    <Pulse active color={color}>
      {dot}
    </Pulse>
  ) : (
    dot
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

/** A heading's dot, in the colour of the column or lane it heads. */
export function HeadingDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: 'var(--radius-full)',
        background: color,
      }}
    />
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
