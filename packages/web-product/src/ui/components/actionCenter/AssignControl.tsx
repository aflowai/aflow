'use client';

import { useState, type ReactElement } from 'react';
import { Text } from '@aflow/design-system';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { useSpaceRoster } from '../../hooks/use-space-people.js';

/**
 * Hand a request to a person.
 *
 * Routing, not authority: the picker appears for anyone the server lets
 * reroute attention — including people the request's answer is not theirs to
 * give — and the assignee it names gains a leading place on their Workbench,
 * not the right to answer. Rendered wherever the request is visible, because
 * a misrouted item is most often noticed by someone it is NOT assigned to.
 */
export function AssignControl({
  item,
  state,
  spaceId,
}: {
  item: ActionCenterItem;
  state: UseActionCenterResult;
  spaceId: string;
}): ReactElement | null {
  const { people } = useSpaceRoster(spaceId);
  const [busy, setBusy] = useState(false);

  if (!item.allowedActions.includes('reassign')) return null;

  const candidates = people.filter((p) => p.userId !== item.assignee);
  if (candidates.length === 0) return null;

  return (
    <select
      aria-label="Hand this to a teammate"
      value=""
      disabled={busy}
      onChange={(e) => {
        const assigneeUserId = e.target.value;
        if (!assigneeUserId) return;
        setBusy(true);
        void state.resolve(item.id, { kind: 'reassign', assigneeUserId }).finally(() => {
          setBusy(false);
        });
      }}
      style={{
        padding: 'var(--space-1) var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-2)',
        color: 'var(--color-content-muted)',
        fontSize: 'var(--font-size-xs)',
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      <option value="">Hand to…</option>
      {candidates.map((p) => (
        <option key={p.userId} value={p.userId}>
          {p.displayName}
        </option>
      ))}
    </select>
  );
}

/** "For Sara" — whose desk the request is on, said only when it is on one. */
export function AssigneeChip({
  assignee,
  currentUserId,
  personFor,
}: {
  assignee: string | undefined;
  currentUserId: string | undefined;
  personFor: (userId: string | undefined) => { displayName: string } | undefined;
}): ReactElement | null {
  if (!assignee) return null;
  const label =
    assignee === currentUserId
      ? 'For you'
      : `For ${personFor(assignee)?.displayName ?? 'a teammate'}`;
  return (
    <Text size="xs" style={{ color: 'var(--color-accent-default)', flexShrink: 0 }}>
      {label}
    </Text>
  );
}
