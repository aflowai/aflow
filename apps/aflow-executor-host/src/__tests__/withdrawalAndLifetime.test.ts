/**
 * Defects a review found in the first cut of detached processes and sessions.
 * Each test names the way out, or the loss, that it closes.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimSession,
  expiredSessions,
  forgetSession,
  nextSessionRef,
  newConversationId,
  ownedSession,
  recordSession,
  releaseSession,
  SESSION_IDLE_TTL_MS,
  withdrawnSessions,
  type HarnessSession,
} from '../harnessSessions.js';
import { openOrphanJournal, reapOrphans, readJournal, recordSpawn } from '../orphans.js';

function makeSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  const id = overrides.id ?? nextSessionRef();
  return {
    id,
    ownerRunId: 'run-a',
    bindingId: 'hb',
    bindingRoot: '/repo',
    harnessId: 'claude',
    worktreePath: `/tmp/${id}/work`,
    scratchDir: `/tmp/${id}`,
    configDir: `/tmp/${id}/cfg`,
    conversationId: newConversationId(),
    baseSha: 'abc',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    busy: false,
    ...overrides,
  };
}

describe('a turn in progress is not swept away underneath itself', () => {
  it('does not expire a session while a turn is running against it', () => {
    // The idle window is shorter than the longest a run may take, so a sweep
    // during a long turn deleted the checkout the harness was writing into and
    // every bit of its work went with it.
    const session = makeSession({ lastUsedAt: Date.now() - SESSION_IDLE_TTL_MS - 60_000 });
    recordSession(session);
    expect(claimSession(session)).toBe(true);

    expect(expiredSessions(Date.now()).map((s) => s.id)).not.toContain(session.id);
    expect(ownedSession(session.id, 'run-a')).toBeDefined();

    releaseSession(session);
    // Released, the idle clock restarts from the end of the turn rather than
    // from when it began.
    expect(expiredSessions(Date.now()).map((s) => s.id)).not.toContain(session.id);
    forgetSession(session.id);
  });

  it('refuses a second turn against a session already running one', () => {
    // Two turns would share a checkout and a conversation directory, interleave
    // their diffs, and each report the other's work as its own.
    const session = makeSession();
    recordSession(session);
    expect(claimSession(session)).toBe(true);
    expect(claimSession(session)).toBe(false);
    releaseSession(session);
    expect(claimSession(session)).toBe(true);
    releaseSession(session);
    forgetSession(session.id);
  });

  it('carries the repository its worktree belongs to', () => {
    // Cleanup happens on whichever run notices a session is stale, and that run
    // may be in a different binding — removing a worktree against the wrong
    // repository leaves a permanent stale entry in that one instead.
    const session = makeSession({ bindingRoot: '/repos/theirs' });
    recordSession(session);
    expect(ownedSession(session.id, 'run-a')?.bindingRoot).toBe('/repos/theirs');
    forgetSession(session.id);
  });
});

describe('withdrawing a binding reaches sessions under it', () => {
  it('drops every session whose binding is no longer granted', () => {
    const kept = makeSession({ bindingId: 'hb_kept' });
    const gone = makeSession({ bindingId: 'hb_withdrawn' });
    recordSession(kept);
    recordSession(gone);

    const dropped = withdrawnSessions(new Set(['hb_kept']));
    expect(dropped.map((s) => s.id)).toEqual([gone.id]);
    // Dropped from the registry, so nothing resolves it again.
    expect(ownedSession(gone.id, 'run-a')).toBeUndefined();
    expect(ownedSession(kept.id, 'run-a')).toBeDefined();
    forgetSession(kept.id);
  });
});

describe('nothing a previous executor left running is adopted', () => {
  let hostDir: string;
  let journal: string;

  beforeEach(async () => {
    hostDir = await mkdtemp(join(tmpdir(), 'aflow-orphans-'));
    journal = openOrphanJournal(hostDir);
  });
  afterEach(async () => {
    await rm(hostDir, { recursive: true, force: true });
  });

  it('writes down a group as it is created, so a crash still leaves it findable', () => {
    recordSpawn(4242, '/tmp/scratch-a');
    recordSpawn(4243, '/tmp/scratch-b');
    expect(readJournal(journal).map((r) => r.pid)).toEqual([4242, 4243]);
  });

  it('survives a journal truncated mid-write, which is what a crash looks like', async () => {
    recordSpawn(4242, '/tmp/scratch-a');
    await writeFile(journal, `${await readFile(journal, 'utf8')}{"pid":99,"scr`);
    // The complete records before the tear are still good.
    expect(readJournal(journal).map((r) => r.pid)).toEqual([4242]);
  });

  it('ends what it finds and clears the journal', async () => {
    // A pid that is certainly not ours; killing it must fail harmlessly rather
    // than throw, because "already gone" is the common case.
    recordSpawn(999_999, join(hostDir, 'leftover'));
    await writeFile(join(hostDir, 'leftover'), 'x').catch(() => {});
    expect(() => reapOrphans(journal)).not.toThrow();
    expect(readJournal(journal)).toEqual([]);
  });

  it('reads an absent journal as nothing to do', () => {
    expect(readJournal(join(hostDir, 'never-written.jsonl'))).toEqual([]);
    expect(reapOrphans(join(hostDir, 'never-written.jsonl'))).toBe(0);
  });
});
