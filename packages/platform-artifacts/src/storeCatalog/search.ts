import { scoreFieldWeightedBM25, tokenize, tokenizeQuery } from '@aflow/schemas';
import type { CatalogEntry, CatalogEntryKind } from '@aflow/schemas';
import { listCatalog } from './index.js';

const FIELD_WEIGHTS = {
  name: 2.0,
  taglineTags: 1.5,
  description: 1.0,
  vendorCategory: 1.0,
} as const;

type SearchField = keyof typeof FIELD_WEIGHTS;
const SEARCH_FIELDS = Object.keys(FIELD_WEIGHTS) as readonly SearchField[];

interface ListingDoc {
  entry: CatalogEntry;
  fields: Record<SearchField, string[]>;
  totalTokens: number;
}

function buildDoc(entry: CatalogEntry): ListingDoc {
  const fields: Record<SearchField, string[]> = {
    name: [...tokenize(entry.name), ...tokenize(entry.catalogId)],
    taglineTags: [...tokenize(entry.tagline), ...entry.tags.flatMap((tag) => tokenize(tag))],
    description: tokenize(entry.description),
    vendorCategory: [...tokenize(entry.vendor ?? ''), ...tokenize(entry.category ?? '')],
  };
  let totalTokens = 0;
  for (const field of SEARCH_FIELDS) totalTokens += fields[field].length;
  return { entry, fields, totalTokens };
}

export interface StoreSearchOptions {
  kind?: CatalogEntryKind;
  maxResults?: number;
}

export interface StoreSearchResult {
  entry: CatalogEntry;
  score: number;
}

/**
 * BM25 search over an explicit listing set. Shelf visibility (published vs
 * deprecated) is the caller's: pass the same candidate set browse would show.
 * `unlisted` listings match only when the query is their exact catalogId
 * (direct-link installability without browse discoverability).
 */
export function searchListings(
  entries: readonly CatalogEntry[],
  query: string,
  options?: StoreSearchOptions,
): StoreSearchResult[] {
  const maxResults = Math.min(options?.maxResults ?? 5, 10);
  const exactId = query.trim();

  const candidates = entries.filter((entry) => {
    if (options?.kind !== undefined && entry.kind !== options.kind) return false;
    if (entry.status === 'unlisted') return entry.catalogId === exactId;
    return true;
  });

  const docs = candidates.map(buildDoc);
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

  const scored: Array<{ entry: CatalogEntry; score: number; exact: boolean }> = [];
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
    const exact = doc.entry.catalogId === exactId;
    if (score > 0 || exact) scored.push({ entry: doc.entry, score, exact });
  }

  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return b.score - a.score;
  });

  return scored.slice(0, maxResults).map(({ entry, score }) => ({ entry, score }));
}

/** BM25 search over every listing this deployment composes a lane for. */
export function searchCatalog(query: string, options?: StoreSearchOptions): StoreSearchResult[] {
  return searchListings(listCatalog(), query, options);
}
