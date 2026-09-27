import type { ConversationItem } from '@aflow/run-view';

/**
 * Where to draw the line when someone comes back to a room.
 *
 * The first message past the position they had reached — but never one of
 * their own. Your own sentence is not what you came back to read, and without
 * that rule, opening a room you just spoke in draws a line above the thing you
 * only just said. It also holds when the read marker is missing entirely,
 * which is the state a brand-new room is in.
 *
 * Positions are allocated to what people say, so an agent's reply carries none
 * and cannot anchor the line; the line marks where the conversation resumed.
 */
export function findFirstUnread(
  items: readonly ConversationItem[],
  seenMessageSeq: number | null,
  currentUserId: string | undefined,
): { id: string; timestamp: string } | null {
  if (seenMessageSeq == null) return null;

  for (const item of items) {
    if (item.kind !== 'message') continue;
    const { messageSeq, authorUserId, role, id, timestamp } = item.message;
    if (typeof messageSeq !== 'number' || messageSeq <= seenMessageSeq) continue;

    // An unattributed user message is the sender's own optimistic echo — it
    // has not been folded with its server-stamped author yet.
    const isMine = role === 'user' && (authorUserId == null || authorUserId === currentUserId);
    if (isMine) continue;

    return { id, timestamp };
  }
  return null;
}
