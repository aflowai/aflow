/**
 * Session roster helpers for the agent turn — split from agentTurn.ts.
 *
 * The roster reads the durable session_participants table, the sole
 * authority for membership: a person invited or joined without ever speaking
 * is in it, and a rehydrated snapshot can never resurrect an obsolete one.
 * Best-effort at assembly — a roster the database cannot serve reads as
 * nobody, degrading to solo behavior, never a failed turn.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RoomSpeaker, TenantId } from '@aflow/schemas';
import { createTenantContext, listSessionParticipants, withTenantSchema } from '@aflow/database';
import { disambiguateLabels, resolveUserLabels, rosterUserLabel } from '@aflow/cybernetic-runtime';

export interface RosterParticipant {
  userId: string;
  displayName?: string;
  /** 'invited' marks a person who has not yet joined — expected, not present. */
  status?: 'joined' | 'invited';
}

export async function loadSessionRoster(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<RosterParticipant[]> {
  try {
    const members = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
      listSessionParticipants(tx, sessionId),
    );
    if (members.length === 0) return [];
    const labels = await resolveUserLabels(
      db,
      members.map((member) => member.userId),
    );
    const display = disambiguateLabels(
      members.map((member) => ({
        userId: member.userId,
        label: rosterUserLabel(labels.get(member.userId), member.userId),
      })),
    );
    return members.map((member) => {
      const label = display.get(member.userId);
      return {
        userId: member.userId,
        ...(label !== undefined ? { displayName: label } : {}),
        status: member.status === 'invited' ? ('invited' as const) : ('joined' as const),
      };
    });
  } catch {
    return [];
  }
}

/**
 * The roster the agent reads when the session holds more than one person.
 * A room of one has nothing to disambiguate, so the block is withheld and the
 * turn stays byte-identical to a solo session.
 */
export function buildSessionParticipantsBlock(
  participants: RosterParticipant[] | undefined,
): { key: string; content: unknown } | undefined {
  if (!participants || participants.length <= 1) return undefined;
  return {
    key: 'SessionParticipants',
    content: {
      participants: participants.map((p) => ({
        userId: p.userId,
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.status === 'invited' ? { status: 'invited (has not joined yet)' } : {}),
      })),
      guidance:
        "Messages are attributed by name when more than one person is present; the 'user' in FlowRunContext is whoever last steered, not the only participant.",
    },
  };
}

/**
 * Whether a steer carries its author into the turn. Only with more than one
 * person in the roster: attribution exists to tell people apart, and in a
 * solo session it would change the bytes of every turn for nothing.
 */
export function resolveSteeringAuthor(
  currentSpeaker: RoomSpeaker | undefined,
  participants: RosterParticipant[] | undefined,
): RoomSpeaker | undefined {
  if (!currentSpeaker || (participants?.length ?? 0) <= 1) return undefined;
  return currentSpeaker;
}

/**
 * Who is speaking on THIS turn. The hot-state actor wins: it was written
 * synchronously by the resume that carried the input. The event-log speaker
 * is only a fallback — the log flushes asynchronously, so right after a
 * hand-off it still names the PREVIOUS steerer, and the freshest message in
 * a shared room is exactly the one that must not be misattributed.
 */
export function resolveTurnSpeaker(
  user: { id?: string; name?: string } | undefined,
  participants: RosterParticipant[] | undefined,
  logSpeaker: RoomSpeaker | undefined,
): RoomSpeaker | undefined {
  if (!user?.id) return logSpeaker;
  const rosterName = participants?.find(
    (participant) => participant.userId === user.id,
  )?.displayName;
  const displayName = rosterName ?? user.name;
  return { actorUserId: user.id, ...(displayName ? { actorDisplayName: displayName } : {}) };
}
