import { z } from 'zod';

/**
 * Backstop, not a concision device — a person pasting a stack trace or a spec
 * into the room is normal.
 */
export const ROOM_MESSAGE_MAX_LENGTH = 32_000;

/**
 * A message a person posted into a session's room.
 *
 * Rides the session's own event stream rather than a second log: the reducer
 * that folds session events is the same one a cold-mounting viewer runs, so
 * room messages converge exactly like every other event, and they flush,
 * expire, and rehydrate on the paths that already exist.
 */
export const RoomMessageMetadataSchema = z.object({
  /**
   * Session-local monotonic position, allocated at append.
   *
   * The one cursor domain that survives the Redis-stream to Postgres
   * boundary — stream ids and durable sequence numbers are not interchangeable
   * and neither is stable across rehydration.
   */
  messageSeq: z.number().int().positive(),

  /** Server-stamped at the authenticated boundary, never taken from the client. */
  actorUserId: z.string().uuid(),

  /** Display only. Authorization reads the id. */
  actorDisplayName: z.string().max(200).optional(),

  body: z.string().min(1).max(ROOM_MESSAGE_MAX_LENGTH),

  /**
   * Whether this message advanced the agent. Posting to a room never does;
   * a wake carries the same message with this set.
   */
  wakeHelmsman: z.boolean(),

  /** Echo key for the sender's optimistic render. */
  clientMessageId: z.string().max(200).optional(),
});
export type RoomMessageMetadata = z.infer<typeof RoomMessageMetadataSchema>;

/**
 * What people said in the room since the agent last read it.
 *
 * Structure, not taxonomy: entries carry who spoke and what they said, and
 * nothing marks a message as authoritative or as an instruction. The agent is
 * a teammate reading the room — it must never infer a command from a tag, and
 * it must never read "Sara: haha" as one either, which is exactly why the
 * authorship is structural instead of being folded into prose upstream.
 */
export const RoomExchangeEntrySchema = z.object({
  messageSeq: z.number().int().positive(),
  /** Who spoke. Server-stamped at the authenticated boundary. */
  actorUserId: z.string().uuid(),
  /** What to call them. Falls back to the id when a display name is unknown. */
  actorDisplayName: z.string().max(200).optional(),
  body: z.string().min(1).max(ROOM_MESSAGE_MAX_LENGTH),
});
export type RoomExchangeEntry = z.infer<typeof RoomExchangeEntrySchema>;

/**
 * How much of the room one turn will read.
 *
 * A bound rather than a policy: the agent reads what it missed, and a room
 * that ran away while it was busy is truncated from the oldest end so the
 * most recent exchange — the part someone is waiting on — always arrives.
 */
export const ROOM_EXCHANGE_MAX_ENTRIES = 50;

/**
 * Who said something, for the times only the speaker is needed.
 *
 * The same shape the exchange carries, so attribution reads identically
 * whether a message arrived by being posted into the room or by steering the
 * run — a person should not appear to be two different speakers depending on
 * which button they pressed.
 */
export const RoomSpeakerSchema = RoomExchangeEntrySchema.pick({
  actorUserId: true,
  actorDisplayName: true,
});
export type RoomSpeaker = z.infer<typeof RoomSpeakerSchema>;
