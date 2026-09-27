/**
 * The durable session roster. All helpers run inside the caller's
 * tenant-schema transaction. The table is the sole authority for membership —
 * and membership is a social fact only: nothing here checks or confers
 * access, which stays with space RBAC at the route boundary.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SessionMember, SessionMembershipStatus } from '@aflow/schemas';
import { sessionParticipants, sessions, type SessionParticipantRow } from '../schema/tenant.js';

export function toSessionMember(row: SessionParticipantRow): SessionMember {
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    status: row.status as SessionMembershipStatus,
    invitedBy: row.invitedBy,
    generation: row.generation,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One membership row, or undefined. */
export async function getSessionParticipant(
  tx: PostgresJsDatabase,
  sessionId: string,
  userId: string,
): Promise<SessionMember | undefined> {
  const row = await loadRow(tx, sessionId, userId);
  return row ? toSessionMember(row) : undefined;
}

async function loadRow(
  tx: PostgresJsDatabase,
  sessionId: string,
  userId: string,
): Promise<SessionParticipantRow | undefined> {
  const [row] = await tx
    .select()
    .from(sessionParticipants)
    .where(
      and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)),
    )
    .limit(1);
  return row;
}

export interface JoinOutcome {
  member: SessionMember;
  /**
   * True when this join replaced a pending `invited` row. The invitation is an
   * Action Center item, so only this transition retires one — a join by someone
   * already joined changes nothing an operator can see.
   */
  consumedInvite: boolean;
}

/**
 * Speaking, accepting an invite, or self-joining all land here: the person is
 * `joined` afterwards regardless of prior status. Idempotent; the first join
 * stamps `joinedAt` and later ones keep it.
 */
export async function upsertJoinedParticipant(
  tx: PostgresJsDatabase,
  sessionId: string,
  userId: string,
): Promise<JoinOutcome> {
  const existing = await loadRow(tx, sessionId, userId);
  const [row] = await tx
    .insert(sessionParticipants)
    .values({ sessionId, userId, status: 'joined', joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [sessionParticipants.sessionId, sessionParticipants.userId],
      set: {
        status: 'joined',
        joinedAt: sql`COALESCE(${sessionParticipants.joinedAt}, now())`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return { member: toSessionMember(row!), consumedInvite: existing?.status === 'invited' };
}

export interface InviteOutcome {
  member: SessionMember;
  /** False when the invite was a no-op (already invited at this generation, or already joined). */
  changed: boolean;
}

/**
 * Invite semantics: a fresh row is `invited` at generation 1; a declined or
 * left member is re-invited with the generation bumped (a NEW Action Center
 * identity, never a resurrected one); an already-invited or already-joined
 * member is untouched — concurrent invites are idempotent under the unique
 * key and the caller's transaction.
 */
export async function inviteParticipant(
  tx: PostgresJsDatabase,
  params: { sessionId: string; userId: string; invitedBy: string },
): Promise<InviteOutcome> {
  const existing = await loadRow(tx, params.sessionId, params.userId);
  if (!existing) {
    const [row] = await tx
      .insert(sessionParticipants)
      .values({
        sessionId: params.sessionId,
        userId: params.userId,
        status: 'invited',
        invitedBy: params.invitedBy,
        invitedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { member: toSessionMember(row), changed: true };
    const raced = await loadRow(tx, params.sessionId, params.userId);
    return { member: toSessionMember(raced!), changed: false };
  }
  if (existing.status === 'declined' || existing.status === 'left') {
    const [row] = await tx
      .update(sessionParticipants)
      .set({
        status: 'invited',
        invitedBy: params.invitedBy,
        invitedAt: new Date(),
        generation: sql`${sessionParticipants.generation} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(sessionParticipants.sessionId, params.sessionId),
          eq(sessionParticipants.userId, params.userId),
        ),
      )
      .returning();
    return { member: toSessionMember(row!), changed: true };
  }
  return { member: toSessionMember(existing), changed: false };
}

/** Guarded transition (decline: invited→declined; leave: joined→left). Returns null when the guard misses. */
export async function setParticipantStatus(
  tx: PostgresJsDatabase,
  params: {
    sessionId: string;
    userId: string;
    from: SessionMembershipStatus[];
    to: SessionMembershipStatus;
  },
): Promise<SessionMember | null> {
  const [row] = await tx
    .update(sessionParticipants)
    .set({ status: params.to, updatedAt: sql`now()` })
    .where(
      and(
        eq(sessionParticipants.sessionId, params.sessionId),
        eq(sessionParticipants.userId, params.userId),
        inArray(sessionParticipants.status, params.from),
      ),
    )
    .returning();
  return row ? toSessionMember(row) : null;
}

/** The session's roster, joined first then invited — declined/left excluded. */
export async function listSessionParticipants(
  tx: PostgresJsDatabase,
  sessionId: string,
): Promise<SessionMember[]> {
  const rows = await tx
    .select()
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        inArray(sessionParticipants.status, ['joined', 'invited']),
      ),
    )
    .orderBy(sessionParticipants.joinedAt, sessionParticipants.invitedAt);
  return rows.map(toSessionMember);
}

export interface PendingInviteRow {
  member: SessionMember;
  spaceId: string | null;
}

/** Sessions this user is invited to — the Workbench pins these ahead of recency. */
export async function listPendingInvitesForUser(
  tx: PostgresJsDatabase,
  userId: string,
): Promise<PendingInviteRow[]> {
  const rows = await tx
    .select({ participant: sessionParticipants, spaceId: sessions.spaceId })
    .from(sessionParticipants)
    .leftJoin(sessions, eq(sessions.sessionId, sessionParticipants.sessionId))
    .where(and(eq(sessionParticipants.userId, userId), eq(sessionParticipants.status, 'invited')))
    .orderBy(sessionParticipants.invitedAt);
  return rows.map((row) => ({ member: toSessionMember(row.participant), spaceId: row.spaceId }));
}
