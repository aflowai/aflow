'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon, Input, MenuItem, Popover, Text, Tooltip } from '@aflow/design-system';

import { UNTITLED_CONVERSATION } from '../../lib/conversation-title.js';
import { useConversationMetadata, useSessionRename } from '../../hooks/use-session-metadata.js';

/**
 * What the open conversation is called, in the header.
 *
 * The header carried no title while every chat was the only one — "the
 * conversation names itself" was true when there was one of them. With several
 * in a space, the name is the one piece of chrome that says which room you are
 * standing in, and it is where renaming belongs: at the thing being named.
 *
 * Quiet by construction. It renders as text, not a control; the pencil appears
 * on hover and focus, and the menu holds the rest. A chat header that shouted
 * its own title would compete with the conversation under it.
 */
export function ChatConversationTitle({
  spaceId,
  sessionId,
  canEdit,
}: {
  spaceId: string | null;
  sessionId: string | null;
  canEdit: boolean;
}) {
  const metadata = useConversationMetadata(spaceId, sessionId);
  const { rename, regenerate } = useSessionRename(spaceId ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Nothing to name yet. An empty header beats a placeholder that changes into
  // something else a second later.
  if (!sessionId || !metadata) return null;

  const title = metadata.title ?? UNTITLED_CONVERSATION;
  const isManual = metadata.titleSource === 'manual';

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== metadata.title) {
      void rename({ sessionId, title: next, expectedRevision: metadata.revision });
    }
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        aria-label="Conversation name"
        autoFocus
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
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
        style={{ height: 28, maxWidth: 360, fontSize: 'var(--font-size-base)' }}
      />
    );
  }

  const name = (
    <Text
      size="base"
      style={{
        maxWidth: 360,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: metadata.title ? 'var(--color-content-primary)' : 'var(--color-content-muted)',
      }}
    >
      {title}
    </Text>
  );

  if (!canEdit) return name;

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', minWidth: 0 }}
    >
      {metadata.summary ? <Tooltip content={metadata.summary}>{name}</Tooltip> : name}
      <Popover
        placement="bottom-start"
        minWidth={220}
        aria-label="Conversation name actions"
        trigger={({ ref, open, toggle }) => (
          <button
            ref={ref}
            type="button"
            aria-label="Rename conversation"
            aria-expanded={open}
            onClick={toggle}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: 2,
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: open ? 'var(--color-surface-3)' : 'transparent',
              color: 'var(--color-content-muted)',
              cursor: 'pointer',
              // Present for keyboard and pointer alike, but not competing with
              // the name until someone reaches for it.
              opacity: open ? 1 : 0.55,
            }}
          >
            <Icon name="pencil" size="sm" />
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
                setDraft(metadata.title ?? '');
                setEditing(true);
              }}
            />
            <MenuItem
              icon={<Icon name="refresh" size="sm" />}
              label="Regenerate name"
              {...(metadata.diagnostic
                ? { description: metadata.diagnostic.message }
                : isManual
                  ? { description: 'Refreshes the name behind yours' }
                  : {})}
              onClick={() => {
                close();
                void regenerate(sessionId);
              }}
            />
            {isManual ? (
              <MenuItem
                icon={<Icon name="undo" size="sm" />}
                label="Use automatic name"
                onClick={() => {
                  close();
                  void rename({
                    sessionId,
                    title: null,
                    expectedRevision: metadata.revision,
                  });
                }}
              />
            ) : null}
          </>
        )}
      </Popover>
    </span>
  );
}
