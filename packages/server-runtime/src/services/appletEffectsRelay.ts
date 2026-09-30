/**
 * The one post-commit step for an applied applet action: realtime delta,
 * attention bump, and the §4.8 outbox drain — 'notable' onto the bound room's
 * Plan 260 rails, 'waking' onto the wake bit with the §4.9 landing rule.
 *
 * No timers anywhere: a pending effect left behind by a crash (or recorded by
 * the executor write path, which only fans out deltas) is re-driven lazily —
 * replaying its actionId re-drives it, and any later action on the instance
 * drains older pending effects first, in journal order. Every destination is
 * idempotent on actionId (the room-message event id derives from it, the wake
 * idempotency key embeds it), so re-driving is always safe.
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, eventLog, users, withTenantSchema } from '@aflow/database';
import type { AppletPersistence } from '@aflow/applet-runtime';
import { APPLET_EFFECT_MAX_ATTEMPTS } from '@aflow/schemas';
import {
  getSessionStateSafe,
  getStepState,
  mayWake,
  publishAppletInstanceDelta,
  setAppletFocus,
} from '@aflow/redis';
import { bumpAttentionGeneration } from '@aflow/cybernetic-runtime';
import type {
  ActorContext,
  AppletActionReceipt,
  AppletEffectDeliveryOutcome,
  AppletInstance,
  AppletStateVersion,
  SessionId,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { hasResumeClaimForStep } from './resumeIdempotency.js';
import type { DirectRoomMessageInput, ResumeSessionRequest } from './sessions.js';

export interface AppletEffectsRelayDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
  persistenceFor(tenantId: TenantId): AppletPersistence;
  postRoomMessage(input: DirectRoomMessageInput): Promise<unknown>;
  resumeSession(request: ResumeSessionRequest): Promise<unknown>;
  log(message: string, err?: unknown): void;
}

export interface AppletActionRelayInput {
  tenantId: TenantId;
  spaceId: string;
  instanceId: string;
  receipt: AppletActionReceipt;
  stateVersion: AppletStateVersion;
  replayed: boolean;
  /** The caller behind this drain — attached to a wake only when it IS the receipt's actor. */
  actorContext?: ActorContext;
}

export interface AppletEffectsRelay {
  afterAction(input: AppletActionRelayInput): Promise<void>;
}

export function createAppletEffectsRelay(deps: AppletEffectsRelayDeps): AppletEffectsRelay {
  return {
    async afterAction(input) {
      const { tenantId, spaceId, instanceId, receipt, stateVersion, replayed } = input;
      try {
        if (!replayed && deps.redis) {
          await publishAppletInstanceDelta(deps.redis, tenantId, {
            instanceId,
            seq: receipt.seq,
            stateVersion,
            patch: receipt.patch,
            ...(receipt.effects.ending ? { status: 'ended' as const } : {}),
          });
          // The Active-applets attention block is cached per space; a stale
          // line naming the wrong waitingOn reads as authoritative (§4.13).
          await bumpAttentionGeneration(deps.redis, tenantId, spaceId);
        }
        await drainPendingEffects(deps, input);
      } catch (err) {
        // The action is already committed — the response must not fail over
        // fanout. Whatever was not marked delivered stays pending and the next
        // action (or a replay) on this instance re-drives it.
        deps.log(`applet effects relay failed for instance ${instanceId}`, err);
      }
    },
  };
}

async function drainPendingEffects(
  deps: AppletEffectsRelayDeps,
  input: AppletActionRelayInput,
): Promise<void> {
  const { tenantId, instanceId } = input;
  const persistence = deps.persistenceFor(tenantId);
  const { instance, entries } = await persistence.transact(async (tx) => ({
    instance: await tx.getInstance(instanceId),
    entries: await tx.listPendingEffects(instanceId),
  }));
  if (instance === null || entries.length === 0) return;

  // One boundary wake per drain, not one per action: once a session has been
  // set going here, every later waking effect in the same pass coalesces.
  const wokenSessions = new Set<string>();

  for (const entry of entries) {
    for (const delivery of entry.effectDeliveries) {
      if (delivery.status !== 'pending') continue;
      let outcome: AppletEffectDeliveryOutcome;
      try {
        outcome =
          delivery.effect === 'notable'
            ? await deliverNotable(deps, tenantId, instance, entry.receipt)
            : await deliverWaking(deps, tenantId, instance, entry.receipt, wokenSessions, input);
      } catch (err) {
        // Unexpected errors abort the drain to preserve room ordering — but a
        // deterministic one would starve every later effect on the instance
        // forever, so attempts are counted and a poison effect is eventually
        // abandoned as 'failed' rather than retried without end.
        const attempts = (delivery.attempts ?? 0) + 1;
        if (attempts >= APPLET_EFFECT_MAX_ATTEMPTS) {
          await persistence.transact((tx) =>
            tx.markEffectDelivered({
              instanceId,
              actionId: entry.receipt.actionId,
              effect: delivery.effect,
              outcome: 'failed',
              deliveredAt: new Date().toISOString(),
            }),
          );
          deps.log(
            `applet effect abandoned after ${String(attempts)} attempts: ` +
              `${delivery.effect} ${entry.receipt.actionId}`,
            err,
          );
          continue;
        }
        await persistence.transact((tx) =>
          tx.markEffectDelivered({
            instanceId,
            actionId: entry.receipt.actionId,
            effect: delivery.effect,
            outcome: 'failed',
            deliveredAt: new Date().toISOString(),
            attemptOnly: true,
          }),
        );
        throw err;
      }
      await persistence.transact((tx) =>
        tx.markEffectDelivered({
          instanceId,
          actionId: entry.receipt.actionId,
          effect: delivery.effect,
          outcome,
          deliveredAt: new Date().toISOString(),
        }),
      );
    }
  }
}

async function deliverNotable(
  deps: AppletEffectsRelayDeps,
  tenantId: TenantId,
  instance: AppletInstance,
  receipt: AppletActionReceipt,
): Promise<AppletEffectDeliveryOutcome> {
  // RoomMessage.actorUserId is a required uuid by the Plan 260 human-only
  // contract: an agent-actor notable is never forged into a room message —
  // the agent's own step trace narrates it, and attention carries it.
  if (receipt.actor.kind !== 'user') return 'skipped_agent_actor';
  const actorUserId = receipt.actor.userId;
  if (actorUserId === null) return 'attention_only';
  if (instance.boundSessionId === null || deps.redis === null) return 'attention_only';

  const eventId = appletRoomMessageEventId(instance.instanceId, receipt.actionId);
  if (await roomMessageAlreadyDurable(deps.db, tenantId, eventId)) return 'posted';

  const displayName = await lookupDisplayName(deps.db, actorUserId);
  try {
    await deps.postRoomMessage({
      tenantId,
      sessionId: instance.boundSessionId as SessionId,
      actorUserId,
      ...(displayName !== null ? { actorDisplayName: displayName } : {}),
      body: narrationBody(receipt),
      clientMessageId: `applet:${receipt.actionId}`,
      eventId,
    });
  } catch (err) {
    // 409 = the room is closed, or cold with no snapshot. The receipt still
    // surfaces through attention; a narration never resurrects a session.
    if (statusCodeOf(err) === 409) return 'attention_only';
    throw err;
  }
  return 'posted';
}

async function deliverWaking(
  deps: AppletEffectsRelayDeps,
  tenantId: TenantId,
  instance: AppletInstance,
  receipt: AppletActionReceipt,
  wokenSessions: Set<string>,
  input: AppletActionRelayInput,
): Promise<AppletEffectDeliveryOutcome> {
  // Structural no-op (§4.2): the bound session IS the acting agent's session,
  // and its own actions never wake it.
  if (receipt.actor.kind !== 'user') return 'skipped_agent_actor';
  if (instance.boundSessionId === null || deps.redis === null) return 'attention_only';
  const sessionId = instance.boundSessionId;
  if (wokenSessions.has(sessionId)) return 'coalesced';

  const state = await getSessionStateSafe(deps.redis, tenantId, sessionId);
  // Hot state gone: a wake never resurrects a session. The receipt is in the
  // journal and attention; the room reads it when someone opens it.
  if (!state.ok) return 'attention_only';

  const stepExecutionId = state.state.currentStepExecutionId;
  const step = stepExecutionId ? await getStepState(deps.redis, tenantId, stepExecutionId) : null;
  // Running, or parked on a pause a wake may not answer: the journal carries
  // the receipt and the next turn boundary reads it.
  if (!stepExecutionId || !mayWake(state.state, step)) return 'coalesced';

  if (await hasResumeClaimForStep(deps.db, { tenantId, sessionId, stepExecutionId })) {
    wokenSessions.add(sessionId);
    return 'coalesced';
  }

  // Focus before resume, so the turn the wake starts already knows which
  // instance nominated it.
  await setAppletFocus(deps.redis, tenantId, {
    sessionId,
    instanceId: instance.instanceId,
    source: 'waking_action',
    version: receipt.afterVersion,
  });

  const actorContext =
    input.actorContext?.userId === receipt.actor.userId ? input.actorContext : undefined;
  try {
    await deps.resumeSession({
      tenantId,
      sessionId: sessionId as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      // No payload: the receipt is already on the record and the agent reads
      // the room and its attention surface at the boundary.
      input: {},
      idempotencyKey: `appletwake:${receipt.actionId}`,
      ...(actorContext !== undefined ? { actorContext } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Lost the race to another resume between the mayWake read and the send —
    // the boundary is advancing either way, which is all a wake asks for.
    if (statusCodeOf(err) === 409 || /is not paused/i.test(message)) return 'coalesced';
    // The session advanced and re-paused on a NEW step between our mayWake
    // read and resumeSession's own: a boundary was crossed, the room and the
    // journal carry the receipt, and the fresh pause belongs to whatever
    // parked it (possibly an approval an empty resume must never answer).
    if (/resume mismatch/i.test(message)) return 'coalesced';
    if (/not found/i.test(message)) return 'attention_only';
    throw err;
  }
  wokenSessions.add(sessionId);
  return 'woke';
}

function narrationBody(receipt: AppletActionReceipt): string {
  return receipt.outcome !== undefined && receipt.outcome.length > 0
    ? `${receipt.name} — ${receipt.outcome}`
    : receipt.name;
}

/**
 * Deterministic per-(instance, action) event id, RFC 4122-shaped so the uuid
 * column accepts it. Re-driving the same effect reproduces the same id, which
 * is what makes the durable write — and therefore the whole delivery — replay
 * as a no-op.
 */
export function appletRoomMessageEventId(instanceId: string, actionId: string): string {
  const digest = createHash('sha256').update(`applet-room:${instanceId}:${actionId}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The crash window between a successful post and its delivered mark: the
 * durable event row is the proof the narration already landed, so a re-drive
 * marks without posting again.
 */
async function roomMessageAlreadyDurable(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  eventId: string,
): Promise<boolean> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ eventId: eventLog.eventId })
      .from(eventLog)
      .where(eq(eventLog.eventId, eventId))
      .limit(1),
  );
  return rows.length > 0;
}

async function lookupDisplayName(db: PostgresJsDatabase, userId: string): Promise<string | null> {
  const rows = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const value = (err as { statusCode: unknown }).statusCode;
    if (typeof value === 'number') return value;
  }
  return undefined;
}
