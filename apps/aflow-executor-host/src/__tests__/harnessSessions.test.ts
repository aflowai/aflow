/**
 * Contract: a kept session belongs to one owner, and nothing it holds outlives
 * the grant that permitted it.
 */
import { describe, expect, it } from 'vitest';

import {
  allSessions,
  expiredSessions,
  forgetSession,
  nextSessionRef,
  newConversationId,
  ownedSession,
  recordSession,
  sessionForRetry,
  sessionsForBinding,
  SESSION_IDLE_TTL_MS,
  touchSession,
  type HarnessSession,
} from '../harnessSessions.js';
import {
  buildHarnessArgv,
  buildSessionArgs,
  HarnessProfileError,
  HarnessProfileSchema,
  supportsContinuation,
} from '../harnessProfiles.js';

function makeSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  const id = overrides.id ?? nextSessionRef();
  return {
    id,
    ownerId: 'conversation-a',
    runId: 'run-a',
    logicalExecutionId: `step:${id}`,
    bindingId: 'hb',
    harnessId: 'claude',
    worktreePath: `/tmp/${id}/work`,
    scratchDir: `/tmp/${id}`,
    configDir: `/tmp/${id}/cfg`,
    conversationId: newConversationId(),
    baseSha: 'abc123',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

describe('a kept session answers to one owner', () => {
  it('resolves for its owner', () => {
    const session = makeSession();
    recordSession(session);
    expect(ownedSession(session.id, 'conversation-a')?.id).toBe(session.id);
    forgetSession(session.id);
  });

  it('is absent to any other owner, not refused', () => {
    // Saying "that belongs to someone else" confirms the ref exists, and a ref
    // is the only thing that has to be guessed.
    const session = makeSession();
    recordSession(session);
    expect(ownedSession(session.id, 'conversation-b')).toBeUndefined();
    forgetSession(session.id);
  });

  it('is absent when it was never there', () => {
    expect(ownedSession('hs_nothing', 'conversation-a')).toBeUndefined();
  });

  it('is not owned by the run that made it when a conversation owns it', () => {
    const session = makeSession();
    recordSession(session);
    expect(ownedSession(session.id, 'run-a')).toBeUndefined();
    forgetSession(session.id);
  });
});

describe('a retry finds the session of its own work in its own run', () => {
  it('finds the session an earlier attempt at the same work in the same run made', () => {
    const session = makeSession({ logicalExecutionId: 'task:commission' });
    recordSession(session);
    expect(sessionForRetry('run-a', 'task:commission')?.id).toBe(session.id);
    forgetSession(session.id);
  });

  it("does not find another run's session though the conversation and the task are the same", () => {
    // A workflow names its work by task id, so every commission a conversation
    // starts is `task:commission`; a retry of one must start in its own checkout.
    const session = makeSession({ logicalExecutionId: 'task:commission' });
    recordSession(session);
    expect(sessionForRetry('run-b', 'task:commission')).toBeUndefined();
    forgetSession(session.id);
  });

  it('does not find the session of other work in the same run', () => {
    const session = makeSession({ logicalExecutionId: 'task:commission' });
    recordSession(session);
    expect(sessionForRetry('run-a', 'task:another')).toBeUndefined();
    forgetSession(session.id);
  });

  it("finds its run's session though another conversation has since recovered the run", () => {
    // A stalled run recovered from conversation B carries B on its later
    // attempts, but a retry of it is still the same run: the session that run
    // made under conversation A, which started it, is the one it continues.
    const session = makeSession({
      ownerId: 'conversation-a',
      logicalExecutionId: 'task:commission',
    });
    recordSession(session);
    expect(sessionForRetry('run-a', 'task:commission')?.id).toBe(session.id);
    // Ownership for `continueFrom` does not move with the recovery: the
    // session made before it still belongs to the conversation that started the run.
    expect(ownedSession(session.id, 'conversation-b')).toBeUndefined();
    expect(ownedSession(session.id, 'conversation-a')?.id).toBe(session.id);
    forgetSession(session.id);
  });
});

describe('a conversation does not outlive its usefulness', () => {
  it('expires when untouched, and expiry removes it from the registry', () => {
    const stale = makeSession({ lastUsedAt: Date.now() - SESSION_IDLE_TTL_MS - 1_000 });
    const fresh = makeSession();
    recordSession(stale);
    recordSession(fresh);

    const expired = expiredSessions(Date.now());
    expect(expired.map((s) => s.id)).toContain(stale.id);
    expect(expired.map((s) => s.id)).not.toContain(fresh.id);
    // Gone from the registry, so a later continue finds nothing rather than a
    // reference to a checkout that has been cleaned up underneath it.
    expect(ownedSession(stale.id, 'conversation-a')).toBeUndefined();
    expect(ownedSession(fresh.id, 'conversation-a')).toBeDefined();
    forgetSession(fresh.id);
  });

  it('a turn keeps it alive', () => {
    const session = makeSession({ lastUsedAt: Date.now() - SESSION_IDLE_TTL_MS - 1_000 });
    recordSession(session);
    touchSession(session);
    expect(expiredSessions(Date.now()).map((s) => s.id)).not.toContain(session.id);
    forgetSession(session.id);
  });

  it('is findable by binding, so withdrawal can reach it', () => {
    const mine = makeSession({ bindingId: 'hb_target' });
    const other = makeSession({ bindingId: 'hb_other' });
    recordSession(mine);
    recordSession(other);
    expect(sessionsForBinding('hb_target').map((s) => s.id)).toEqual([mine.id]);
    forgetSession(mine.id);
    forgetSession(other.id);
  });

  it('is findable in full, so shutdown can clear what nothing can address again', () => {
    const session = makeSession();
    recordSession(session);
    expect(allSessions().map((s) => s.id)).toContain(session.id);
    forgetSession(session.id);
  });
});

describe('how a harness is told to continue is the harness own business', () => {
  const claude = HarnessProfileSchema.parse({
    id: 'claude',
    executable: '/opt/claude',
    promptArgs: ['-p', '{prompt}'],
    sessionArgs: ['--session-id', '{session}'],
    resumeArgs: ['--resume', '{session}'],
  });

  it('names a new conversation, and picks the same one back up', () => {
    expect(buildSessionArgs(claude, 'uuid-1', false)).toEqual(['--session-id', 'uuid-1']);
    expect(buildSessionArgs(claude, 'uuid-1', true)).toEqual(['--resume', 'uuid-1']);
  });

  it('places the conversation ahead of the prompt, each in its own argument', () => {
    const argv = buildHarnessArgv(claude, 'do a thing', buildSessionArgs(claude, 'uuid-1', true));
    expect(argv).toEqual(['/opt/claude', '--resume', 'uuid-1', '-p', 'do a thing']);
  });

  it('reports a harness that never said how it resumes as unable to', () => {
    // Absence of a declaration is a fact about the harness, recorded rather
    // than assumed in either direction.
    const bare = HarnessProfileSchema.parse({ id: 'other', executable: '/opt/other' });
    expect(supportsContinuation(bare)).toBe(false);
    expect(buildSessionArgs(bare, 'uuid-1', false)).toEqual([]);
    expect(supportsContinuation(claude)).toBe(true);
  });

  it('refuses a template with nowhere to put the conversation, or two places', () => {
    const bad = HarnessProfileSchema.parse({
      id: 'bad',
      executable: '/opt/bad',
      resumeArgs: ['--resume'],
    });
    expect(() => buildSessionArgs(bad, 'uuid-1', true)).toThrow(HarnessProfileError);
    const worse = HarnessProfileSchema.parse({
      id: 'worse',
      executable: '/opt/worse',
      resumeArgs: ['{session}', '{session}'],
    });
    expect(() => buildSessionArgs(worse, 'uuid-1', true)).toThrow(/exactly one/);
  });

  it('mints a conversation id rather than parsing one out of harness output', () => {
    // Reading an id back out would mean a second parser for every harness, and
    // a harness that changed its output format would silently stop resuming.
    expect(newConversationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(newConversationId()).not.toBe(newConversationId());
  });
});

describe('a session belongs to a folder as well as to an owner', () => {
  it('is not resumable while naming a different binding', () => {
    // A run holding two bindings could otherwise resume one session while
    // naming the other: the sandbox would combine this binding's root with that
    // session's worktree, and a permission change on the session's own binding
    // would not apply. Process handles are scoped both ways; a session is a
    // longer-lived handle and needs it more.
    const session = makeSession({ bindingId: 'hb_a' });
    recordSession(session);
    const resolved = ownedSession(session.id, 'conversation-a');
    expect(resolved).toBeDefined();
    expect(resolved?.bindingId).toBe('hb_a');
    // The handler refuses when this differs from the binding the call names;
    // what the registry must preserve is the association itself.
    expect(resolved?.bindingId).not.toBe('hb_b');
    forgetSession(session.id);
  });
});
