/**
 * The edition fold, which decides what the shell offers before `/users/me`
 * answers. The window this pins is the cold load: every surface gate reads
 * this fold, so a default of "everything" is a period in which a control the
 * server never registered renders and 404s on the first click.
 */
import { describe, it, expect } from 'vitest';
import { toEdition } from './useEdition.js';

describe('an unanswered /users/me', () => {
  it('composes no surface, so every surface gate withholds', () => {
    for (const data of [undefined, {}, { edition: {} }, { edition: { surfaces: ['voice'] } }]) {
      const edition = toEdition(data);
      expect(edition.isLoading).toBe(true);
      expect(edition.surfaces.size).toBe(0);
      expect(edition.surfaces.has('voice')).toBe(false);
      expect(edition.surfaces.has('space-members')).toBe(false);
    }
  });

  it('reports the wait, so a caller can render a skeleton in its place', () => {
    expect(toEdition(undefined).isLoading).toBe(true);
  });
});

describe('an answered /users/me', () => {
  it('carries the surfaces the server named, and only those', () => {
    const edition = toEdition({
      edition: { id: 'enterprise', surfaces: ['voice', 'space-members'] },
    });
    expect(edition.isLoading).toBe(false);
    expect(edition.id).toBe('enterprise');
    expect(edition.surfaces.has('voice')).toBe(true);
    expect(edition.surfaces.has('space-members')).toBe(true);
    expect(edition.surfaces.has('audit')).toBe(false);
  });

  it('names the local edition and withholds what it did not compose', () => {
    const edition = toEdition({ edition: { id: 'community-local', surfaces: ['credentials'] } });
    expect(edition.id).toBe('community-local');
    expect(edition.surfaces.has('credentials')).toBe(true);
    expect(edition.surfaces.has('voice')).toBe(false);
  });

  it('reads an edition it does not recognise as the hosted one', () => {
    expect(toEdition({ edition: { id: 'something-newer' } }).id).toBe('enterprise');
  });

  it('is answered even when it composed nothing, so a gate stops waiting', () => {
    const edition = toEdition({ edition: { id: 'community-local' } });
    expect(edition.isLoading).toBe(false);
    expect(edition.surfaces.size).toBe(0);
  });

  it('carries the lanes in the shape the catalog derivation reads', () => {
    const edition = toEdition({
      edition: {
        id: 'community-local',
        surfaces: [],
        lanes: { codeLane: 'absent', hostLane: 'present' },
      },
    });
    expect(edition.lanes).toEqual({
      edition: 'community-local',
      codeLane: 'absent',
      hostLane: 'present',
    });
  });

  // A lane is composed only where the server used that word. Anything else —
  // an older process, a typo, an omitted block — is a lane nothing can run on.
  it('reads a lane it was not told about as absent', () => {
    const edition = toEdition({
      edition: { id: 'enterprise', lanes: { codeLane: 'maybe' } },
    });
    expect(edition.lanes).toEqual({
      edition: 'enterprise',
      codeLane: 'absent',
      hostLane: 'absent',
    });
  });
});

describe('an unanswered /users/me, on lanes', () => {
  it('names none, so a lane gate withholds rather than guessing', () => {
    expect(toEdition(undefined).lanes).toBeNull();
  });
});
