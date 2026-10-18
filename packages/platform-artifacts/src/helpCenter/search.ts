import { scoreFieldWeightedBM25, tokenize, tokenizeQuery, type HelpArticle } from '@aflow/schemas';

const FIELD_WEIGHTS = {
  question: 2.0,
  keywords: 1.5,
  summary: 1.0,
  body: 0.5,
} as const;

type SearchField = keyof typeof FIELD_WEIGHTS;
const SEARCH_FIELDS = Object.keys(FIELD_WEIGHTS) as readonly SearchField[];

interface ArticleDoc {
  article: HelpArticle;
  fields: Record<SearchField, string[]>;
  totalTokens: number;
}

function buildDoc(article: HelpArticle): ArticleDoc {
  const fields: Record<SearchField, string[]> = {
    question: tokenize(article.question),
    keywords: article.keywords.flatMap((keyword) => tokenize(keyword)),
    summary: tokenize(article.summary),
    body: tokenize(article.body),
  };
  let totalTokens = 0;
  for (const field of SEARCH_FIELDS) totalTokens += fields[field].length;
  return { article, fields, totalTokens };
}

export interface HelpSearchOptions {
  maxResults?: number;
}

export interface HelpSearchResult {
  article: HelpArticle;
  score: number;
}

/**
 * BM25 over an explicit article set. Edition filtering is the caller's: pass
 * the articles the reader may see, so a search can never surface one a list
 * would not.
 */
export function searchHelpArticles(
  articles: readonly HelpArticle[],
  query: string,
  options?: HelpSearchOptions,
): HelpSearchResult[] {
  const maxResults = options?.maxResults ?? 10;
  const docs = articles.map(buildDoc);
  const avgDocLength =
    docs.length > 0 ? docs.reduce((sum, doc) => sum + doc.totalTokens, 0) / docs.length : 1;

  const docFrequency = new Map<string, number>();
  for (const doc of docs) {
    const terms = new Set<string>();
    for (const field of SEARCH_FIELDS) {
      for (const token of doc.fields[field]) terms.add(token);
    }
    for (const term of terms) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
  }

  const queryTokens = tokenizeQuery(query);
  const scored: HelpSearchResult[] = [];
  for (const doc of docs) {
    const { score } = scoreFieldWeightedBM25(
      doc,
      queryTokens,
      {
        docCount: docs.length,
        avgDocLength,
        documentFrequency: (term) => docFrequency.get(term) ?? 0,
      },
      FIELD_WEIGHTS,
    );
    if (score > 0) scored.push({ article: doc.article, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}
