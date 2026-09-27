/**
 * Session membership — the durable roster. Membership is a first-class fact:
 * speaking implies joining, joining never requires speaking. The database row
 * is the sole authority; nothing membership-shaped lives in hot state, so a
 * rehydrated snapshot can never resurrect an obsolete roster.
 *
 * A membership row is a social fact for the agent and the UI — it grants NO
 * read, write, steering, or applet right. Space membership (RBAC) stays the
 * only authorization boundary, revalidated at invite and join; applet seats
 * stay in applet_role_bindings.
 */
import { z } from 'zod';

export const SessionMembershipStatusSchema = z.enum(['invited', 'joined', 'declined', 'left']);
export type SessionMembershipStatus = z.infer<typeof SessionMembershipStatusSchema>;

export const SessionMemberSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  status: SessionMembershipStatusSchema,
  /** Null for speech-joins and self-joins — and after the inviter's erasure. */
  invitedBy: z.string().uuid().nullable(),
  /**
   * Bumped on every re-invitation. The Action Center CAS / notification
   * dedupe identity: an item is `(sessionId, userId, generation)` — a decline
   * followed by a fresh invite is a NEW item, never a resurrected old one.
   */
  generation: z.number().int().positive(),
  invitedAt: z.string().datetime().nullable(),
  joinedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type SessionMember = z.infer<typeof SessionMemberSchema>;

/** A roster entry as surfaces consume it — the row plus a resolved, collision-disambiguated label. */
export const SessionRosterEntrySchema = SessionMemberSchema.extend({
  displayName: z.string().optional(),
});
export type SessionRosterEntry = z.infer<typeof SessionRosterEntrySchema>;

/** An invited session as the Workbench pins it — ahead of recency, with the inviter named. */
export const PendingSessionInviteSchema = z.object({
  sessionId: z.string().uuid(),
  spaceId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  invitedBy: z.string().uuid().nullable(),
  invitedByDisplayName: z.string().optional(),
  invitedAt: z.string().datetime().nullable(),
});
export type PendingSessionInvite = z.infer<typeof PendingSessionInviteSchema>;
