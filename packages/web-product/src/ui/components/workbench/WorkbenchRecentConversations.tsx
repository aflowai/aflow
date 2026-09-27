'use client';

import { useMemo } from 'react';
import { SESSION_LIST_LIMIT, sessionListKey } from '../../lib/session-list-query.js';
import { useRouter } from 'next/navigation';
import { Column, Row, Spinner, Text } from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { formatUnread, useRoomActivity } from '../../hooks/use-room-activity.js';
import { useSessionMetadataRefresh, useSessionRename } from '../../hooks/use-session-metadata.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { useCurrentUser } from '../user-avatar.js';
import { useSpace } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { Session } from '../../lib/types.js';
import { WorkbenchConversationRow } from './WorkbenchConversationRow.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * Recent conversations (Plan 228 §3.4): **Helmsman only**. Runner sessions are
 * reflected in Skill runs (and never start on their own), so listing them here
 * would double-count. A Helmsman chat doesn't "end", so idle/paused is the
 * normal resting state and labeling it would be noise. The exception is
 * failure: a FAILED session is rare and actionable, so it gets a badge.
 * Clicking resumes in place.
 *
 * Rows lead with the conversation's name and its synopsis. Recency alone
 * identified them until several conversations in one space made "2 hours ago"
 * a description of nothing; it stays on the row, as the secondary fact it is.
 *
 * This section is **pinned to the bottom of the board**, not stacked in its
 * scroll (see `Workbench`). Getting back to a conversation is the one thing the
 * operator needs from the Workbench no matter how much else is in the space; a
 * skill list long enough to push it past the fold makes the whole pane feel
 * like it lost their history. So the list scrolls inside itself and the header
 * stays put while it does.
 *
 * Its height is negotiated, not reserved — see the style on the section. A band
 * of fixed height is wrong in both directions: it strands whitespace under two
 * conversations, and it holds 40% hostage while a busy board fights for room
 * directly above it.
 */
interface InvitationItem {
  id: string;
  status: string;
  summary: string;
  requestedBy?: { label?: string };
  origin: { type: string; sessionId?: string };
}

/** How many of the shared list this section shows. */
const RECENT_CONVERSATIONS_SHOWN = 8;

export function WorkbenchRecentConversations({
  spaceId,
  spaceSlug,
  onRevealChat,
}: {
  spaceId: string;
  spaceSlug: string;
  onRevealChat?: () => void;
}) {
  const router = useRouter();
  const personFor = useSpacePeople(spaceId);
  // Viewers steer nothing, so the row's rename and regenerate stay off theirs —
  // the same test the chat header applies to the title it holds.
  const { activeSpace } = useSpace();
  const canEdit = activeSpace?.myRole !== 'viewer';
  const currentUser = useCurrentUser();
  // The chat's own session list resolves to this exact key when the Helmsman is
  // the selected flow, and TanStack dedupes by key rather than by URL — so two
  // different `limit`s behind one key mean whichever query mounts first decides
  // what BOTH observers see. Same request here, trimmed for display below.
  const query = useApiQuery<{ sessions?: Session[] }>({
    key: sessionListKey(spaceId, 'platform-role', 'cybernetic-helmsman'),
    path: `/sessions?limit=${String(SESSION_LIST_LIMIT)}&targetKind=platform-role&targetSystemRole=cybernetic-helmsman`,
    spaceId,
    staleTime: 15_000,
    enabled: !!spaceId,
  });

  const invitations = useApiQuery<{ items?: InvitationItem[] }>({
    key: ['space', spaceId, 'action-center', 'session-invitations'],
    path: `/spaces/${spaceId}/action-center?kind=session_invitation`,
    spaceId,
    staleTime: 15_000,
    enabled: !!spaceId,
  });
  const pendingInvites = useMemo(
    () => (invitations.data?.items ?? []).filter((item) => item.status === 'open'),
    [invitations.data],
  );

  const sessionIds = useMemo(
    () => (query.data?.sessions ?? []).map((s) => s.sessionId),
    [query.data],
  );

  const activity = useRoomActivity(spaceId, sessionIds);
  const { rename, regenerate } = useSessionRename(spaceId);
  // A conversation finishing its name is usually not the one anyone has open,
  // so the refresh rides the space channel rather than a per-row subscription.
  useSessionMetadataRefresh(spaceId);

  const sessions = useMemo(() => {
    const list = query.data?.sessions ?? [];
    // The server already orders by the conversation clock; re-sorting here
    // keeps a locally-patched row in place rather than waiting for a refetch.
    return [...list]
      .sort((a, b) => {
        const at = a.lastActivityAt ?? a.updatedAt ?? a.createdAt;
        const bt = b.lastActivityAt ?? b.updatedAt ?? b.createdAt;
        return at < bt ? 1 : -1;
      })
      .slice(0, RECENT_CONVERSATIONS_SHOWN);
  }, [query.data]);

  if (!query.isLoading && sessions.length === 0 && pendingInvites.length === 0) return null;

  return (
    <WorkbenchSection
      title="Recent conversations"
      icon="chat-dots"
      meta={
        pendingInvites.length > 0 ? (
          <Text
            size="xs"
            weight="semibold"
            style={{
              borderRadius: 999,
              padding: '1px 8px',
              background: 'var(--color-accent-bg)',
              color: 'var(--color-accent-fg)',
            }}
          >
            {pendingInvites.length} invitation{pendingInvites.length > 1 ? 's' : ''}
          </Text>
        ) : null
      }
      style={{
        // Negotiates its height with the inventory above instead of reserving a
        // fixed band: content-sized up to 40% when there is room, and the
        // partial shrink factor lets a crowded board buy height back — down to
        // roughly 65% of what this wanted, asymptotically, never to nothing.
        // The floor keeps a row and the header intact at the extreme.
        flexShrink: 0.35,
        minHeight: '5rem',
        maxHeight: '40%',
        overflow: 'hidden',
        borderTop: '1px solid var(--color-border-subtle)',
        padding: 'var(--space-3) var(--space-2) var(--space-2)',
      }}
    >
      <Column gap="xs" style={{ minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin' }}>
        {pendingInvites.map((invite) => (
          <Row
            key={invite.id}
            gap="sm"
            align="center"
            justify="between"
            style={{
              flexShrink: 0,
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-accent-fg)',
              background: 'var(--color-accent-bg)',
            }}
          >
            <Text size="sm">
              {invite.requestedBy?.label ?? 'A teammate'} invited you to a session
            </Text>
            <Row gap="xs">
              <button
                type="button"
                onClick={() => {
                  const target = invite.origin.sessionId;
                  if (target) {
                    onRevealChat?.();
                    router.push(
                      spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(target)}`),
                    );
                  }
                }}
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '3px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--color-accent-fg)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Open
              </button>
            </Row>
          </Row>
        ))}
        {query.isLoading && sessions.length === 0 ? (
          <Row justify="center" style={{ padding: 'var(--space-3)' }}>
            <Spinner size="sm" label="Loading" />
          </Row>
        ) : (
          sessions.map((s) => (
            <WorkbenchConversationRow
              key={s.sessionId}
              session={s}
              // Whose conversation this is. Only worth saying when it is not
              // yours — in a solo space every row would otherwise repeat your
              // own name.
              ownerName={
                s.createdBy && s.createdBy !== currentUser?.userId
                  ? (personFor(s.createdBy)?.displayName ?? 'Someone else')
                  : null
              }
              ownerAvatarUrl={s.createdBy ? (personFor(s.createdBy)?.avatarUrl ?? null) : null}
              presence={activity
                .presenceIn(s.sessionId)
                .filter((p) => p.userId !== currentUser?.userId)}
              personFor={personFor}
              canEdit={canEdit}
              // Awareness, not attention: this says the room moved without
              // you, and stays quieter than the approval and mention cards
              // that ask you to act.
              unread={activity.unreadIn(s.sessionId)}
              unreadLabel={formatUnread(activity.unreadIn(s.sessionId))}
              onOpen={() => {
                onRevealChat?.();
                router.push(
                  spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(s.sessionId)}`),
                );
              }}
              onRename={(title) => {
                void rename({
                  sessionId: s.sessionId,
                  title,
                  ...(s.metadata ? { expectedRevision: s.metadata.revision } : {}),
                });
              }}
              onRegenerate={() => {
                void regenerate(s.sessionId);
              }}
            />
          ))
        )}
      </Column>
    </WorkbenchSection>
  );
}
