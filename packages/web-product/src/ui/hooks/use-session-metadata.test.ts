import { describe, it, expect } from 'vitest';
import { UNTITLED_CONVERSATION, conversationTitle } from '../lib/conversation-title.js';
import type { SessionMetadata } from '../lib/types.js';

const withMetadata = (metadata: Partial<SessionMetadata>) => ({
  metadata: {
    title: null,
    titleSource: null,
    titleState: null,
    summary: null,
    summaryCoverage: null,
    revision: 0,
    updatedAt: null,
    editedByUserId: null,
    pending: false,
    ...metadata,
  } as SessionMetadata,
});

describe('what a conversation is called in a list', () => {
  it('uses the resolved name the server already picked', () => {
    expect(conversationTitle(withMetadata({ title: 'Missing Q3 invoices' }))).toBe(
      'Missing Q3 invoices',
    );
  });

  it('says what the row is, not when it was, before a name exists', () => {
    // "2 hours ago" is the label this feature replaces — a row with no name
    // yet must not fall back to it.
    expect(conversationTitle(withMetadata({ title: null }))).toBe(UNTITLED_CONVERSATION);
    expect(conversationTitle({})).toBe(UNTITLED_CONVERSATION);
  });

  it('treats an empty name as no name', () => {
    expect(conversationTitle(withMetadata({ title: '' }))).toBe(UNTITLED_CONVERSATION);
  });
});
