'use client';

import { IndicatorButton } from '@aflow/design-system';
import { useOptionalCybernetic } from '../cybernetic-provider.js';
import { useActiveSurface } from '../../hooks/use-active-surface.js';
import { useActionCenter, type UseActionCenterResult } from '../../hooks/use-action-center.js';
import { coachProposalCount } from '../../hooks/use-action-center-lanes.js';

export interface ActionIndicatorProps {
  spaceId: string;
  /** Optional root session — used by the Coach feed's "system status" line when present. */
  rootSessionId?: string | null;
  /** Click handler — parent decides what to open. */
  onClick: () => void;
}

export type CoachLifecycle = 'idle' | 'reviewing' | 'stalled';

export function ActionIndicator(props: ActionIndicatorProps) {
  // Splitting on provider presence at the component boundary keeps each
  // child's hook order constant.
  const cybernetic = useOptionalCybernetic();
  return cybernetic ? (
    <ActionIndicatorWithCoach {...props} rootSessionId={props.rootSessionId ?? null} />
  ) : (
    <ActionIndicatorUniversal {...props} />
  );
}

/**
 * Plain variant — non-cybernetic spaces. No Coach hooks; tone + label
 * derive entirely from the Action Center count.
 */
function ActionIndicatorUniversal({ spaceId, onClick }: ActionIndicatorProps) {
  const actionCenter = useActionCenter(spaceId);
  return <Shell actionCenter={actionCenter} lifecycle="idle" hasCoach={false} onClick={onClick} />;
}

/**
 * Adorned variant — cybernetic spaces. Adds Coach lifecycle pulse +
 * stalled-tone overlay on top of the universal shell.
 */
function ActionIndicatorWithCoach({
  spaceId,
  rootSessionId,
  onClick,
}: ActionIndicatorProps & { rootSessionId: string | null }) {
  const actionCenter = useActionCenter(spaceId);
  // Provider-present branch: read the snapshot from the
  const { snapshot } = useActiveSurface(spaceId, rootSessionId);
  const lifecycle: CoachLifecycle = snapshot?.coach?.lifecycle ?? 'idle';
  return (
    <Shell actionCenter={actionCenter} lifecycle={lifecycle} hasCoach={true} onClick={onClick} />
  );
}

/**
 * Shared presentation — both variants render through here.
 */
function Shell({
  actionCenter,
  lifecycle,
  hasCoach,
  onClick,
}: {
  actionCenter: UseActionCenterResult;
  lifecycle: CoachLifecycle;
  hasCoach: boolean;
  onClick: () => void;
}) {
  const total = actionCenter.counts.actionable;
  const tone = total > 0 || (hasCoach && lifecycle === 'stalled') ? 'warning' : 'idle';
  const pulse = hasCoach && lifecycle === 'reviewing';
  const label = indicatorLabel(
    total,
    coachProposalCount(actionCenter.lanes),
    hasCoach ? lifecycle : null,
  );
  return (
    <IndicatorButton
      icon="bell"
      label={label}
      count={total}
      tone={tone}
      pulse={pulse}
      onClick={onClick}
    />
  );
}

/**
 * The count leaves Coach proposals out, so a zero count is not an empty
 * Action Center while they wait. The hint names them without counting them.
 */
export function indicatorLabel(
  total: number,
  coachProposals: number,
  lifecycle: CoachLifecycle | null,
): string {
  const nothingCounted =
    coachProposals > 0 ? 'Coach proposals wait in Coach review' : 'no pending actions';
  if (lifecycle === 'stalled') {
    return total > 0
      ? `Action Center — ${String(total)} pending · Coach stalled`
      : `Coach is stalled — investigate (${nothingCounted})`;
  }
  if (total > 0) {
    return lifecycle === 'reviewing'
      ? `Action Center — ${String(total)} pending · Coach reviewing`
      : `Action Center — ${String(total)} pending`;
  }
  if (lifecycle === 'reviewing') return `Coach is reviewing — ${nothingCounted}`;
  return `Action Center — ${nothingCounted}`;
}
