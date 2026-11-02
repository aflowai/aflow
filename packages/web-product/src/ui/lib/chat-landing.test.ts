import { describe, expect, it } from 'vitest';
import {
  CHAT_INTENT_PARAMS,
  CHAT_RESUME_WINDOW_MS,
  isBareChatArrival,
  pickLandingConversation,
} from './chat-landing.js';
import type { Session } from './types.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const READER = 'reader';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    agentId: 'helmsman',
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    lastActivityAt: new Date(NOW - HOUR).toISOString(),
    createdBy: READER,
    ...overrides,
  };
}

const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

describe('pickLandingConversation', () => {
  it('is six hours wide', () => {
    expect(CHAT_RESUME_WINDOW_MS).toBe(6 * HOUR);
  });

  it('lands on the reader’s newest conversation within the window', () => {
    const picked = pickLandingConversation(
      [session('older', { lastActivityAt: at(5) }), session('newest', { lastActivityAt: at(2) })],
      READER,
      NOW,
    );
    expect(picked?.sessionId).toBe('newest');
  });

  it('lands new when the last activity lies outside the window', () => {
    expect(pickLandingConversation([session('a', { lastActivityAt: at(7) })], READER, NOW)).toBe(
      null,
    );
    expect(
      pickLandingConversation([session('edge', { lastActivityAt: at(6) })], READER, NOW)?.sessionId,
    ).toBe('edge');
  });

  it('never resumes an ended conversation', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED']) {
      expect(pickLandingConversation([session('a', { status })], READER, NOW)).toBe(null);
    }
    for (const status of ['QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ON_CHILD']) {
      expect(pickLandingConversation([session('a', { status })], READER, NOW)?.sessionId).toBe('a');
    }
  });

  it('resumes only the reader’s own conversation', () => {
    const theirs = session('theirs', { createdBy: 'someone-else', lastActivityAt: at(1) });
    const mine = session('mine', { lastActivityAt: at(3) });
    expect(pickLandingConversation([theirs, mine], READER, NOW)?.sessionId).toBe('mine');
    expect(pickLandingConversation([theirs], READER, NOW)).toBe(null);
    expect(pickLandingConversation([mine], null, NOW)).toBe(null);
  });

  it('lands new with no conversation at all', () => {
    expect(pickLandingConversation([], READER, NOW)).toBe(null);
  });
});

describe('isBareChatArrival', () => {
  it('holds for an arrival with no query, or only parameters the chat does not read', () => {
    expect(isBareChatArrival(new URLSearchParams(''))).toBe(true);
    expect(isBareChatArrival(new URLSearchParams('utm_source=mail'))).toBe(true);
  });

  it('fails for every parameter the chat reads', () => {
    for (const name of CHAT_INTENT_PARAMS) {
      expect(isBareChatArrival(new URLSearchParams(`${name}=x`))).toBe(false);
    }
    expect(isBareChatArrival(new URLSearchParams('sim=s&persona=p&baseline=2'))).toBe(false);
  });
});
