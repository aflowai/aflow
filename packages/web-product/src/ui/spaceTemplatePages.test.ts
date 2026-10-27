/**
 * Every page a space template's readiness item names is a route that exists
 * (Plan 330 D5), in every edition whose Store lists the template — checked
 * against the route manifest as the help articles' route anchors are.
 */
import {
  SPACE_TEMPLATE_CATALOG,
  getCatalogEntry,
  isListingComposed,
} from '@aflow/platform-artifacts';
import type { ComposedLanes, SpaceTemplate } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { ROUTE_MANIFEST, type WebEdition } from './routeManifest.js';

const EDITION_LANES: Record<WebEdition, ComposedLanes> = {
  hosted: { edition: 'enterprise', codeLane: 'present', hostLane: 'absent', browserLane: 'absent' },
  local: {
    edition: 'community-local',
    codeLane: 'absent',
    hostLane: 'present',
    browserLane: 'present',
  },
};

function listedIn(template: SpaceTemplate): WebEdition[] {
  const entry = getCatalogEntry(template.templateId);
  if (!entry) return [];
  return (Object.keys(EDITION_LANES) as WebEdition[]).filter((edition) =>
    isListingComposed(entry, EDITION_LANES[edition]),
  );
}

function unresolvedPages(template: SpaceTemplate, editions: readonly WebEdition[]): string[] {
  return template.readiness.flatMap((item) => {
    if (item.page === undefined) return [];
    const route = `s/[space]${item.page}`;
    return editions
      .filter(
        (edition) =>
          !ROUTE_MANIFEST.some(
            (entry) => entry.route === route && entry.editions.includes(edition),
          ),
      )
      .map(
        (edition) =>
          `${template.templateId} ${item.key}: '${item.page}' is not in the ${edition} build`,
      );
  });
}

describe('space template readiness pages', () => {
  for (const { template } of SPACE_TEMPLATE_CATALOG) {
    it(`${template.templateId}: every page is a route in every edition that lists it`, () => {
      const editions = listedIn(template);
      expect(editions.length).toBeGreaterThan(0);
      expect(unresolvedPages(template, editions)).toEqual([]);
    });
  }

  it('reports a page that does not exist, and one missing from an edition that lists it', () => {
    const [first] = SPACE_TEMPLATE_CATALOG;
    if (!first) throw new Error('The catalog ships no space template.');
    const base = first.template.readiness[0];
    if (!base) throw new Error('The first template names no readiness item.');
    const fabricated: SpaceTemplate = {
      ...first.template,
      readiness: [
        { ...base, key: 'nowhere', page: '/nowhere' },
        { ...base, key: 'computer', page: '/computer' },
      ],
    };
    expect(unresolvedPages(fabricated, ['hosted', 'local'])).toEqual([
      `${first.template.templateId} nowhere: '/nowhere' is not in the hosted build`,
      `${first.template.templateId} nowhere: '/nowhere' is not in the local build`,
      `${first.template.templateId} computer: '/computer' is not in the hosted build`,
    ]);
  });
});
