import {
  HelpArticleSchema,
  type EditionId,
  type HelpArticle,
  type HelpArticleSummary,
  type HelpTheme,
} from '@aflow/schemas';
import { HELP_ARTICLE_SOURCES } from './articles/index.js';

let parsed: readonly HelpArticle[] | undefined;

/** Every article in every edition, parsed once. Readers filter by edition. */
export function allHelpArticles(): readonly HelpArticle[] {
  parsed ??= HELP_ARTICLE_SOURCES.map((source) => HelpArticleSchema.parse(source));
  return parsed;
}

export interface HelpArticleFilter {
  edition: EditionId;
  theme?: HelpTheme;
}

export function listHelpArticles(filter: HelpArticleFilter): HelpArticle[] {
  return allHelpArticles().filter(
    (article) =>
      article.editions.includes(filter.edition) &&
      (filter.theme === undefined || article.theme === filter.theme),
  );
}

/** An article absent from the edition is absent, not refused: it is not true there. */
export function getHelpArticle(id: string, edition: EditionId): HelpArticle | undefined {
  return allHelpArticles().find(
    (article) => article.id === id && article.editions.includes(edition),
  );
}

export function toHelpArticleSummary(article: HelpArticle): HelpArticleSummary {
  return {
    id: article.id,
    theme: article.theme,
    question: article.question,
    summary: article.summary,
  };
}

export { searchHelpArticles } from './search.js';
export type { HelpSearchOptions, HelpSearchResult } from './search.js';
