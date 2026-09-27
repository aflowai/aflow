'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Badge, Icon, Input, MenuItem, Popover, Row, Text } from '@aflow/design-system';

import { ParticipantBadge } from '../room/ParticipantBadge.js';
import { conversationTitle } from '../../lib/conversation-title.js';
import type { Session } from '../../lib/types.js';
import { formatAgo } from './WorkbenchRunRow.js';

export interface ConversationPresence {
  userId: string;
  driving?: boolean | undefined;
}

export interface WorkbenchConversationRowProps {
  session: Session;
  /** Absent for the viewer's own conversations in a solo space. */
  ownerName: string | null;
  ownerAvatarUrl?: string | null;
  presence: ConversationPresence[];
  personFor: (userId: string) => { displayName?: string; avatarUrl?: string | null } | undefined;
  unread: number;
  unreadLabel: string;
  onOpen: () => void;
  onRename: (title: string | null) => void;
  onRegenerate: () => void;
  /**
   * False for a viewer. The actions the menu holds all need session write
   * permission, so offering them to someone the API will refuse is a control
   * that can only fail — the chat header hides them on the same test.
   */
  canEdit: boolean;
}

/**
 * One conversation in the Workbench's list.
 *
 * Two lines when there is something to say on the second: the name on top,
 * and under it the one-line synopsis with the time it was last spoken in.
 * Everything else the row used to lead with — status, owner, presence — stays
 * secondary, because none of them answer the question someone scanning this
 * list is asking, which is "which one was I working in".
 *
 * The name is a `<span>` inside the row's button rather than a control of its
 * own: clicking anywhere opens the conversation, and renaming is reached
 * through the row's menu. A rename swaps the name for an input in place, so
 * the row does not jump while it is being edited.
 */
export function WorkbenchConversationRow({
  session,
  ownerName,
  ownerAvatarUrl = null,
  presence,
  personFor,
  unread,
  unreadLabel,
  onOpen,
  onRename,
  onRegenerate,
  canEdit,
}: WorkbenchConversationRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const title = conversationTitle(session);
  const summary = session.metadata?.summary ?? null;
  const isManual = session.metadata?.titleSource === 'manual';
  const activeAt = session.lastActivityAt ?? session.updatedAt ?? session.createdAt;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    setDraft(session.metadata?.title ?? '');
    setEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    // An empty box is a cancelled edit, not a request to clear the name —
    // handing the conversation back to its automatic name is its own menu row.
    if (next.length > 0 && next !== session.metadata?.title) onRename(next);
  };

  const shellStyle: CSSProperties = {
    display: 'flex',
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    gap: 'var(--space-2)',
    padding: 'var(--space-2) 0 var(--space-2) var(--space-3)',
    border: 'none',
    background: 'transparent',
    textAlign: 'left',
    color: 'var(--color-text-primary)',
  };

  // While the name is being edited the shell is a plain div, not the row's
  // button: an input inside a button is invalid, and it leaves a screen reader
  // announcing a button where someone is typing a name.
  const shellContent = (
    <>
      <Icon
        name="chat-dots"
        size="sm"
        style={{ color: 'var(--color-content-muted)', marginTop: 2, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Row gap="xs" align="center" style={{ minWidth: 0 }}>
          {editing ? (
            <Input
              ref={inputRef}
              value={draft}
              aria-label="Conversation name"
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onBlur={commit}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              style={{ height: 26, fontSize: 'var(--font-size-sm)' }}
            />
          ) : (
            <Text
              size="sm"
              weight={unread > 0 ? 'semibold' : 'normal'}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </Text>
          )}
          {presence.slice(0, 3).map((p, i) => (
            <ParticipantBadge
              key={p.userId}
              name={personFor(p.userId)?.displayName ?? 'Someone'}
              avatarUrl={personFor(p.userId)?.avatarUrl ?? null}
              role={undefined}
              driving={p.driving === true}
              overlapping={i > 0}
            />
          ))}
          {unread > 0 ? (
            <Badge variant="accent" aria-label={`${unreadLabel} unread`}>
              {unreadLabel}
            </Badge>
          ) : null}
          {session.status === 'FAILED' && <Badge variant="failed">Failed</Badge>}
          {/* Owner and time ride the name's line, not the synopsis's. Sharing
                the second line left the synopsis a third of the row and cut it
                at the first clause — and the synopsis is the part that says
                which conversation this is.

                The owner is a face rather than a name for the same reason: a
                spelled-out name is a hundred pixels the title then loses, and
                whose conversation this is reads faster from the avatar anyway. */}
          {ownerName ? (
            <ParticipantBadge
              name={ownerName}
              avatarUrl={ownerAvatarUrl}
              role={undefined}
              driving={false}
              overlapping={false}
              size={18}
            />
          ) : null}
          <Text size="xs" color="muted" style={{ flexShrink: 0 }}>
            {formatAgo(activeAt)}
          </Text>
        </Row>
        {/* Absent, not blank, when there is no synopsis: an unnamed row
              collapses to one line rather than reserving space for nothing. */}
        {summary ? (
          <Text
            size="xs"
            color="muted"
            style={{
              display: 'block',
              marginTop: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </Text>
        ) : null}
      </div>
    </>
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        flexShrink: 0,
        gap: 'var(--space-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--color-surface-2)',
        paddingRight: 'var(--space-1)',
      }}
    >
      {editing ? (
        <div style={shellStyle}>{shellContent}</div>
      ) : (
        <button type="button" onClick={onOpen} style={{ ...shellStyle, cursor: 'pointer' }}>
          {shellContent}
        </button>
      )}
      {canEdit ? (
        <Popover
          placement="bottom-end"
          minWidth={232}
          aria-label="Conversation actions"
          trigger={({ ref, open, toggle }) => (
            <button
              ref={ref}
              type="button"
              aria-label={`Actions for ${title}`}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'center',
                padding: 'var(--space-1)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                background: open ? 'var(--color-surface-3)' : 'transparent',
                color: 'var(--color-content-muted)',
                cursor: 'pointer',
              }}
            >
              <Icon name="dots-three-vertical" size="sm" />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuItem
                icon={<Icon name="pencil" size="sm" />}
                label="Rename"
                onClick={() => {
                  close();
                  startRename();
                }}
              />
              <MenuItem
                icon={<Icon name="refresh" size="sm" />}
                label="Regenerate name"
                {...(isManual ? { description: 'Refreshes the name behind yours' } : {})}
                onClick={() => {
                  close();
                  onRegenerate();
                }}
              />
              {isManual ? (
                <MenuItem
                  icon={<Icon name="undo" size="sm" />}
                  label="Use automatic name"
                  onClick={() => {
                    close();
                    onRename(null);
                  }}
                />
              ) : null}
            </>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
