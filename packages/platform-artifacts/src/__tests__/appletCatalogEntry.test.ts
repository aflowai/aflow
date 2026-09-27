/**
 * The curated work-board applet listing: validated at module load by the
 * store registry (an invalid entry throws before any test runs), identity-
 * coherent with the fixture it wraps, and discoverable through the same
 * kind-filtered browse every other listing uses.
 */
import { describe, it, expect } from 'vitest';
import { getCatalogEntry, listCatalog } from '../storeCatalog/index.js';
import { APPLET_CATALOG } from '../appletCatalog/index.js';
import { WORK_BOARD_DEFINITION, WORK_BOARD_VIEW_SOURCE } from '../appletFixtures/workBoard.js';

describe('curated applet catalog entry', () => {
  it('the work-board listing is a published applet entry wrapping the fixture', () => {
    const entry = getCatalogEntry('work-board');
    expect(entry).not.toBeNull();
    if (entry === null || entry.kind !== 'applet') {
      throw new Error(`expected applet entry, got ${entry?.kind ?? 'null'}`);
    }
    expect(entry.status).toBe('published');
    expect(entry.honestyLabel).toBe('curated');
    expect(entry.payload.appletDefinition).toEqual(WORK_BOARD_DEFINITION);
    expect(entry.payload.viewSource).toBe(WORK_BOARD_VIEW_SOURCE);
    expect(entry.payload.artifactKind).toBe('applet');
  });

  it('every applet listing pins its appletKey to the catalogId', () => {
    for (const listing of APPLET_CATALOG) {
      expect(listing.payload.appletDefinition.appletKey).toBe(listing.catalogId);
    }
  });

  it('applet listings surface through kind-filtered browse', () => {
    const applets = listCatalog({ kind: 'applet' });
    expect(applets.map((entry) => entry.catalogId)).toContain('work-board');
    for (const entry of applets) expect(entry.kind).toBe('applet');
  });
});
