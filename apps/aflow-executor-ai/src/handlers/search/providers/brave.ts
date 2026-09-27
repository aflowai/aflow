/**
 * Brave Search API provider.
 *
 * Docs: https://api.search.brave.com/app#/web/get-search
 * Free tier: 2000 queries/month. Paid: $5/1000.
 */
import type {
  SearchProvider,
  SearchProviderConfig,
  SearchRequest,
  SearchProviderResponse,
  SearchResultItem,
} from './types.js';

const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';
const REQUEST_TIMEOUT_MS = 15_000;

/** Brave freshness parameter values */
const FRESHNESS_MAP: Record<string, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

/** Brave API web result shape (subset of fields we use) */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
  thumbnail?: { src?: string };
  meta_url?: { hostname?: string; path?: string };
}

interface BraveSearchResponse {
  query?: { original?: string };
  web?: { results?: BraveWebResult[]; total_count?: number };
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: SearchProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? BRAVE_BASE_URL;
  }

  async search(request: SearchRequest): Promise<SearchProviderResponse> {
    const startMs = Date.now();

    const params = new URLSearchParams();
    params.set('q', request.query);
    params.set('count', String(request.maxResults));
    params.set('safesearch', request.safeSearch);

    if (request.region) {
      params.set('country', request.region);
    }
    if (request.language) {
      params.set('search_lang', request.language);
    }
    if (request.timeRange && request.timeRange !== 'all') {
      const freshness = FRESHNESS_MAP[request.timeRange];
      if (freshness) {
        params.set('freshness', freshness);
      }
    }
    if (request.includeNews) {
      params.set('result_filter', 'web,news');
    }

    // Build abort controller that respects both our timeout and the caller's signal
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    if (request.signal) {
      if (request.signal.aborted) {
        clearTimeout(timeout);
        throw new Error('Search request aborted before execution');
      }
      request.signal.addEventListener(
        'abort',
        () => {
          controller.abort();
        },
        { once: true },
      );
    }

    try {
      const url = `${this.baseUrl}?${params.toString()}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        const body = await response.text().catch(() => '');
        if (status === 401) {
          throw new BraveSearchError(
            'Brave Search API authentication failed — check BRAVE_SEARCH_API_KEY',
            status,
            false,
          );
        }
        if (status === 429) {
          throw new BraveSearchError('Brave Search API rate limit exceeded', status, true);
        }
        throw new BraveSearchError(
          `Brave Search API error: ${String(status)} ${body.slice(0, 200)}`,
          status,
          status >= 500,
        );
      }

      const data = (await response.json()) as BraveSearchResponse;
      const durationMs = Date.now() - startMs;

      const results: SearchResultItem[] = (data.web?.results ?? []).map((r) => {
        let domain: string | undefined;
        if (r.url) {
          try {
            domain = new URL(r.url).hostname;
          } catch {
            // URL parsing failed — skip domain
          }
        }

        const item: SearchResultItem = {
          title: r.title ?? '',
          url: r.url ?? '',
        };
        if (r.description) item.snippet = r.description;
        if (domain) item.domain = domain;
        if (r.meta_url?.hostname && r.meta_url.path) {
          item.displayUrl = `${r.meta_url.hostname}${r.meta_url.path}`;
        }
        if (r.page_age) item.date = r.page_age;
        if (r.thumbnail?.src) item.thumbnail = r.thumbnail.src;
        return item;
      });

      return {
        results,
        executedQuery: data.query?.original ?? request.query,
        durationMs,
        ...(data.web?.total_count != null ? { totalResults: data.web.total_count } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class BraveSearchError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = 'BraveSearchError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
