/**
 * The durable RoomMessage row, written by every path that posts into a room
 * ahead of the projection — the API's room post and the orchestrator's queued
 * message alike — so the envelope and its idempotency key have one shape.
 *
 * It lives here, beside the event log it writes, because this is the lowest
 * layer both the API (server-runtime) and the orchestrator depend on; the
 * orchestrator importing server-runtime would invert the layering.
 */
import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RoomMessageMetadata } from '@aflow/schemas';
import { eventLog } from '../schema/tenant.js';

export interface RoomMessageEventInput {
  eventId: string;
  sessionId: string;
  messageSeq: number;
  actorUserId: string;
  actorDisplayName?: string;
  body: string;
  clientMessageId?: string;
  wakeHelmsman?: boolean;
  postedAt: Date;
}

/**
 * Write a room message to the event log inside the caller's tenant-schema
 * transaction. Keyed by the event id the stream append already used, so the
 * flush worker — which skips events it finds already written — treats this as
 * the same event rather than a second copy.
 */
export async function persistRoomMessageEvent(
  tx: PostgresJsDatabase,
  input: RoomMessageEventInput,
): Promise<void> {
  const metadata: RoomMessageMetadata = {
    messageSeq: input.messageSeq,
    actorUserId: input.actorUserId,
    body: input.body,
    wakeHelmsman: input.wakeHelmsman === true,
    ...(input.actorDisplayName ? { actorDisplayName: input.actorDisplayName } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  };
  await tx
    .insert(eventLog)
    .values({
      eventId: input.eventId,
      eventType: 'RoomMessage',
      sessionId: input.sessionId,
      timestamp: input.postedAt,
      idempotencyKey: `${input.eventId}:posted`,
      envelope: {
        eventId: input.eventId,
        eventType: 'RoomMessage',
        timestamp: input.postedAt.getTime(),
        sessionId: input.sessionId,
        metadata,
      },
    })
    .onConflictDoNothing();
}

/**
 * A room message event id derived from what identifies its delivery,
 * RFC 4122-shaped so the uuid column accepts it. Delivering the same thing
 * again reproduces the same id, which the stream append's guard and the
 * durable write both dedupe on.
 */
export function deterministicRoomMessageEventId(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
