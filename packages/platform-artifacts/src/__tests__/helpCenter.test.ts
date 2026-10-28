/**
 * The help catalog is one source read by the help page, the Helmsman and the
 * screens (Plan 325), so its integrity is checked once, here: every article
 * parses, ids are unique, related ids resolve, every theme has an answer, and
 * every anchored operation still exists.
 */
import { HelpThemeSchema, getOperation, type HelpArticle } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import {
  allHelpArticles,
  getHelpArticle,
  listHelpArticles,
  searchHelpArticles,
} from '../helpCenter/index.js';

function unresolvedOperationAnchors(articles: readonly HelpArticle[]): string[] {
  return articles.flatMap((article) =>
    article.anchors.operations
      .filter((operationId) => getOperation(operationId) === undefined)
      .map((operationId) => `${article.id}: operation '${operationId}' does not exist`),
  );
}

function unresolvedRelated(articles: readonly HelpArticle[]): string[] {
  const ids = new Set(articles.map((article) => article.id));
  return articles.flatMap((article) =>
    article.related
      .filter((id) => id === article.id || !ids.has(id))
      .map((id) => `${article.id}: related '${id}' does not resolve`),
  );
}

function fabricated(overrides: Partial<HelpArticle>): HelpArticle {
  return {
    id: 'fabricated',
    theme: 'concepts',
    question: 'q',
    summary: 's',
    body: 'b',
    editions: ['enterprise', 'community-local'],
    anchors: { routes: [], operations: [] },
    related: [],
    keywords: [],
    ...overrides,
  };
}

const ARTICLES = allHelpArticles();

describe('help catalog integrity', () => {
  it('describes current-node asks and the post-merge live check', () => {
    const article = ARTICLES.find((entry) => entry.body.includes('## The resident'));
    expect(article?.body).toContain(
      'The current blocked step of each stream raises an Action Center item',
    );
    expect(article?.body).toContain('a separate blocked live check waits on a read');
    expect(article?.body).not.toContain('never asks whether your folder holds the merge');
  });
  it('has unique article ids', () => {
    const ids = ARTICLES.map((article) => article.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('answers at least one question in every theme', () => {
    const themes = new Set(ARTICLES.map((article) => article.theme));
    expect(HelpThemeSchema.options.filter((theme) => !themes.has(theme))).toEqual([]);
  });

  it('resolves every related id to another article', () => {
    expect(unresolvedRelated(ARTICLES)).toEqual([]);
  });

  it('anchors only operations that exist', () => {
    expect(unresolvedOperationAnchors(ARTICLES)).toEqual([]);
  });

  it('reports an anchored operation that does not exist, and a dangling related id', () => {
    const article = fabricated({
      anchors: { routes: [], operations: ['help.nothing.here'] },
      related: ['nowhere'],
    });
    expect(unresolvedOperationAnchors([article])).toEqual([
      "fabricated: operation 'help.nothing.here' does not exist",
    ]);
    expect(unresolvedRelated([article])).toEqual([
      "fabricated: related 'nowhere' does not resolve",
    ]);
  });
});

describe('help catalog reads', () => {
  it('lists only the articles true in the edition asked for', () => {
    for (const edition of ['enterprise', 'community-local'] as const) {
      const listed = listHelpArticles({ edition });
      expect(listed.every((article) => article.editions.includes(edition))).toBe(true);
      expect(listed.length).toBe(
        ARTICLES.filter((article) => article.editions.includes(edition)).length,
      );
    }
  });

  it('does not return an article outside its edition', () => {
    const localOnly = ARTICLES.find(
      (article) => article.editions.length === 1 && article.editions[0] === 'community-local',
    );
    expect(localOnly).toBeDefined();
    if (localOnly === undefined) return;
    expect(getHelpArticle(localOnly.id, 'community-local')?.id).toBe(localOnly.id);
    expect(getHelpArticle(localOnly.id, 'enterprise')).toBeUndefined();
  });
});

describe('help search', () => {
  const articles = [
    fabricated({ id: 'add-provider', question: 'How do I add a model provider?' }),
    fabricated({ id: 'pair', question: 'How do I pair this computer?', keywords: ['folder'] }),
    fabricated({ id: 'approve', question: 'Why is a write waiting?', body: 'approval card' }),
  ];

  it('ranks the article whose question matches above one that only mentions it', () => {
    const results = searchHelpArticles(
      [...articles, fabricated({ id: 'mentions', body: 'a provider is mentioned here' })],
      'provider',
    );
    expect(results.map((result) => result.article.id)).toEqual(['add-provider', 'mentions']);
  });

  it('matches keywords and body text, and returns nothing for an unrelated query', () => {
    expect(searchHelpArticles(articles, 'folder')[0]?.article.id).toBe('pair');
    expect(searchHelpArticles(articles, 'approval')[0]?.article.id).toBe('approve');
    expect(searchHelpArticles(articles, 'zebra')).toEqual([]);
  });
});
