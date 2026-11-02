/**
 * The wait the platform holds for the conversation that set a plan node
 * blocked or waiting, the way it holds a pull request's owner wait (Plan 339
 * D4).
 *
 * The write that sets the status declares it, for the conversation that made
 * the write, and its result names it. The node's next status change wakes that
 * conversation with the node, its new status and its standing note. One wait
 * is held per node and conversation. A status write by that conversation
 * releases its wait before the write is recorded, so the write's own event
 * wakes no one, and a write that sets the status again holds a new one. A
 * window that closes on a node still held declares the next wait. One that
 * closes on a node gone or moved on tells the conversation as a change does. A
 * conversation that has ended is forgotten, whatever it still holds.
 */
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { cancelWait, readSubjectWaits } from '@aflow/redis';
import { createPlanNodeStore, declareWait, isLiveConversation } from '@aflow/cybernetic-runtime';
import {
  WAIT_WINDOW_MAX_SECONDS,
  type HeldWait,
  type PlanNode,
  type WaitEventKind,
  type WaitOutcome,
  type WaitRegistration,
} from '@aflow/schemas';

export const PLAN_NODE_STATUS_CHANGED: WaitEventKind = 'plan.node.status_changed';

/** Why the conversation holds the wait, as the room message leads with it. */
export const PLAN_NODE_HOLD_LEAD =
  'Your write set this node blocked or waiting, so the platform declared this wait for you.';

/** What the conversation is told to do when the node's status changes. */
export const PLAN_NODE_ON_EVENT =
  'Act on the node as its new status and its note stand below: the note names what this conversation was to do next.';

export interface PlanNodeHoldDeps {
  redis: Redis;
  db: PostgresJsDatabase;
}

export interface PlanNodeHoldTarget {
  tenantId: string;
  spaceId: string;
  /** The conversation that made the write. */
  sessionId: string;
  nodeId: string;
}

function subjectOf(target: PlanNodeHoldTarget) {
  return {
    tenantId: target.tenantId,
    spaceId: target.spaceId,
    kind: PLAN_NODE_STATUS_CHANGED,
    subject: target.nodeId,
  };
}

async function heldBy(redis: Redis, target: PlanNodeHoldTarget): Promise<WaitRegistration[]> {
  const waits = await readSubjectWaits(redis, subjectOf(target));
  return waits.filter((wait) => wait.owner !== undefined && wait.sessionId === target.sessionId);
}

/**
 * Hold the node's wait for the conversation that set it blocked or waiting.
 * Null where the conversation is no live Helmsman conversation: nothing would
 * wake it.
 *
 * Without `since`, the wait counts from just past now. The write's own status
 * change was recorded before this declaration, and must not end it. A change
 * recorded after the declaration ends it whatever its clock says.
 *
 * The new wait is declared before the one it replaces is cancelled, so a
 * change recorded between the two reaches the conversation, at worst twice.
 */
export async function holdForPlanNode(
  deps: PlanNodeHoldDeps,
  target: PlanNodeHoldTarget,
  options: { since?: number; nowMs?: number } = {},
): Promise<HeldWait | null> {
  if (!(await isLiveConversation(deps.db, target.tenantId, target.sessionId))) {
    await endPlanNodeHold(deps, target);
    return null;
  }
  const replaced = await heldBy(deps.redis, target);
  const nowMs = options.nowMs ?? Date.now();
  const wait = await declareWait(
    deps.redis,
    {
      ...subjectOf(target),
      sessionId: target.sessionId,
      windowSeconds: WAIT_WINDOW_MAX_SECONDS,
      since: options.since ?? nowMs + 1,
      owner: { lead: PLAN_NODE_HOLD_LEAD, onEvent: PLAN_NODE_ON_EVENT },
      // No caller awaits the outcome, so one it catches up on is queued for
      // the delivery cycle in the registration's own script.
      queueCatchUp: true,
    },
    nowMs,
  );
  for (const earlier of replaced) await cancelWait(deps.redis, earlier);
  return {
    waitId: wait.waitId,
    kind: PLAN_NODE_STATUS_CHANGED,
    subject: target.nodeId,
    windowSeconds: WAIT_WINDOW_MAX_SECONDS,
    closesAt: new Date(wait.closesAt).toISOString(),
  };
}

/**
 * Drop the waits a conversation holds on a node, and return those this call
 * removed. A wait the delivery cycle has claimed already is left to it.
 *
 * A status write by the holding conversation calls this before the write is
 * recorded. Its own status change then wakes no one, so it is not told what
 * it did.
 */
export async function endPlanNodeHold(
  deps: Pick<PlanNodeHoldDeps, 'redis'>,
  target: PlanNodeHoldTarget,
): Promise<WaitRegistration[]> {
  const removed: WaitRegistration[] = [];
  for (const wait of await heldBy(deps.redis, target)) {
    if (await cancelWait(deps.redis, wait)) removed.push(wait);
  }
  return removed;
}

/**
 * Hold again the waits a write released before it was refused or threw. The
 * new wait counts from the earliest released one, so a change recorded while
 * none was held still reaches the conversation.
 */
export async function restorePlanNodeHold(
  deps: PlanNodeHoldDeps,
  target: PlanNodeHoldTarget,
  released: readonly WaitRegistration[],
): Promise<void> {
  if (released.length === 0) return;
  const since = Math.min(...released.map((wait) => wait.since ?? wait.declaredAt));
  await holdForPlanNode(deps, target, { since });
}

export function planNodeHoldTarget(registration: WaitRegistration): PlanNodeHoldTarget {
  return {
    tenantId: registration.tenantId,
    spaceId: registration.spaceId,
    sessionId: registration.sessionId,
    nodeId: registration.subject,
  };
}

/** The status the last change told set the node to, or its status as read. */
function newStatus(outcome: WaitOutcome, node: PlanNode | null): string | undefined {
  if (outcome.endedBy === 'event') {
    const last = outcome.laterEvents?.at(-1) ?? outcome.event;
    const status = last.detail['status'];
    if (typeof status === 'string') return status;
  }
  return node?.status;
}

/** The node, its new status and its standing note, as the delivery names them. */
export function describePlanNodeChange(
  nodeId: string,
  outcome: WaitOutcome,
  node: PlanNode | null,
): string {
  if (node === null) return `Plan node ${nodeId} no longer exists.`;
  const status = newStatus(outcome, node) ?? node.status;
  const note =
    node.note !== undefined && node.note !== '' ? `Its note:\n${node.note}` : 'It has no note.';
  return `Plan node "${node.title}" (${nodeId}) is now ${status}, at revision ${String(node.revision)}.\n${note}`;
}

/** Read the node a held wait names, as it stands now. */
export async function readHeldPlanNode(
  db: PostgresJsDatabase,
  registration: WaitRegistration,
): Promise<PlanNode | null> {
  return createPlanNodeStore(db, registration.tenantId).find(
    registration.spaceId,
    registration.subject,
  );
}
