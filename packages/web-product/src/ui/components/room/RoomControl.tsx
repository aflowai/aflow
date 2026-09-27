'use client';

/**
 * One control for who is in this room.
 *
 * The roster (who belongs) and presence (who is looking right now) are
 * different facts, but they answer the same glance — "who is here?" — so they
 * share one compact trigger and one panel. The trigger stays a count because
 * the header is a single row on phones; faces live in the panel, where there
 * is room to name them.
 */
import type React from 'react';
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Column, Icon, Popover, Row, Spinner, Text } from '@aflow/design-system';
import type { SessionRosterEntry, PresenceParticipant } from '@aflow/schemas';
import { useApiQuery, useApiMutation } from '../../hooks/useApiQuery.js';
import { useSpaceRoster, useSpacePeople } from '../../hooks/use-space-people.js';
import { useCurrentUser } from '../user-avatar.js';
import { ParticipantBadge } from './ParticipantBadge.js';

export function RoomControl({
  spaceId,
  sessionId,
  participants: present,
  draftInvitees,
  onDraftInviteesChange,
}: {
  spaceId: string | null | undefined;
  sessionId: string | null | undefined;
  /** Live presence — who is looking right now. */
  participants: PresenceParticipant[];
  /** Compose-time picker: people to invite when the session is born. */
  draftInvitees?: string[];
  onDraftInviteesChange?: (userIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const personFor = useSpacePeople(spaceId);
  const rosterKey = ['session', sessionId ?? 'none', 'participants'];

  const roster = useApiQuery<{ participants?: SessionRosterEntry[] }>({
    key: rosterKey,
    path: `/sessions/${sessionId ?? ''}/participants`,
    ...(spaceId ? { spaceId } : {}),
    enabled: Boolean(spaceId && sessionId),
    staleTime: 15_000,
  });

  const { people } = useSpaceRoster(spaceId);

  const invite = useApiMutation<{ userId: string }, { member: unknown }>({
    path: () => `/sessions/${sessionId ?? ''}/participants/invite`,
    ...(spaceId ? { spaceId } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rosterKey });
    },
  });

  const members = useMemo(() => roster.data?.participants ?? [], [roster.data]);
  const memberIds = useMemo(
    () => new Set(members.map((participant) => participant.userId)),
    [members],
  );
  const invitable = useMemo(
    () => people.filter((person) => !memberIds.has(person.userId)),
    [people, memberIds],
  );
  const presenceOf = useMemo(
    () => new Map(present.map((participant) => [participant.userId, participant])),
    [present],
  );

  const draftMode = !sessionId && onDraftInviteesChange !== undefined;
  if (!spaceId || (!sessionId && !draftMode)) return null;
  // A solo space has nobody to invite and nobody to list — the control would
  // be furniture. It appears when the space is actually shared.
  if (people.length <= 1 && members.length <= 1) return null;

  const draft = draftInvitees ?? [];
  const joined = members.filter((participant) => participant.status === 'joined');
  const invited = members.filter((participant) => participant.status === 'invited');

  if (draftMode) {
    const toggle = (userId: string) => {
      onDraftInviteesChange(
        draft.includes(userId) ? draft.filter((id) => id !== userId) : [...draft, userId],
      );
    };
    const pickable = people.filter((person) => person.userId !== currentUser?.userId);
    if (pickable.length === 0) return null;
    return (
      <Popover
        placement="bottom-end"
        width={280}
        trigger={({ ref, toggle: open, open: isOpen }) => (
          <span ref={ref as React.Ref<HTMLSpanElement>} style={{ display: 'inline-flex' }}>
            <Button
              variant={isOpen || draft.length > 0 ? 'secondary' : 'ghost'}
              size="sm"
              onClick={open}
              aria-label="Start with people"
            >
              <Icon name="users" size="sm" />
              {draft.length > 0 ? <span style={{ marginLeft: 4 }}>+{draft.length}</span> : null}
            </Button>
          </span>
        )}
      >
        <Column gap="sm" padding="sm">
          <Text size="xs" weight="semibold" color="muted">
            Start with people
          </Text>
          <Text size="xs" color="muted">
            They are invited the moment the conversation begins.
          </Text>
          {pickable.map((person) => {
            const picked = draft.includes(person.userId);
            return (
              <Row key={person.userId} gap="sm" align="center" justify="between">
                <Text size="sm">{person.displayName}</Text>
                <Button
                  variant={picked ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    toggle(person.userId);
                  }}
                >
                  {picked ? 'Invited ✓' : 'Invite'}
                </Button>
              </Row>
            );
          })}
        </Column>
      </Popover>
    );
  }

  const others = present.filter((participant) => participant.userId !== currentUser?.userId);
  const someoneTyping = others.some((participant) => participant.activity === 'typing');
  const label = `Who is here — ${String(joined.length)} in this session${
    invited.length > 0 ? `, ${String(invited.length)} invited` : ''
  }`;

  return (
    <Popover
      placement="bottom-end"
      width={280}
      trigger={({ ref, toggle, open }) => (
        <span ref={ref as React.Ref<HTMLSpanElement>} style={{ display: 'inline-flex' }}>
          <Button
            variant={open ? 'secondary' : 'ghost'}
            size="sm"
            onClick={toggle}
            aria-label={label}
          >
            <Icon name="users" size="sm" />
            <span style={{ marginLeft: 4 }}>{joined.length}</span>
            {/* Presence rides the roster count as a dot rather than its own
                control — the header is one row, and "someone is here/typing"
                is a glance, not a number. */}
            {others.length > 0 ? (
              <span
                aria-hidden
                className={
                  someoneTyping ? 'ds-presence-dot ds-presence-dot--typing' : 'ds-presence-dot'
                }
              />
            ) : null}
          </Button>
        </span>
      )}
    >
      <Column gap="sm" padding="sm">
        <Text size="xs" weight="semibold" color="muted">
          In this session
        </Text>
        {roster.isLoading ? <Spinner size="sm" /> : null}
        {members.map((participant) => {
          const person = personFor(participant.userId);
          const name =
            participant.displayName ?? person?.displayName ?? participant.userId.slice(0, 6);
          const live = presenceOf.get(participant.userId);
          const isYou = participant.userId === currentUser?.userId;
          const state =
            participant.status === 'invited'
              ? 'invited'
              : live?.activity === 'typing'
                ? 'typing…'
                : live
                  ? 'here'
                  : null;
          return (
            <Row key={participant.userId} gap="sm" align="center" justify="between">
              <Row gap="sm" align="center" style={{ minWidth: 0 }}>
                <ParticipantBadge
                  name={name}
                  avatarUrl={person?.avatarUrl ?? null}
                  {...(person?.role ? { role: person.role } : { role: undefined })}
                  driving={live?.driving === true}
                  overlapping={false}
                  size={20}
                />
                <Text size="sm">
                  {name}
                  {isYou ? ' (you)' : ''}
                </Text>
              </Row>
              {state ? (
                <Text size="xs" color="muted">
                  {state}
                </Text>
              ) : null}
            </Row>
          );
        })}
        {invitable.length > 0 ? (
          <>
            <Text size="xs" weight="semibold" color="muted" style={{ marginTop: 4 }}>
              Add people
            </Text>
            {invitable.map((person) => (
              <Row key={person.userId} gap="sm" align="center" justify="between">
                <Text size="sm">{person.displayName}</Text>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={invite.isPending}
                  onClick={() => {
                    invite.mutate({ userId: person.userId });
                  }}
                >
                  Invite
                </Button>
              </Row>
            ))}
          </>
        ) : null}
        {invite.isError ? (
          <Text size="xs" color="muted">
            The invitation could not be sent.
          </Text>
        ) : null}
      </Column>
    </Popover>
  );
}
