'use client';

import { useMemo, type CSSProperties, type ReactElement } from 'react';
import { Badge } from '@aflow/design-system';
import { PLAN_STATE_LABELS } from '@aflow/schemas';
import { useActionCenter } from '../../hooks/use-action-center.js';
import { planPendingCount, type PlanPendingCount } from '../../lib/plan-pending-count.js';

// Kept here rather than imported from the plan page's parts: the shell mounts this on every page.
const srOnly: CSSProperties = {
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

/**
 * The plan items waiting in the space's Action Center. It reads
 * `useActionCenter`, the query key and the broker the bell and the chat
 * already hold, so it adds no HTTP read where either is mounted.
 */
export function usePlanPendingCount(spaceId: string | null): PlanPendingCount {
  const { items } = useActionCenter(spaceId);
  return useMemo(() => planPendingCount(items), [items]);
}

/**
 * The Plan entry's count: digits only, never a step's text, so no markdown
 * reaches the sidebar raw. The words after it name the state for a screen
 * reader: "3 pending".
 */
export function PlanNavCount({ pending }: { pending: PlanPendingCount }): ReactElement | null {
  if (pending.count === 0) return null;
  const name = `${pending.label} ${PLAN_STATE_LABELS.pendingCountNoun}`;
  return (
    <Badge variant="warning" title={name} data-plan-nav-count={pending.label}>
      {pending.label}
      <span style={srOnly}> {PLAN_STATE_LABELS.pendingCountNoun}</span>
    </Badge>
  );
}
