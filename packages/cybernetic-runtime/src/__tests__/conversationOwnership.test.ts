import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { workflowRuns } from '@aflow/database';
import type { SessionAgentTarget, SessionStatus } from '@aflow/schemas';
import {
  drivenByLiveConversationSql,
  endsConversationOwnership,
  isReadersWork,
} from '../conversationOwnership.js';

const HELMSMAN = { kind: 'platform-role', systemRole: 'cybernetic-helmsman' } as SessionAgentTarget;
const RUNNER = { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget;

const ME = 'c01d0000-0000-4000-8000-000000000001';
const OTHER = 'c01d0000-0000-4000-8000-000000000002';
const reader = { sessionId: ME, planRootIds: new Set(['root-mine']) };

describe('a conversation owns its runs until it succeeds or is cancelled', () => {
  it.each<[SessionStatus, boolean]>([
    ['RUNNING', false],
    ['PAUSED', false],
    ['FAILED', false],
    ['SUCCEEDED', true],
    ['CANCELLED', true],
  ])('a Helmsman conversation projected %s ends its hold: %s', (status, ends) => {
    expect(endsConversationOwnership(HELMSMAN, status)).toBe(ends);
  });

  it('holds through a failure and its retry, so its runs never turn everyone’s in between', () => {
    const retried: SessionStatus[] = ['RUNNING', 'FAILED', 'RUNNING', 'SUCCEEDED'];
    expect(retried.map((status) => endsConversationOwnership(HELMSMAN, status))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('is decided in Postgres by the same statuses', () => {
    const { params } = new PgDialect().sqlToQuery(
      drivenByLiveConversationSql(workflowRuns.sessionId),
    );
    expect(params).toEqual(['platform-role', 'cybernetic-helmsman', 'SUCCEEDED', 'CANCELLED']);
  });

  it('holds a run whose session has no row yet, and no run no session drove', () => {
    const { sql } = new PgDialect().sqlToQuery(drivenByLiveConversationSql(workflowRuns.sessionId));
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'when "workflow_runs"."session_id" is null then false when "sessions"."session_id" is null then true',
    );
  });

  it('is not a session that is not a Helmsman conversation', () => {
    expect(endsConversationOwnership(RUNNER, 'SUCCEEDED')).toBe(false);
  });
});

describe('whose a run, or an item about one, is', () => {
  it('placed in the plan, the conversation’s that has taken up its root', () => {
    const placed = (rootId: string) => ({
      plan: { rootId },
      sessionId: ME,
      drivenByLiveConversation: true,
    });
    expect(isReadersWork(placed('root-mine'), reader)).toBe(true);
    expect(isReadersWork(placed('root-other'), reader)).toBe(false);
  });

  it('placed nowhere, the live conversation’s that drove it, and nobody else’s', () => {
    expect(isReadersWork({ sessionId: ME, drivenByLiveConversation: true }, reader)).toBe(true);
    expect(isReadersWork({ sessionId: OTHER, drivenByLiveConversation: true }, reader)).toBe(false);
  });

  it('placed nowhere and owned by no live conversation, everyone’s', () => {
    expect(isReadersWork({ drivenByLiveConversation: false }, reader)).toBe(true);
    expect(isReadersWork({ sessionId: OTHER, drivenByLiveConversation: false }, reader)).toBe(true);
  });
});
