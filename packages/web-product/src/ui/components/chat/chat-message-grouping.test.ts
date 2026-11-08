/**
 * Grouping builds new render items on every pass. Items whose fields hold the
 * same values keep the previous object, so the memoized rows they feed see
 * equal props.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationItem, Message } from '../../lib/types.js';
import { groupConversationItems, reuseUnchangedRenderItems } from './chat-message-grouping.js';

function message(id: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: id, timestamp: '2026-11-07T10:00:00.000Z', ...extra };
}

function items(messages: Message[]): ConversationItem[] {
  return messages.map((m) => ({ kind: 'message', message: m }));
}

const tool = (id: string) => message(id, { isInterim: true, senderName: 'memory.read' });

describe('reuseUnchangedRenderItems', () => {
  it('keeps message rows and interim groups whose messages are the same objects', () => {
    const shown = [message('a1'), tool('t1'), tool('t2'), message('a2')];
    const first = groupConversationItems(items(shown));
    const older = message('a0');
    const next = reuseUnchangedRenderItems(first, groupConversationItems(items([older, ...shown])));

    expect(next).toHaveLength(first.length + 1);
    first.forEach((ri, i) => {
      expect(next[i + 1]).toBe(ri);
    });
    expect(next[0]).toMatchObject({ kind: 'message', message: older });
  });

  it('replaces an interim group that gained a message', () => {
    const shown = [message('a1'), tool('t1')];
    const first = groupConversationItems(items(shown));
    const next = reuseUnchangedRenderItems(
      first,
      groupConversationItems(items([...shown, tool('t2')])),
    );
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1]).toMatchObject({ kind: 'interim-group', messages: [shown[1], { id: 't2' }] });
  });

  it('replaces a message row whose message object changed', () => {
    const first = groupConversationItems(items([message('a1')]));
    const next = reuseUnchangedRenderItems(first, groupConversationItems(items([message('a1')])));
    expect(next[0]).not.toBe(first[0]);
  });
});
