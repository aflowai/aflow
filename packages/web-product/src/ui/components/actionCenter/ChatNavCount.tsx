'use client';

import type { ReactElement } from 'react';
import { Badge } from '@aflow/design-system';
import { useActionCenter } from '../../hooks/use-action-center.js';
import { navCountSrOnly } from '../plan/PlanNavCount.js';

/**
 * The Action Center items waiting on the operator, as the bell counts them
 * (`counts.actionable`). It reads `useActionCenter`, the query key and the
 * broker the bell, the chat and the Plan count already hold, so it adds no
 * HTTP read.
 */
export function useActionCenterPendingCount(spaceId: string | null): number {
  return useActionCenter(spaceId).counts.actionable;
}

/**
 * The Chat entry's count, drawn as the Plan entry's is: digits only, with
 * "pending" after them for a screen reader. Nothing at zero.
 */
export function ChatNavCount({ count }: { count: number }): ReactElement | null {
  if (count <= 0) return null;
  const label = String(count);
  return (
    <Badge variant="warning" title={`Action Center — ${label} pending`} data-chat-nav-count={label}>
      {label}
      <span style={navCountSrOnly}> pending</span>
    </Badge>
  );
}
