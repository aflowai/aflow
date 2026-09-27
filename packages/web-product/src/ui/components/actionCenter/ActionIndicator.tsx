'use client';

import { IndicatorButton } from '@aflow/design-system';
import { useOptionalCybernetic } from '../cybernetic-provider.js';
import { useActiveSurface } from '../../hooks/use-active-surface.js';
import { useActionCenter, type UseActionCenterResult } from '../../hooks/use-action-center.js';

export interface ActionIndicatorProps {
  spaceId: string;
  /** Optional root session — used by the Coach feed's "system status" line when present. */
  rootSessionId?: string | null;
  /** Click handler — parent decides what to open. */
  onClick: () => void;
}

type CoachLifecycle = 'idle' | 'reviewing' | 'stalled';

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
  const label = labelFor(total, hasCoach ? lifecycle : null);
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

function labelFor(total: number, lifecycle: CoachLifecycle | null): string {
  if (lifecycle === 'stalled') {
    return total > 0
      ? `Action Center — ${String(total)} pending · Coach stalled`
      : 'Coach is stalled — investigate (no pending actions)';
  }
  if (total > 0) {
    return lifecycle === 'reviewing'
      ? `Action Center — ${String(total)} pending · Coach reviewing`
      : `Action Center — ${String(total)} pending`;
  }
  if (lifecycle === 'reviewing') return 'Coach is reviewing — no pending actions';
  return 'Action Center — no pending actions';
}
