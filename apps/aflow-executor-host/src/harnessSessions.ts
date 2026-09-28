/**
 * A coding session that outlives the run that started it.
 *
 * One-shot runs are the wrong shape for most work: the second instruction is
 * usually "now fix the test that broke", and starting over loses both the
 * conversation and the worktree it was reasoning about. A session keeps three
 * things together — the checkout, the harness's own state directory, and the
 * conversation id — so continuing means adding a turn rather than repeating a
 * task with more words.
 *
 * Sessions are held in memory, like process handles and for the same reason:
 * a handle that survived a restart would name a conversation whose worktree and
 * configuration may have been cleaned up underneath it, and reporting that as
 * resumable is worse than reporting it as gone.
 */
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export interface HarnessSession {
  readonly id: string;
  /**
   * The run that may continue it. Ownership works exactly as it does for a
   * process handle.
   *
   * What that identifies decides whether continuation is usable at all, and it
   * differs by path: a chat session is one id across every turn, so a
   * conversation continues the way a person expects; a workflow carries its own
   * run id across its tasks. An agent working inside a per-attempt worker
   * session gets a fresh id each attempt and so cannot continue across one —
   * which is the right answer, because a retried attempt inheriting the last
   * one's half-finished checkout is not a resumption.
   */
  readonly ownerRunId: string;
  readonly bindingId: string;
  /**
   * The repository this session's worktree belongs to. Held here because
   * cleanup happens on whatever run notices the session is stale, and that run
   * may be working in a different binding — removing a worktree against the
   * wrong repository leaves a permanent stale entry in that repository instead.
   */
  readonly bindingRoot: string;
  readonly harnessId: string;
  /** The checkout the conversation has been reasoning about. */
  readonly worktreePath: string;
  /** Scratch holding the worktree and the harness's state directory. */
  readonly scratchDir: string;
  readonly configDir: string;
  /** What the harness calls this conversation. Minted here, so it need not be parsed back out. */
  readonly conversationId: string;
  readonly baseSha: string;
  /**
   * The ref the checkout was started from, when a turn named one. A later turn
   * that names none still works on that checkout, so it is judged against the
   * same ref.
   */
  readonly base?: string;
  readonly createdAt: number;
  lastUsedAt: number;
  /**
   * A turn is running against this checkout right now.
   *
   * Two things depend on it. Expiry must not remove a session mid-turn — the
   * idle window is shorter than the longest a run may take, so a sweep during a
   * long turn would delete the worktree the harness is writing into and lose
   * every bit of its work. And a second turn must not start while one is
   * running: they would share a checkout and a conversation state directory,
   * interleave their diffs, and each report the other's work as its own.
   */
  busy: boolean;
}

/**
 * How long an untouched session keeps its worktree and state. Long enough that
 * a person can read a diff, think, and come back; short enough that an
 * abandoned one does not hold a checkout on disk indefinitely.
 */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

const sessions = new Map<string, HarnessSession>();

let counter = 0;
export function nextSessionRef(): string {
  counter += 1;
  return `hs_${Date.now().toString(36)}_${String(counter)}`;
}

export function newConversationId(): string {
  return randomUUID();
}

export function recordSession(session: HarnessSession): void {
  sessions.set(session.id, session);
}

/**
 * The one place ownership is decided, returning the session rather than a
 * boolean so a caller cannot hold one it did not prove it owns.
 */
export function ownedSession(sessionRef: string, ownerRunId: string): HarnessSession | undefined {
  const session = sessions.get(sessionRef);
  if (session === undefined) return undefined;
  return session.ownerRunId === ownerRunId ? session : undefined;
}

export function touchSession(session: HarnessSession): void {
  session.lastUsedAt = Date.now();
}

/** Claim a session for a turn. False when one is already running against it. */
export function claimSession(session: HarnessSession): boolean {
  if (session.busy) return false;
  session.busy = true;
  session.lastUsedAt = Date.now();
  return true;
}

export function releaseSession(session: HarnessSession): void {
  session.busy = false;
  // Stamped on release as well as claim, so the idle window is measured from
  // when the session went quiet rather than from when a long turn began.
  session.lastUsedAt = Date.now();
}

/** Sessions belonging to a binding, for withdrawal. */
export function sessionsForBinding(bindingId: string): HarnessSession[] {
  return [...sessions.values()].filter((s) => s.bindingId === bindingId);
}

/**
 * Sessions under a binding the machine no longer grants. Dropped from the
 * registry here so nothing resolves them again; what they left on disk is the
 * caller's to remove, since that needs the repository they belong to.
 */
export function withdrawnSessions(permitted: ReadonlySet<string>): HarnessSession[] {
  const gone = [...sessions.values()].filter((s) => !permitted.has(s.bindingId));
  for (const session of gone) sessions.delete(session.id);
  return gone;
}

/**
 * The same set, forgotten on the way out. Reading without dropping is right for
 * a caller that is only looking; a withdrawal must also make sure nothing
 * resolves the session again, which is a different question and so a different
 * function.
 */
export function dropSessionsForBinding(bindingId: string): HarnessSession[] {
  const held = sessionsForBinding(bindingId);
  for (const session of held) sessions.delete(session.id);
  return held;
}

export function forgetSession(sessionRef: string): void {
  sessions.delete(sessionRef);
}

/**
 * Sessions whose scratch should be removed: idle past the ttl, or every one of
 * them when a binding is withdrawn. Returned rather than deleted here, because
 * removing a worktree needs the repository it belongs to and this module does
 * not know about git.
 */
export function expiredSessions(now: number): HarnessSession[] {
  const expired = [...sessions.values()].filter(
    // A busy session is not idle however long it has been running.
    (s) => !s.busy && now - s.lastUsedAt > SESSION_IDLE_TTL_MS,
  );
  for (const session of expired) sessions.delete(session.id);
  return expired;
}

export function allSessions(): HarnessSession[] {
  return [...sessions.values()];
}

/** How every harness run's scratch directory under the temp root is named. */
export const HARNESS_SCRATCH_PREFIX = 'aflow-harness-';

/** Remove a session's scratch. Failure is never allowed to fail a run. */
export async function discardScratch(session: Pick<HarnessSession, 'scratchDir'>): Promise<void> {
  await rm(session.scratchDir, { recursive: true, force: true }).catch(() => {});
}
