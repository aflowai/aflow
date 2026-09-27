import { z } from 'zod';

/**
 * What changed in a room while you were away.
 *
 * The defining moment of supervising work asynchronously is arriving late —
 * to a run that moved on, to a room where two people already decided
 * something, or to a thread a colleague opened while you were away.
 *
 * Unseen is unseen: a room never opened counts in full. Belonging to the
 * space is what gives a person standing in its work, and whether they
 * happened to visit one thread does not change that.
 *
 * Counted, not narrated: a delta computed from the log is always true and
 * costs nothing to produce. Prose over these numbers can come later, but it
 * may never replace them.
 */
export const CatchUpDeltaSchema = z.object({
  /** False when you have seen everything — the caller renders nothing. */
  hasNews: z.boolean(),

  /**
   * Messages said in this room that you have not read.
   *
   * Counted by position in the conversation, not by walking the event log:
   * one streaming agent turn emits hundreds of log entries, so a walk would
   * report nothing in exactly the busy rooms this exists for. Your own
   * messages never appear here — sending advances your own position.
   */
  messagesFromOthers: z.number().int().nonnegative(),

  /** Steps that finished since your last visit. */
  stepsCompleted: z.number().int().nonnegative(),
  /** Steps that failed since your last visit. */
  stepsFailed: z.number().int().nonnegative(),

  /** The run's status now, when it changed while you were away. */
  statusNow: z.string().optional(),

  /** Whether the room is currently waiting on a person. */
  awaitingInput: z.boolean(),

  /**
   * The conversation position you had reached — the line in the room is drawn
   * above the first message past it.
   *
   * A room already shows what was said, so the useful thing is a mark where
   * you stopped, not a paraphrase of messages that are on screen. Given as a
   * position rather than a message id so the client can place the line from
   * the timeline it already has, without the server walking the log to find
   * the same message.
   */
  seenMessageSeq: z.number().int().nonnegative(),
});
export type CatchUpDelta = z.infer<typeof CatchUpDeltaSchema>;

/**
 * How long a read marker outlives its room.
 *
 * Long enough that returning to week-old work still reports honestly, short
 * enough that markers for rooms nobody revisits do not accumulate forever.
 */
export const LAST_SEEN_TTL_SECONDS = 90 * 24 * 60 * 60;
