'use client';

/**
 * The plan page's shared pieces (Plan 332 P6), so the list, the lanes, the
 * board and the rail say the same thing the same way: a plan's state as a
 * dot, progress as a meter, a pull request as the PR it is, the step the loop
 * takes next by name, a folding section heading, and **Move up** / **Move
 * down** as quiet icon controls that show where the row or card is pointed
 * at, focused or selected — reordering is rare (J3), so it is never the
 * loudest thing on a row.
 */
import { useState, type ReactNode } from 'react';
import { Badge, Icon, IconButton, Text, Tooltip } from '@aflow/design-system';
import type { PlanRootState } from '@aflow/schemas';
import { PLAN_NEXT_LABEL, pullRequestChipLabel } from '../../lib/plan-board.js';
import type { PlanNodePlacer } from './PlanBoard.js';
import './plan-page.css';

/** A plan's state as a dot in its colour; the words beside it name the state. */
export function StateDot({ state }: { state: PlanRootState }) {
  return <span aria-hidden className="plan-state-dot" data-state={state} />;
}

/** A hairline meter of closed of all; its count is said beside it. */
export function ProgressMeter({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span aria-hidden className="plan-meter">
      <span className="plan-meter__fill" style={{ width: `${String(share)}%` }} />
    </span>
  );
}

/** The dot between two facts on a meta line. */
export function MetaSep() {
  return (
    <span aria-hidden className="plan-meta-sep">
      ·
    </span>
  );
}

/** A heading's dot, in the colour of the column or lane it heads. */
export function HeadingDot({ color }: { color: string }) {
  return <span aria-hidden className="plan-heading-dot" style={{ background: color }} />;
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

/** A section heading that folds what is under it. */
export function Disclosure({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="plan-disclosure" aria-expanded={expanded} onClick={onToggle}>
      <span aria-hidden className="plan-disclosure__caret">
        <Icon name="caret-right" size={12} weight="bold" />
      </span>
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
 * pinned to the revision the page read. The controls are quiet icons the host
 * reveals (`plan-reveal-host`); a refusal is its own element, so the host can
 * say it where it reads, and it is never hidden with the controls.
 */
export function useMoveControls(
  node: PlanMovable,
  moves: { above?: { nodeId: string }; below?: { nodeId: string } } | undefined,
  onPlace: PlanNodePlacer,
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
        className="plan-quiet-controls"
        role="group"
        aria-label="Order"
        data-plan-move={node.nodeId}
        {...(pending ? { 'data-pending': 'true' } : {})}
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
