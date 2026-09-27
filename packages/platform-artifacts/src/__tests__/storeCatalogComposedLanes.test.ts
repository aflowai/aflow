/**
 * The Store lists and installs only what the edition composes: a listing whose
 * tasks name a lane the deployment does not carry is absent from browse and
 * search rather than shown and refused at install.
 */
import { describe, it, expect } from 'vitest';
import type { ComposedLanes } from '@aflow/schemas';
import { getCatalogEntry, listCatalog } from '../storeCatalog/index.js';
import {
  isListingComposed,
  listingRequiredOperations,
  uncomposedListingReason,
} from '../storeCatalog/composedLanes.js';
import { searchListings } from '../storeCatalog/search.js';

const HOSTED: ComposedLanes = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'absent',
};

const LOCAL_WITH_MACHINE: ComposedLanes = {
  edition: 'community-local',
  codeLane: 'absent',
  hostLane: 'present',
};

const LOCAL_WITHOUT_MACHINE: ComposedLanes = {
  edition: 'community-local',
  codeLane: 'absent',
  hostLane: 'absent',
};

function entryOrThrow(catalogId: string) {
  const entry = getCatalogEntry(catalogId);
  if (!entry) throw new Error(`${catalogId} listing must exist`);
  return entry;
}

function catalogIds(lanes: ComposedLanes): string[] {
  return listCatalog({ lanes }).map((entry) => entry.catalogId);
}

describe('store listings against the edition’s composed lanes', () => {
  it('derives a bundle’s required operations from its skills’ tasks', () => {
    expect(listingRequiredOperations(entryOrThrow('local-code-review'))).toEqual([
      'host.harness.run',
    ]);
    expect(listingRequiredOperations(entryOrThrow('coding-pr-loop'))).toEqual(
      expect.arrayContaining(['code.agent.run', 'code.repo.push']),
    );
  });

  it('lists a host-lane bundle only where a host lane is composed', () => {
    expect(catalogIds(LOCAL_WITH_MACHINE)).toContain('local-code-review');
    expect(catalogIds(HOSTED)).not.toContain('local-code-review');
    expect(catalogIds(LOCAL_WITHOUT_MACHINE)).not.toContain('local-code-review');
  });

  it('keeps a host-lane bundle out of search, exact id included', () => {
    const withhold = listCatalog({ lanes: HOSTED });
    expect(
      searchListings(withhold, 'local-code-review', { maxResults: 10 }).map(
        (r) => r.entry.catalogId,
      ),
    ).not.toContain('local-code-review');

    const compose = listCatalog({ lanes: LOCAL_WITH_MACHINE });
    expect(
      searchListings(compose, 'local-code-review', { maxResults: 10 }).map(
        (r) => r.entry.catalogId,
      ),
    ).toContain('local-code-review');
  });

  it('withholds the coding bundle where no coding lane is composed', () => {
    expect(catalogIds(HOSTED)).toContain('coding-pr-loop');
    expect(catalogIds(LOCAL_WITH_MACHINE)).not.toContain('coding-pr-loop');
  });

  it('leaves a bundle naming only platform lanes untouched everywhere', () => {
    for (const lanes of [HOSTED, LOCAL_WITH_MACHINE, LOCAL_WITHOUT_MACHINE]) {
      expect(catalogIds(lanes), lanes.edition).toContain('web-research');
      expect(catalogIds(lanes), lanes.edition).toContain('github');
      expect(isListingComposed(entryOrThrow('web-research'), lanes)).toBe(true);
    }
  });

  it('refuses an uncomposed listing in the operation’s own words, and only then', () => {
    const reason = uncomposedListingReason(entryOrThrow('local-code-review'), HOSTED);
    expect(reason).toContain('lane_not_composed');
    expect(reason).toContain('host.harness.run');
    expect(reason).toContain('enterprise');
    expect(
      uncomposedListingReason(entryOrThrow('local-code-review'), LOCAL_WITH_MACHINE),
    ).toBeNull();
    expect(uncomposedListingReason(entryOrThrow('github'), LOCAL_WITHOUT_MACHINE)).toBeNull();
  });
});
