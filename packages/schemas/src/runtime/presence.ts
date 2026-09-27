import { z } from 'zod';

/**
 * Who is in a room right now.
 *
 * Ephemeral by construction: presence never enters the durable event log,
 * because "Sara had this open on Tuesday" is not part of what happened — it
 * is a property of this moment, and a stale roster is worse than none.
 */
export const PresenceActivitySchema = z.enum(['viewing', 'typing']);
export type PresenceActivity = z.infer<typeof PresenceActivitySchema>;

export const PresenceEntrySchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().max(200).optional(),
  /**
   * One person can have the same room open more than once, and each copy
   * comes and goes independently. Roster identity is the person; liveness is
   * per tab.
   */
  tabId: z.string().min(1).max(128),
  activity: PresenceActivitySchema,
  /** Whether this person currently holds the wheel (see the driver claim). */
  driving: z.boolean().optional(),
  /** Epoch ms of the last heartbeat; entries older than the TTL are dropped. */
  at: z.number().int().positive(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

/** One person in the rendered roster, folded across their tabs. */
export const PresenceParticipantSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().max(200).optional(),
  activity: PresenceActivitySchema,
  driving: z.boolean().optional(),
  /** Most recent heartbeat across this person's tabs. */
  at: z.number().int().positive(),
});
export type PresenceParticipant = z.infer<typeof PresenceParticipantSchema>;

export const PresenceRosterSchema = z.object({
  sessionId: z.string().uuid(),
  participants: z.array(PresenceParticipantSchema),
});
export type PresenceRoster = z.infer<typeof PresenceRosterSchema>;

/** How long an entry survives without a heartbeat. */
export const PRESENCE_TTL_SECONDS = 45;

/** How often a client should heartbeat — comfortably inside the TTL. */
export const PRESENCE_HEARTBEAT_SECONDS = 15;
