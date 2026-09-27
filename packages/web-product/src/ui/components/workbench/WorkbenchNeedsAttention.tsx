'use client';

import { useMemo } from 'react';
import { Badge, Column, Row, Text } from '@aflow/design-system';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { ActionCenterItemCard } from '../actionCenter/ActionCenterLane.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { AssignControl } from '../actionCenter/AssignControl.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * Needs attention (Plan 228 §3.1): human-in-the-loop items that are blocking
 * work right now — a connection to authorize, an approval, an input. Coach
 * proposals are deliberately NOT here (they're a distinct, non-blocking review
 * surface — see WorkbenchCoach); the operator never chats with Coach, so
 * mixing the two reads as noise. Hidden entirely when nothing is pending.
 *
 * Items that are view-only here (e.g. a workflow human-task, resolved from the
 * run surface) render as a one-line notice — the run is expandable right below
 * in Skills, so a full resolve form + "view-only" explainer would just be
 * noise. Actionable items keep the full resolution card.
 *
 * A request that names someone else stays visible — a teammate should be able
 * to see the team is blocked — but it does not claim this person's attention:
 * it sits below what is actually theirs, says who it is waiting on, and is not
 * counted. Telling everyone to act on everything is how a shared queue becomes
 * something nobody reads.
 */
export function WorkbenchNeedsAttention({
  state,
  spaceId,
}: {
  state: UseActionCenterResult;
  spaceId: string;
}) {
  const items = useMemo(
    () => [...state.lanes.connections, ...state.lanes.approvals, ...state.lanes.inputs],
    [state.lanes.connections, state.lanes.approvals, state.lanes.inputs],
  );
  const personFor = useSpacePeople(spaceId);

  if (items.length === 0) return null;

  const mine = items.filter((i) => i.audience !== 'someone_else');
  const theirs = items.filter((i) => i.audience === 'someone_else');
  // Being able to hand a request on is not being able to answer it: someone
  // holding a request whose answer is not theirs gets the one-line notice and
  // the picker, not a resolution form whose controls are all disabled.
  const actionable = mine.filter((i) => canAnswer(i));
  const viewOnly = mine.filter((i) => !canAnswer(i));

  return (
    <WorkbenchSection
      title="Needs attention"
      icon="bell"
      meta={mine.length > 0 ? <Badge variant="warning">{String(mine.length)}</Badge> : null}
    >
      <Column gap="sm">
        {actionable.map((item) => (
          <ActionCenterItemCard key={item.id} item={item} state={state} />
        ))}
        {viewOnly.map((item) => (
          <ViewOnlyNotice key={item.id} item={item} state={state} spaceId={spaceId} />
        ))}
        {theirs.map((item) => (
          <WaitingOnSomeoneElse
            key={item.id}
            item={item}
            state={state}
            spaceId={spaceId}
            waitingOn={waitingOnLabel(item, personFor)}
          />
        ))}
      </Column>
    </WorkbenchSection>
  );
}

/** Whether this person can actually answer, as opposed to merely route. */
function canAnswer(item: ActionCenterItem): boolean {
  return item.allowedActions.some((a) => a !== 'reassign');
}

/**
 * Who a request is waiting on, in words: the person it was handed to when it
 * was, otherwise whoever its policy names. Falls back to the raw entry so a
 * role name ("editor") or an id that is no longer a member still reads as
 * something rather than disappearing.
 */
export function waitingOnLabel(
  item: Pick<ActionCenterItem, 'assignee' | 'resolverPolicy'>,
  personFor: (userId: string) => { displayName: string } | undefined,
): string {
  if (item.assignee) return personFor(item.assignee)?.displayName ?? 'a teammate';
  const candidates = item.resolverPolicy?.candidateResolvers ?? [];
  const names = candidates.map((entry) => personFor(entry)?.displayName ?? entry);
  if (names.length === 0) return 'someone else';
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, 2).join(', ')} +${String(names.length - 2)}`;
}

/**
 * Visible so the team can see it is blocked; quiet so it is not mistaken for
 * yours. Carries the routing control anyway — a misrouted request is most
 * often noticed by someone it is not assigned to.
 */
function WaitingOnSomeoneElse({
  item,
  state,
  spaceId,
  waitingOn,
}: {
  item: ActionCenterItem;
  state: UseActionCenterResult;
  spaceId: string;
  waitingOn: string;
}) {
  return (
    <Row
      gap="sm"
      align="center"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-1)',
        opacity: 0.7,
      }}
    >
      <Text size="sm" color="muted" style={{ flex: 1, minWidth: 0 }} truncate>
        {item.title}
      </Text>
      <Text size="xs" color="muted" style={{ flexShrink: 0 }}>
        Waiting on {waitingOn}
      </Text>
      <AssignControl item={item} state={state} spaceId={spaceId} />
    </Row>
  );
}

/**
 * Compact "waiting on you" signal — the run below carries the actual approve
 * UI, so this is just a pointer, not a form. Carries the picker: this is also
 * where someone lands who holds a request they cannot answer, and passing it
 * on is the one thing they can do about it.
 */
function ViewOnlyNotice({
  item,
  state,
  spaceId,
}: {
  item: ActionCenterItem;
  state: UseActionCenterResult;
  spaceId: string;
}) {
  return (
    <Row
      gap="sm"
      align="center"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-2)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--color-warning-default)',
          flexShrink: 0,
        }}
      />
      <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
        {item.title}
      </Text>
      <AssignControl item={item} state={state} spaceId={spaceId} />
    </Row>
  );
}
