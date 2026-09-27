'use client';

import { useMemo } from 'react';
import type { ComposedLanes } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/**
 * The edition serving this client, the surfaces it composed, and the lanes it
 * can execute on.
 *
 * Read from `/users/me` because that is the call every client already makes
 * before it renders anything — a second endpoint would mean a second query key
 * and a second moment where the shell knows less than the server does.
 *
 * `surfaces` is the server's own registry, so a control hidden because its
 * surface is absent cannot drift from what the API actually serves. A control
 * whose route was never registered would otherwise render, be clicked, and
 * 404.
 *
 * `lanes` answers the other question, which a surface name cannot: a route
 * registered in both editions exists in both, so asking after it is answered
 * yes wherever the lane behind it is absent.
 */
export interface Edition {
  /**
   * `null` until the server answers. Not defaulted to either edition: a
   * default is a claim, and every caller that took one rendered a control the
   * other edition does not serve for as long as the answer took.
   */
  id: 'enterprise' | 'community-local' | null;
  /** The surfaces the server named. Empty until it answers. */
  surfaces: ReadonlySet<string>;
  /**
   * The lanes this deployment composes, in the shape the catalog's own
   * `isOperationComposed` reads. `null` until the server answers.
   */
  lanes: ComposedLanes | null;
  /** True until `/users/me` answers; render nothing edition-dependent yet. */
  isLoading: boolean;
}

interface MeEditionResponse {
  edition?: {
    id?: string;
    surfaces?: string[];
    lanes?: { codeLane?: string; hostLane?: string };
  };
}

const NO_SURFACES: ReadonlySet<string> = new Set<string>();

/** A lane is composed only where the server said so in the one word it uses. */
function toLane(value: string | undefined): 'present' | 'absent' {
  return value === 'present' ? 'present' : 'absent';
}

/**
 * The edition an answer describes, or the closed default while there is none.
 *
 * Exported as a plain fold so the loading case is testable — the web vitest
 * environment is node-only and carries no hook renderer.
 */
export function toEdition(data: MeEditionResponse | undefined): Edition {
  const edition = data?.edition;
  if (!edition?.id) {
    // An unknown edition composes nothing, so a surface gate withholds until
    // the server has said the surface exists: a control that appears late is a
    // flicker, one that appears and then 404s is a defect.
    return { id: null, surfaces: NO_SURFACES, lanes: null, isLoading: true };
  }
  const id = edition.id === 'community-local' ? 'community-local' : 'enterprise';
  return {
    id,
    surfaces: new Set(edition.surfaces ?? []),
    lanes: {
      edition: id,
      codeLane: toLane(edition.lanes?.codeLane),
      hostLane: toLane(edition.lanes?.hostLane),
    },
    isLoading: false,
  };
}

export function useEdition(): Edition {
  const { data } = useApiQuery<MeEditionResponse>({
    key: ['users', 'me'],
    path: '/users/me',
    staleTime: 5 * 60_000,
  });

  return useMemo<Edition>(() => toEdition(data), [data]);
}

/** Whether the server composed a surface. An unknown edition composed none. */
export function useHasSurface(name: string): boolean {
  return useEdition().surfaces.has(name);
}
