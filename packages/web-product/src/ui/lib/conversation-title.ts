import type { SessionMetadata } from './types.js';

/**
 * The name a conversation goes by in a list.
 *
 * A session with no generated name yet still has to be pickable out of a
 * column of them, and "2 hours ago" is what this feature exists to replace —
 * so the placeholder says what the row is rather than when it was.
 */
export const UNTITLED_CONVERSATION = 'New conversation';

export function conversationTitle(session: { metadata?: SessionMetadata }): string {
  const title = session.metadata?.title;
  return title && title.length > 0 ? title : UNTITLED_CONVERSATION;
}
