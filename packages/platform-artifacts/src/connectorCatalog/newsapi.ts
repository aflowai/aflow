import type { ConnectorCatalogEntry } from '@aflow/schemas';

const pageSizeParam = {
  name: 'pageSize',
  location: 'query' as const,
  required: false,
  description: 'Number of results per page (default 20, max 100).',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

const pageParam = {
  name: 'page',
  location: 'query' as const,
  required: false,
  description: 'Page number to fetch (1-based).',
  schema: { type: 'integer', minimum: 1 },
};

const categoryParam = {
  name: 'category',
  location: 'query' as const,
  required: false,
  description: 'News category to filter by.',
  schema: {
    type: 'string',
    enum: ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'],
  },
};

export const NEWSAPI_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'newsapi',
  version: 1,
  name: 'NewsAPI',
  tagline: 'Search worldwide news articles and live top headlines.',
  description:
    'NewsAPI.org REST API. Search millions of articles from over 150,000 sources with keyword, ' +
    'date, domain, and language filters; fetch live top headlines by country or category; and ' +
    'list the available publishers. Read-only. Authenticated with an API key sent as the ' +
    'X-API-Key header.',
  tags: ['news', 'headlines', 'search', 'media'],
  vendor: 'NewsAPI',
  category: 'news',
  honestyLabel: 'curated',
  authKind: 'api_key',
  setupNote:
    'Provide your NewsAPI key (newsapi.org → Get API Key). It is sent as the X-API-Key request ' +
    'header. The free Developer plan is limited to recent articles and non-commercial use.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'NewsAPI key',
      setupNote: 'From newsapi.org/account. Sent as the X-API-Key header.',
    },
  ],
  definition: {
    apiId: 'newsapi',
    name: 'NewsAPI',
    description: 'NewsAPI.org REST API — article search, top headlines, and source listing.',
    baseUrl: 'https://newsapi.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['news', 'search'],
    endpoints: [
      {
        endpointId: 'searchEverything',
        name: 'Search articles',
        description:
          'Search every indexed article with keyword, phrase, date, source, domain, and ' +
          'language filters. Sorted by relevancy, popularity, or publish date.',
        method: 'GET',
        pathTemplate: '/v2/everything',
        params: [
          {
            name: 'q',
            location: 'query',
            required: false,
            description:
              'Keywords or a phrase to search for. Supports exact-match quotes, +must/-exclude ' +
              'prefixes, and AND / OR / NOT with parentheses (max 500 chars). At least one of ' +
              'q, sources, or domains must be provided.',
            schema: { type: 'string', maxLength: 500 },
          },
          {
            name: 'searchIn',
            location: 'query',
            required: false,
            description:
              'Comma-separated fields to search: title, description, content (default all).',
            schema: { type: 'string' },
          },
          {
            name: 'sources',
            location: 'query',
            required: false,
            description:
              'Comma-separated source ids to restrict the search to (max 20; ids from listSources).',
            schema: { type: 'string' },
          },
          {
            name: 'domains',
            location: 'query',
            required: false,
            description:
              'Comma-separated domains to restrict the search to (e.g. "bbc.co.uk,techcrunch.com").',
            schema: { type: 'string' },
          },
          {
            name: 'excludeDomains',
            location: 'query',
            required: false,
            description: 'Comma-separated domains to remove from the results.',
            schema: { type: 'string' },
          },
          {
            name: 'from',
            location: 'query',
            required: false,
            description: 'Oldest article date/time, ISO 8601 (e.g. "2026-07-01").',
            schema: { type: 'string' },
          },
          {
            name: 'to',
            location: 'query',
            required: false,
            description: 'Newest article date/time, ISO 8601 (e.g. "2026-07-18").',
            schema: { type: 'string' },
          },
          {
            name: 'language',
            location: 'query',
            required: false,
            description: 'Two-letter ISO-639-1 language code (e.g. "en", "de").',
            schema: { type: 'string' },
          },
          {
            name: 'sortBy',
            location: 'query',
            required: false,
            description:
              'Sort order: relevancy (closest to q first), popularity (popular sources first), ' +
              'or publishedAt (newest first, default).',
            schema: { type: 'string', enum: ['relevancy', 'popularity', 'publishedAt'] },
          },
          pageSizeParam,
          pageParam,
        ],
        tags: ['search', 'articles'],
      },
      {
        endpointId: 'getTopHeadlines',
        name: 'Get top headlines',
        description:
          'Live top and breaking headlines for a country, category, or set of sources. ' +
          'Sorted by earliest publish date first.',
        method: 'GET',
        pathTemplate: '/v2/top-headlines',
        params: [
          {
            name: 'country',
            location: 'query',
            required: false,
            description:
              'Two-letter ISO 3166-1 country code (e.g. "us", "de"). Cannot be combined with sources.',
            schema: { type: 'string' },
          },
          categoryParam,
          {
            name: 'sources',
            location: 'query',
            required: false,
            description:
              'Comma-separated source ids (from listSources). Cannot be combined with country or category.',
            schema: { type: 'string' },
          },
          {
            name: 'q',
            location: 'query',
            required: false,
            description: 'Keywords or a phrase to filter the headlines by.',
            schema: { type: 'string' },
          },
          pageSizeParam,
          pageParam,
        ],
        tags: ['headlines'],
      },
      {
        endpointId: 'listSources',
        name: 'List sources',
        description:
          'The publishers available for top headlines, with the source ids used by the ' +
          'sources filters.',
        method: 'GET',
        pathTemplate: '/v2/top-headlines/sources',
        params: [
          categoryParam,
          {
            name: 'language',
            location: 'query',
            required: false,
            description: 'Two-letter ISO-639-1 language code to filter sources by.',
            schema: { type: 'string' },
          },
          {
            name: 'country',
            location: 'query',
            required: false,
            description: 'Two-letter ISO 3166-1 country code to filter sources by.',
            schema: { type: 'string' },
          },
        ],
        tags: ['sources', 'reference'],
      },
    ],
  },
};
