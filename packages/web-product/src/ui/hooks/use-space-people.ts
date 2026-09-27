'use client';

import { useMemo } from 'react';
import { useApiQuery } from './useApiQuery.js';
import { useHasSurface } from './useEdition.js';

type SpaceRole = 'admin' | 'editor' | 'viewer';

interface SpaceMember {
  userId: string;
  role: SpaceRole;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface SpacePerson {
  displayName: string;
  avatarUrl: string | null;
  role: SpaceRole;
}

/**
 * The people who can appear in a space, by id.
 *
 * Sourced from the space's own membership rather than the tenant user list,
 * which only an admin may read — asking that question of an admin-only
 * endpoint meant a plain member saw every teammate as "Someone else" while an
 * admin saw names, for no reason the product intends.
 *
 * It is also the right question to ask. Presence, message authorship and the
 * roster are all space-scoped, so the people who can possibly appear in them
 * are exactly this space's members.
 */
export function useSpacePeople(
  spaceId: string | null | undefined,
): (userId: string | undefined) => SpacePerson | undefined {
  return useSpaceRoster(spaceId).personFor;
}

/**
 * The same membership, as both a lookup and a list — the list is what a
 * "hand this to…" picker enumerates.
 */
export function useSpaceRoster(spaceId: string | null | undefined): {
  personFor: (userId: string | undefined) => SpacePerson | undefined;
  people: Array<SpacePerson & { userId: string }>;
} {
  // A roster only exists where the edition composes the route that serves it. The
  // single-user edition registers none, so asking anyway spends a 404 on every
  // dashboard load and reports nothing — the surface is the same question the
  // shell already asks before offering the People entry.
  const hasSpaceMembers = useHasSurface('space-members');

  const members = useApiQuery<{ members?: SpaceMember[] }>({
    key: ['space', spaceId ?? 'none', 'members'],
    path: `/spaces/${spaceId ?? ''}/members`,
    enabled: Boolean(spaceId) && hasSpaceMembers,
    staleTime: 5 * 60 * 1000,
    // Held by every row of the Action Center and by any list that names
    // people, so a remount-driven retry per holder is the shape to avoid.
    retryOnMount: false,
  });

  return useMemo(() => {
    const people = (members.data?.members ?? []).map((m) => ({
      userId: m.userId,
      displayName: m.displayName ?? 'Someone',
      avatarUrl: m.avatarUrl,
      role: m.role,
    }));
    const byId = new Map(people.map((p) => [p.userId, p]));
    return {
      personFor: (userId: string | undefined) => (userId ? byId.get(userId) : undefined),
      people,
    };
  }, [members.data]);
}
