/**
 * A catalog id names exactly one listing across every kind. The store's
 * provenance keys installs on (catalogId, spaceId) with no kind column, and
 * bundle claims encode 'bundle:<catalogId>' — a cross-kind collision would
 * make both ambiguous.
 */
import { describe, it, expect } from 'vitest';
import { SKILL_CATALOG } from './skillCatalog/index.js';
import { SKILL_BUNDLE_CATALOG } from './skillBundleCatalog.js';
import { CONNECTOR_CATALOG } from './connectorCatalog/index.js';
import { APPLET_CATALOG } from './appletCatalog/index.js';

describe('catalog ids are globally unique across kinds', () => {
  it('no id appears in more than one registry', () => {
    const byKind = {
      skill: SKILL_CATALOG.map((e) => e.catalogId),
      bundle: SKILL_BUNDLE_CATALOG.map((e) => e.bundleId as string),
      connector: CONNECTOR_CATALOG.map((e) => e.catalogId),
      applet: APPLET_CATALOG.map((e) => e.catalogId),
    };
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [kind, ids] of Object.entries(byKind)) {
      for (const id of ids) {
        const prior = seen.get(id);
        if (prior && prior !== kind) {
          collisions.push(`'${id}' appears in both ${prior} and ${kind} registries`);
        }
        seen.set(id, kind);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('ids are unique within each registry', () => {
    for (const ids of [
      SKILL_CATALOG.map((e) => e.catalogId),
      SKILL_BUNDLE_CATALOG.map((e) => e.bundleId as string),
      CONNECTOR_CATALOG.map((e) => e.catalogId),
      APPLET_CATALOG.map((e) => e.catalogId),
    ]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
