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

import type { BaseMerge } from './baseMerge.js';

export interface HarnessSession {
  readonly id: string;
  /**
   * Who may continue it: the conversation that started the run that made it,
   * as the orchestrator stamped it on the job, and the run itself where no
   * conversation started one.
   *
   * So every commission a conversation starts can continue a session another
   * of them made, and no other conversation can. A workflow no conversation
   * started still shares one across its own tasks. On a session's own step the
   * run is that session: a chat is one id across every turn and so the
   * conversation itself, while an agent working inside a per-attempt worker
   * session gets a fresh id each attempt and cannot name a session across one.
   *
   * It is recorded once, when the session is made. A stalled run recovered from
   * another conversation carries that conversation from then on, so the run's
   * later sessions belong to the recovering conversation, while the sessions it
   * made before the recovery still belong to the one that started it. That is
   * the rule, not a gap: whoever recovers a run carries its work forward.
   * Ownership decides `continueFrom` only; a retry of the run's own work does
   * not consult it (`sessionForRetry`).
   */
  readonly ownerId: string;
  /** The run that made it, which with `logicalExecutionId` names the work a retry continues. */
  readonly runId: string;
  /**
   * The work this session was started for, as the executor runtime names it
   * across every attempt at it. A retry of that work continues this
   * conversation in this checkout rather than starting the brief again: an
   * interrupted run has spent its turns on what the checkout now holds.
   */
  readonly logicalExecutionId: string;
  readonly bindingId: string;
  readonly harnessId: string;
  /** The private clone the conversation has been reasoning about. */
  readonly worktreePath: string;
  /** Scratch holding the clone and the harness's state directory. */
  readonly scratchDir: string;
  readonly configDir: string;
  /**
   * What the harness calls this conversation: minted here for a harness that
   * takes an id, and recorded from its event stream for one that names its own
   * (Plan 326 D2). Undefined until such a harness has said, and a session
   * without one cannot be resumed — only started again in the same checkout.
   */
  conversationId: string | undefined;
  readonly baseSha: string;
  /**
   * The ref the checkout was started from, when a turn named one. A later turn
   * that names none still works on that checkout, so it is judged against the
   * same ref.
   */
  readonly base?: string;
  /**
   * The merge the checkout's last commit is, when a turn named `mergeFrom`. A
   * later turn on the same checkout reports it again, since its diff is still
   * taken against that merge and a publication has to make it again.
   */
  readonly merge?: BaseMerge;
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
export function ownedSession(sessionRef: string, ownerId: string): HarnessSession | undefined {
  const session = sessions.get(sessionRef);
  if (session === undefined) return undefined;
  return session.ownerId === ownerId ? session : undefined;
}

/**
 * The session an earlier attempt at the same work left, for a retry of it to
 * continue. The run is matched because a workflow names its work by task id:
 * every commission a conversation starts is the same `task:commission`, and a
 * retry of one must not wake in another's checkout. The owner is not matched:
 * a retry is the same run, so the run already says whose work it is, and a run
 * recovered from another conversation carries that conversation on its later
 * attempts while its earlier sessions keep the owner they were made under.
 */
export function sessionForRetry(
  runId: string,
  logicalExecutionId: string,
): HarnessSession | undefined {
  for (const session of sessions.values()) {
    if (session.runId === runId && session.logicalExecutionId === logicalExecutionId) {
      return session;
    }
  }
  return undefined;
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
export function withdrawnSessions(permittedBindings: ReadonlySet<string>): HarnessSession[] {
  const gone = [...sessions.values()].filter((s) => !permittedBindings.has(s.bindingId));
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
 * removing a checkout unlinks the installation mirrored into it first, and this
 * module does not know about checkouts.
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
