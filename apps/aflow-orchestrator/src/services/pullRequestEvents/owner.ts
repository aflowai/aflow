/**
 * The owner of a loop pull request, and the wait the platform keeps for it
 * (Plan 339 D4).
 *
 * The owner is the Helmsman conversation that started the publication that
 * opened the pull request. While that conversation has not ended, it holds one
 * wait on the pull request's `pull_request.changed`, declared for it here. The
 * event wakes it with what to do: run a shepherd pass aimed at the pull
 * request. Each delivery declares the next wait, so the owner hears every
 * change until the pull request merges or closes. An owner that has ended is
 * forgotten, and the fallback sweep tends the pull request.
 */
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  disownPullRequestWatch,
  readPullRequestWatch,
  readSubjectWaits,
  type PullRequestWatch,
} from '@aflow/redis';
import { declareWait, isLiveConversation, type DeclaredWait } from '@aflow/cybernetic-runtime';
import {
  SHEPHERD_SLUG,
  WAIT_WINDOW_MAX_SECONDS,
  type WaitEventKind,
  type WaitRegistration,
} from '@aflow/schemas';

export const PULL_REQUEST_CHANGED: WaitEventKind = 'pull_request.changed';

export interface OwnerDeps {
  redis: Redis;
  db: PostgresJsDatabase;
}

/** What the owner is told to do on its pull request's event. */
export function ownerOnEvent(watch: Pick<PullRequestWatch, 'number' | 'bindingId'>): string {
  const folder =
    watch.bindingId !== undefined
      ? `\`bindingId: '${watch.bindingId}'\``
      : 'the `bindingId` of the folder it was published from';
  return (
    `Run a Local PR Shepherd pass aimed at it: \`workflow.run.start\` with slug \`${SHEPHERD_SLUG}\`, ` +
    `${folder} and \`pullNumber: '${String(watch.number)}'\`, with \`wait: 'none'\`. ` +
    "The pass merges a green head where the folder's merge posture allows, and commissions the merge round on a conflict. " +
    "Once the pull request has merged, close its plan step, and move the folder where the folder's merge is not the operator's."
  );
}

export type OwnerHold =
  | { state: 'no_owner' }
  | { state: 'held' }
  | { state: 'ended' }
  | { state: 'declared'; wait: DeclaredWait; registration: WaitRegistration };

/**
 * Make sure the watch's owner holds its wait on the pull request. A wait the
 * owner holds already is left alone. An owner that has ended is forgotten.
 *
 * `since` catches up: an event recorded at or after it ends the new wait at
 * once, and the registration queues it for the delivery cycle. A delivery passes the time just past the
 * last event it delivered, so an event that fired between the claim and this
 * declaration is not lost.
 */
export async function holdForOwner(
  deps: OwnerDeps,
  watch: PullRequestWatch,
  options: { since?: number; nowMs?: number } = {},
): Promise<OwnerHold> {
  const owner = watch.ownerSessionId;
  if (owner === undefined) return { state: 'no_owner' };
  const subject = {
    tenantId: watch.tenantId,
    spaceId: watch.spaceId,
    kind: PULL_REQUEST_CHANGED,
    subject: watch.subject,
  };
  const waits = await readSubjectWaits(deps.redis, subject);
  if (waits.some((wait) => wait.sessionId === owner && wait.owner !== undefined)) {
    return { state: 'held' };
  }
  if (!(await isLiveConversation(deps.db, watch.tenantId, owner))) {
    await disownPullRequestWatch(deps.redis, watch, owner);
    return { state: 'ended' };
  }
  const nowMs = options.nowMs ?? Date.now();
  const declared = {
    tenantId: watch.tenantId,
    spaceId: watch.spaceId,
    sessionId: owner,
    kind: PULL_REQUEST_CHANGED,
    subject: watch.subject,
    ...(options.since !== undefined ? { since: options.since } : {}),
    owner: { onEvent: ownerOnEvent(watch) },
    // No caller awaits the outcome, so one it catches up on is queued for the
    // delivery cycle in the registration's own script, and a throw loses nothing.
    queueCatchUp: true,
  };
  const wait = await declareWait(
    deps.redis,
    { ...declared, windowSeconds: WAIT_WINDOW_MAX_SECONDS },
    nowMs,
  );
  return {
    state: 'declared',
    wait,
    registration: {
      tenantId: declared.tenantId,
      spaceId: declared.spaceId,
      sessionId: declared.sessionId,
      kind: declared.kind,
      subject: declared.subject,
      ...(declared.since !== undefined ? { since: declared.since } : {}),
      owner: declared.owner,
      waitId: wait.waitId,
      declaredAt: nowMs,
      closesAt: wait.closesAt,
    },
  };
}

/**
 * After an owner's wait was delivered, or its window closed: declare the next
 * one where the pull request is still watched and its owner still holds it.
 */
export async function holdAgainForOwner(
  deps: OwnerDeps,
  registration: WaitRegistration,
  since: number | undefined,
  nowMs?: number,
): Promise<OwnerHold> {
  const watch = await readPullRequestWatch(deps.redis, registration);
  if (watch?.ownerSessionId !== registration.sessionId) {
    return { state: 'no_owner' };
  }
  return holdForOwner(deps, watch, {
    ...(since !== undefined ? { since } : {}),
    ...(nowMs !== undefined ? { nowMs } : {}),
  });
}
