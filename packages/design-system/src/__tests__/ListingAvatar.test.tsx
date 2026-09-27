import { describe, it, expect } from 'vitest';
import { BRAND_ASSETS, resolveBrandAsset } from '../brand/index.js';
import {
  ListingAvatar,
  hashListingSeed,
  listingIdenticonCells,
} from '../primitives/ListingAvatar.js';

describe('BRAND_ASSETS registry', () => {
  const brandAssets = [
    'github',
    'jira',
    'alpaca',
    'kaggle',
    'notion',
    'linear',
    'airtable',
    'stripe',
    'twilio',
    'brave',
    'resend',
    'wikipedia',
    'arxiv',
    'pubmed',
    'semantic-scholar',
    'slack',
    'cloudflare',
    'gmail',
    'google-calendar',
    'google-sheets',
    'sentry',
    'vercel',
  ] as const;

  it.each(brandAssets)('resolves the %s brand asset', (assetId) => {
    expect(BRAND_ASSETS[assetId]).toBeTruthy();
    expect(resolveBrandAsset(assetId)).toBe(BRAND_ASSETS[assetId]);
  });

  it('returns undefined for unknown asset ids', () => {
    expect(resolveBrandAsset('not-a-vendor')).toBeUndefined();
  });
});

describe('listingIdenticonCells', () => {
  it('is deterministic for a given seed', () => {
    expect(listingIdenticonCells('catalog.github')).toEqual(
      listingIdenticonCells('catalog.github'),
    );
  });

  it('is left-right symmetric on every row', () => {
    for (const seed of ['a', 'catalog.github', 'skill.daily-trading-cycle', 'x-1', 'x-2']) {
      for (const row of listingIdenticonCells(seed)) {
        expect(row).toHaveLength(5);
        expect(row[0]).toBe(row[4]);
        expect(row[1]).toBe(row[3]);
      }
    }
  });

  it('varies across seeds', () => {
    const patterns = new Set(
      ['catalog.github', 'catalog.jira', 'catalog.alpaca', 'catalog.kaggle'].map((seed) =>
        JSON.stringify(listingIdenticonCells(seed)),
      ),
    );
    expect(patterns.size).toBeGreaterThan(1);
  });
});

describe('hashListingSeed', () => {
  it('is deterministic', () => {
    expect(hashListingSeed('catalog.github')).toBe(hashListingSeed('catalog.github'));
  });

  it('varies across inputs', () => {
    expect(hashListingSeed('a')).not.toBe(hashListingSeed('b'));
  });
});

describe('ListingAvatar', () => {
  it('is exported as a component', () => {
    expect(typeof ListingAvatar).toBe('function');
  });
});
