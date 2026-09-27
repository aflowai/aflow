/**
 * The line says "the room moved on without you". The bug it exists to prevent
 * is the one that shows up on the very first message of a brand-new room: your
 * own sentence, with an unread line above it.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationItem } from '@aflow/run-view';
import { findFirstUnread } from './findFirstUnread.js';

const ME = '00000000-0000-4000-8000-00000000c0a2';
const SARA = '00000000-0000-4000-8000-00000000e5a1';

function msg(
  id: string,
  messageSeq: number | undefined,
  role: 'user' | 'assistant',
  authorUserId?: string,
): ConversationItem {
  return {
    kind: 'message',
    message: {
      id,
      role,
      content: id,
      timestamp: '2026-08-01T10:00:00.000Z',
      ...(messageSeq !== undefined ? { messageSeq } : {}),
      ...(authorUserId ? { authorUserId } : {}),
    },
  } as ConversationItem;
}

describe('where the unread line goes', () => {
  it('never above your own message', () => {
    // The reported bug: open a room, say the first thing in it, and a line
    // appears above what you just wrote.
    const items = [msg('mine', 1, 'user', ME)];
    expect(findFirstUnread(items, 0, ME)).toBeNull();
  });

  it('never above your own message before it has been attributed', () => {
    // The optimistic echo carries no author yet.
    const items = [msg('echo', 1, 'user')];
    expect(findFirstUnread(items, 0, ME)).toBeNull();
  });

  it('above the first thing someone else said', () => {
    const items = [msg('mine', 1, 'user', ME), msg('theirs', 2, 'user', SARA)];
    expect(findFirstUnread(items, 0, ME)?.id).toBe('theirs');
  });

  it('skips what you had already read', () => {
    const items = [msg('old', 1, 'user', SARA), msg('new', 2, 'user', SARA)];
    expect(findFirstUnread(items, 1, ME)?.id).toBe('new');
  });

  it('draws nothing when there is nothing new', () => {
    const items = [msg('old', 1, 'user', SARA)];
    expect(findFirstUnread(items, 1, ME)).toBeNull();
  });

  it('ignores messages that carry no position', () => {
    // The agent's replies are not positions in the room's conversation, so
    // they cannot anchor the line.
    const items = [msg('reply', undefined, 'assistant'), msg('theirs', 1, 'user', SARA)];
    expect(findFirstUnread(items, 0, ME)?.id).toBe('theirs');
  });

  it('draws nothing when the reader has no marker at all', () => {
    const items = [msg('theirs', 1, 'user', SARA)];
    expect(findFirstUnread(items, null, ME)).toBeNull();
  });
});
