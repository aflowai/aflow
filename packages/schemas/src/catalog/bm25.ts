/**
 * Shared BM25 core: tokenizer, query stopwords, and the field-weighted
 * scoring loop used by both the operation-catalog search and the store
 * listing search. Consumers own their field-weight tables, index/corpus
 * construction, and post-retrieval ranking adjustments.
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Filler words filtered from queries (not from index documents) to reduce noise */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'all',
  'the',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'and',
  'can',
  'how',
]);

/** Simple tokenizer: split on non-alphanumeric, lowercase, filter short tokens */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Tokenize a search query: like tokenize() but also filters filler stopwords */
export function tokenizeQuery(text: string): string[] {
  return tokenize(text).filter((t) => !QUERY_STOPWORDS.has(t));
}

export interface FieldWeightedDocument {
  /** field name → tokens */
  fields: Record<string, string[]>;
  totalTokens: number;
}

export interface Bm25Corpus {
  docCount: number;
  avgDocLength: number;
  /** Number of documents the term appears in (0 when absent). */
  documentFrequency: (term: string) => number;
}

export interface Bm25Score {
  score: number;
  matchedFields: Set<string>;
}

/**
 * Compute the field-weighted BM25 score of one document against query tokens.
 * Fields missing from `fieldWeights` score at weight 1.0.
 */
export function scoreFieldWeightedBM25(
  doc: FieldWeightedDocument,
  queryTokens: readonly string[],
  corpus: Bm25Corpus,
  fieldWeights: Readonly<Record<string, number>>,
): Bm25Score {
  let score = 0;
  const matchedFields = new Set<string>();

  for (const queryToken of queryTokens) {
    const n = corpus.documentFrequency(queryToken);
    if (n <= 0) continue;

    // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
    const idf = Math.log((corpus.docCount - n + 0.5) / (n + 0.5) + 1);

    for (const [fieldName, fieldTokens] of Object.entries(doc.fields)) {
      const tf = fieldTokens.filter((t) => t === queryToken).length;
      if (tf === 0) continue;

      matchedFields.add(fieldName);

      const normTf =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.totalTokens / corpus.avgDocLength)));

      score += idf * normTf * (fieldWeights[fieldName] ?? 1.0);
    }
  }

  return { score, matchedFields };
}
