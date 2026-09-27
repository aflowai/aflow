/**
 * What a surface offers is decided by the lane, never by the surface name.
 *
 * The failure this stands against is silent and looks right in review: the page
 * renders, the designation saves, and the first run refuses it — because the
 * route is registered in both editions and only the lane behind it is absent.
 */
import { describe, expect, it } from 'vitest';

import { toEdition } from '../hooks/useEdition.js';
import { isRepoDesignationOffered } from './edition-offers.js';

describe('repository designations', () => {
  it('are offered where the coding lane is composed', () => {
    const edition = toEdition({
      edition: {
        id: 'enterprise',
        surfaces: [],
        lanes: { codeLane: 'present', hostLane: 'absent' },
      },
    });
    expect(isRepoDesignationOffered(edition)).toBe(true);
  });

  it('are withheld where it is not, whichever edition says so', () => {
    for (const id of ['community-local', 'enterprise']) {
      const edition = toEdition({
        edition: { id, surfaces: [], lanes: { codeLane: 'absent', hostLane: 'present' } },
      });
      expect(isRepoDesignationOffered(edition)).toBe(false);
    }
  });

  it('are withheld until the server has said, so nothing appears and then dies', () => {
    expect(isRepoDesignationOffered(toEdition(undefined))).toBe(false);
  });

  it('are withheld where an answer named no lanes at all', () => {
    expect(isRepoDesignationOffered(toEdition({ edition: { id: 'community-local' } }))).toBe(false);
  });
});
