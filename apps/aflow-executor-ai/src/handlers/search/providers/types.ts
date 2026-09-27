/**
 * Search and fetch provider abstractions.
 *
 * Normalizes results from any backend (Brave, SerpAPI, Jina, etc.)
 * into common formats consumed by SearchHandler.
 */

// ============================================================================
// Search (search.web.search)
// ============================================================================

export interface SearchProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  region?: string;
  language?: string;
  timeRange?: 'day' | 'week' | 'month' | 'year' | 'all';
  safeSearch: 'off' | 'moderate' | 'strict';
  includeImages: boolean;
  includeNews: boolean;
  fetchSnippets: boolean;
  signal?: AbortSignal;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  displayUrl?: string;
  domain?: string;
  date?: string;
  thumbnail?: string;
  score?: number;
}

export interface SearchProviderResponse {
  results: SearchResultItem[];
  totalResults?: number;
  executedQuery: string;
  durationMs: number;
}

export interface SearchProvider {
  readonly name: string;
  search(request: SearchRequest): Promise<SearchProviderResponse>;
}

// ============================================================================
// Fetch (search.web.fetch / search.web.download)
// ============================================================================

/**
 * Extraction cap for save-to-memory downloads. The inline lane's 500K schema
 * max exists for token budgets; this cap bounds the content retained and
 * propagated after extraction (string copies, the Memory write). A save that
 * would exceed it FAILS rather than persisting a silently incomplete doc —
 * the saved copy is complete by construction.
 */
export const MAX_EXTRACTED_CONTENT_CHARS = 5_000_000;

export interface FetchRequest {
  url: string;
  format: 'markdown' | 'text';
  maxContentLength: number;
  includeImages: boolean;
  includeLinks: boolean;
  screenshot: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface FetchProviderResponse {
  content: string;
  title?: string;
  description?: string;
  url: string;
  siteName?: string;
  publishedDate?: string;
  wordCount: number;
  truncated: boolean;
  screenshotUrl?: string;
  links?: Array<{ text: string; url: string }>;
  durationMs: number;
}

export interface FetchProvider {
  readonly name: string;
  fetch(request: FetchRequest): Promise<FetchProviderResponse>;
}
