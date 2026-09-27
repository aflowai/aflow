'use client';

import { useMemo } from 'react';
import { useApiQuery } from './useApiQuery.js';

/**
 * The edition serving this client, and the surfaces it composed.
 *
 * Read from `/users/me` because that is the call every client already makes
 * before it renders anything — a second endpoint would mean a second query key
 * and a second moment where the shell knows less than the server does.
 *
 * `surfaces` is the server's own registry, so a control hidden because its
 * surface is absent cannot drift from what the API actually serves. A control
 * whose route was never registered would otherwise render, be clicked, and
 * 404.
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
  /** True until `/users/me` answers; render nothing edition-dependent yet. */
  isLoading: boolean;
}

interface MeEditionResponse {
  edition?: { id?: string; surfaces?: string[] };
}

const NO_SURFACES: ReadonlySet<string> = new Set<string>();

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
    return { id: null, surfaces: NO_SURFACES, isLoading: true };
  }
  return {
    id: edition.id === 'community-local' ? 'community-local' : 'enterprise',
    surfaces: new Set(edition.surfaces ?? []),
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
