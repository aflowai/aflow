import { z } from 'zod';
import { ActorKindSchema } from '../identity/actorContext.js';

/**
 * The authority a run executes under, captured when the run is established.
 *
 * Held apart from who started the run and who is steering it. Those change —
 * people hand off, take over, drop in to help — and none of that may change
 * whose credentials and policy the agent acts with. A run that could pick up
 * the authority of whoever last touched it is a confused deputy: work begun
 * under one person's access would quietly continue under another's.
 *
 * Versioned so the shape can grow without rewriting what was already recorded.
 */
export const ExecutionAuthoritySnapshotSchema = z.object({
  version: z.literal(1),

  /** Whose authority this is. */
  principalUserId: z.string().uuid(),
  principalKind: ActorKindSchema,

  /** Space the authority was evaluated in, and the roles it was evaluated with. */
  spaceId: z.string().uuid(),
  spaceRole: z.string(),
  tenantRole: z.string(),

  /** When it was established, and what established it. */
  establishedAt: z.string().datetime(),
  establishedReason: z.enum(['start', 'schedule', 'event', 'delegation']),

  /**
   * Whether the run may act with the principal's personal credentials.
   *
   * Autonomous shared work runs under a space or service principal; personal
   * credentials stay personal to their owner and are extended to a run only by
   * that owner's explicit act.
   */
  personalCredentialsGranted: z.boolean(),
});
export type ExecutionAuthoritySnapshot = z.infer<typeof ExecutionAuthoritySnapshotSchema>;

/**
 * Why a run's established authority no longer holds.
 *
 * Long-lived work outlives the access it started with: people leave spaces,
 * roles are narrowed, credentials are revoked. Discovering that mid-run is
 * normal, not exceptional, so it parks the run for a human instead of failing
 * it or — worse — continuing under a principal who no longer has access.
 */
export const AuthorityLossReasonSchema = z.enum([
  'principal_left_space',
  'principal_role_reduced',
  'principal_deactivated',
  'credentials_revoked',
]);
export type AuthorityLossReason = z.infer<typeof AuthorityLossReasonSchema>;

export const AuthorityCheckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: AuthorityLossReasonSchema,
    detail: z.string().max(500),
  }),
]);
export type AuthorityCheck = z.infer<typeof AuthorityCheckSchema>;
