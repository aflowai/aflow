/**
 * Speak-implies-join: an authenticated human's message, resume, or session
 * start enrolls them in the durable roster. Only these routes call it —
 * relay narration and service actors never reach here, so they can never
 * become durable participants.
 *
 * Best-effort by design: the roster is a social fact, and a session action
 * must never fail because a membership row could not be written (including
 * the deploy window before migration 157 has run).
 */
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createTenantContext,
  inviteParticipant,
  spaceMemberships,
  upsertJoinedParticipant,
  withTenantSchema,
} from '@aflow/database';
import { publishActionCenterWake } from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';
import { resolveSessionSpaceId } from './sessionSpaceAccess.js';

export async function recordSpeechJoin(
  app: FastifyInstance,
  tenantId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  const db = app.appContext.db as PostgresJsDatabase | null;
  if (!db) return;
  try {
    const outcome = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
      upsertJoinedParticipant(tx, sessionId, userId),
    );
    // Speaking is how most invitees accept, so retiring the invitation card is
    // this path's ordinary outcome, not an edge case. Gated on the transition:
    // every later message re-joins an already-joined speaker and moves nothing,
    // which keeps the lookup and the wake off the per-message path.
    if (!outcome.consumedInvite) return;
    const redis = app.appContext.redis;
    if (!redis) return;
    // The card lives in the SESSION's space, which the calling route's space
    // header is not forced to match.
    const lookup = await resolveSessionSpaceId(app, tenantId as TenantId, sessionId);
    if (!lookup.found || !lookup.spaceId) return;
    publishActionCenterWake(redis, {
      source: 'speech_join',
      tenantId,
      spaceId: lookup.spaceId,
    });
  } catch (err) {
    app.log.warn(
      { err, sessionId, userId },
      'speech-join not recorded — roster will catch up on the next action',
    );
  }
}

/**
 * Invitations riding session start — the two-player game begins as one
 * action. Same trust boundary as the invite route: only members of the
 * session's space are invited; anyone else in the list is skipped, and a
 * failure never fails the start.
 */
export async function recordStartInvites(
  app: FastifyInstance,
  params: {
    tenantId: string;
    spaceId: string;
    sessionId: string;
    invitedBy: string;
    invitees: string[];
  },
): Promise<void> {
  const db = app.appContext.db as PostgresJsDatabase | null;
  if (!db) return;
  try {
    const memberRows = await db
      .select({ userId: spaceMemberships.userId })
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.tenantId, params.tenantId),
          eq(spaceMemberships.spaceId, params.spaceId),
          inArray(spaceMemberships.userId, params.invitees),
        ),
      );
    const memberIds = new Set(memberRows.map((row) => row.userId));
    const eligible = params.invitees.filter(
      (userId) => memberIds.has(userId) && userId !== params.invitedBy,
    );
    if (eligible.length === 0) return;
    await withTenantSchema(db, createTenantContext(params.tenantId as TenantId), async (tx) => {
      for (const userId of eligible) {
        await inviteParticipant(tx, {
          sessionId: params.sessionId,
          userId,
          invitedBy: params.invitedBy,
        });
      }
    });
    if (app.appContext.redis) {
      publishActionCenterWake(app.appContext.redis, {
        source: 'session_invitation',
        tenantId: params.tenantId,
        spaceId: params.spaceId,
      });
    }
  } catch (err) {
    app.log.warn(
      { err, sessionId: params.sessionId },
      'start invites not recorded — invite from the session instead',
    );
  }
}
