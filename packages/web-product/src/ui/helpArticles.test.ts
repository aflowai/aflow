/**
 * Help articles name the screens they explain, and those screens must exist in
 * every edition the article claims to be true in (Plan 325 D6). Removing or
 * moving a route fails here, naming the article that describes it.
 */
import { allHelpArticles } from '@aflow/platform-artifacts';
import type { EditionId, HelpArticle } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { BANNED_OPERATOR_WORDS } from './copyVocabulary.js';
import { ROUTE_MANIFEST, type WebEdition } from './routeManifest.js';

const WEB_EDITION: Record<EditionId, WebEdition> = {
  enterprise: 'hosted',
  'community-local': 'local',
};

function unresolvedRouteAnchors(articles: readonly HelpArticle[]): string[] {
  return articles.flatMap((article) =>
    article.anchors.routes.flatMap((route) =>
      article.editions
        .filter(
          (edition) =>
            !ROUTE_MANIFEST.some(
              (entry) => entry.route === route && entry.editions.includes(WEB_EDITION[edition]),
            ),
        )
        .map((edition) => `${article.id}: route '${route}' is not in the ${edition} build`),
    ),
  );
}

function bannedWords(articles: readonly HelpArticle[]): string[] {
  return articles.flatMap((article) =>
    BANNED_OPERATOR_WORDS.filter(({ pattern }) =>
      [article.question, article.summary, article.body].some((text) => pattern.test(text)),
    ).map(({ pattern, instead }) => `${article.id}: says ${String(pattern)} — say ${instead}`),
  );
}

const ARTICLES = allHelpArticles();

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

describe('help article route anchors', () => {
  it('every anchored route exists in every edition the article claims', () => {
    expect(unresolvedRouteAnchors(ARTICLES)).toEqual([]);
  });

  it('reports a route that does not exist, and one missing from a claimed edition', () => {
    const missing = fabricated({ anchors: { routes: ['s/[space]/nowhere'], operations: [] } });
    // The local build carries no members screen.
    const hostedOnly = fabricated({
      id: 'hosted-only',
      anchors: { routes: ['s/[space]/settings/members'], operations: [] },
    });
    expect(unresolvedRouteAnchors([missing, hostedOnly])).toEqual([
      "fabricated: route 's/[space]/nowhere' is not in the enterprise build",
      "fabricated: route 's/[space]/nowhere' is not in the community-local build",
      "hosted-only: route 's/[space]/settings/members' is not in the community-local build",
    ]);
  });
});

describe('help article vocabulary', () => {
  it('speaks the product’s words', () => {
    expect(bannedWords(ARTICLES)).toEqual([]);
  });

  it('reports a banned word', () => {
    expect(bannedWords([fabricated({ body: 'Pick a coding harness.' })])).toHaveLength(1);
  });
});
