/**
 * Brand-icon wiring guard. Neither package may import the other (the registry
 * is server-side, the brand marks are React components), so the design
 * system's BRAND_ASSETS keys are mirrored here as a literal — kept in sync in
 * both directions: every referenced assetId must exist there, and every brand
 * asset must be referenced by some listing (no dead marks).
 */
import { describe, it, expect } from 'vitest';
import { LISTING_ICONS, STORE_CATALOG, getCatalogEntry } from '../storeCatalog/index.js';

const BRAND_ASSET_IDS = [
  'airtable',
  'alpaca',
  'arxiv',
  'brave',
  'cloudflare',
  'github',
  'gmail',
  'google-calendar',
  'google-sheets',
  'jira',
  'kaggle',
  'linear',
  'notion',
  'pubmed',
  'resend',
  'semantic-scholar',
  'sentry',
  'slack',
  'stripe',
  'twilio',
  'vercel',
  'wikipedia',
] as const;

describe('listing brand icons', () => {
  it('every LISTING_ICONS key is a store listing', () => {
    const known = new Set(STORE_CATALOG.map((entry) => entry.catalogId));
    for (const catalogId of Object.keys(LISTING_ICONS)) {
      expect(known.has(catalogId), `LISTING_ICONS references unknown listing '${catalogId}'`).toBe(
        true,
      );
    }
  });

  it('every brand assetId resolves in BRAND_ASSETS, and every brand asset is used', () => {
    const used = new Set<string>();
    for (const icon of Object.values(LISTING_ICONS)) {
      if (icon.kind !== 'brand') continue;
      expect(
        (BRAND_ASSET_IDS as readonly string[]).includes(icon.assetId),
        `assetId '${icon.assetId}' has no BRAND_ASSETS entry`,
      ).toBe(true);
      used.add(icon.assetId);
    }
    expect([...used].sort()).toEqual([...BRAND_ASSET_IDS]);
  });

  it('icons ride the wrapped envelope', () => {
    expect(getCatalogEntry('github')?.icon).toEqual({ kind: 'brand', assetId: 'github' });
    expect(getCatalogEntry('kaggle-competition')?.icon).toEqual({
      kind: 'brand',
      assetId: 'kaggle',
    });
    expect(getCatalogEntry('coding-pr-loop')?.icon).toBeUndefined();
  });
});
