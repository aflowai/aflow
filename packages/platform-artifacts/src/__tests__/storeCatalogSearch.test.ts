import { describe, it, expect } from 'vitest';
import { searchCatalog, searchListings } from '../storeCatalog/search.js';
import { getCatalogEntry } from '../storeCatalog/index.js';

describe('store listing search', () => {
  it("surfaces the connector and the coding bundle for 'github'", () => {
    const ids = searchCatalog('github').map((r) => r.entry.catalogId);
    expect(ids).toContain('github');
    expect(ids).toContain('coding-pr-loop');
  });

  it("surfaces the kaggle bundle for 'kaggle'", () => {
    const ids = searchCatalog('kaggle').map((r) => r.entry.catalogId);
    expect(ids).toContain('kaggle-competition');
  });

  it("surfaces the alpaca bundle for 'trading'", () => {
    const ids = searchCatalog('trading', { maxResults: 10 }).map((r) => r.entry.catalogId);
    expect(ids).toContain('alpaca-thesis-trading');
  });

  it('kind filter restricts results', () => {
    const results = searchCatalog('github', { kind: 'connector' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.entry.kind === 'connector')).toBe(true);
    expect(results.map((r) => r.entry.catalogId)).not.toContain('coding-pr-loop');
  });

  it('ranks results by descending score', () => {
    const scores = searchCatalog('alpaca trading', { maxResults: 10 }).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('excludes unlisted listings unless the query is their exact catalogId', () => {
    const browse = searchCatalog('test fixture', { maxResults: 10 });
    expect(browse.map((r) => r.entry.catalogId)).not.toContain('test-two-skill-bundle');

    const direct = searchCatalog('test-two-skill-bundle');
    expect(direct[0]?.entry.catalogId).toBe('test-two-skill-bundle');
  });

  it('scores deprecated candidates the caller includes — shelf visibility is composed upstream', () => {
    const github = getCatalogEntry('github');
    expect(github).not.toBeNull();
    const deprecated = { ...github!, status: 'deprecated' as const };
    expect(searchListings([deprecated], 'github').map((r) => r.entry.catalogId)).toEqual([
      'github',
    ]);
  });
});
