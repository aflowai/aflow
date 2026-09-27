import type { ConnectorCatalogEntry } from '@aflow/schemas';

const qParam = {
  name: 'q',
  location: 'query' as const,
  required: true,
  description: 'The search query (max 400 chars / 50 words).',
  schema: { type: 'string', maxLength: 400 },
};

const countParam = {
  name: 'count',
  location: 'query' as const,
  required: false,
  description: 'Number of results to return (max 20 for web, 50 for news/images).',
  schema: { type: 'integer', minimum: 1, maximum: 50 },
};

const offsetParam = {
  name: 'offset',
  location: 'query' as const,
  required: false,
  description: 'Zero-based page offset (max 9). Multiply by count to page through results.',
  schema: { type: 'integer', minimum: 0, maximum: 9 },
};

const countryParam = {
  name: 'country',
  location: 'query' as const,
  required: false,
  description: 'Two-letter country code to localize results (e.g. "US", "DE"). Default "US".',
  schema: { type: 'string' },
};

const searchLangParam = {
  name: 'search_lang',
  location: 'query' as const,
  required: false,
  description: 'Language the search is performed in (e.g. "en", "de").',
  schema: { type: 'string' },
};

const safesearchParam = {
  name: 'safesearch',
  location: 'query' as const,
  required: false,
  description: 'Adult-content filter: off | moderate | strict (default moderate).',
  schema: { type: 'string', enum: ['off', 'moderate', 'strict'] },
};

export const BRAVE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'brave-search',
  version: 1,
  name: 'Brave Search',
  tagline: 'Independent web, news, image, and video search.',
  description:
    'Brave Search API. Query the independent Brave index for web results, news articles, ' +
    'images, and videos, with country, language, and safesearch controls. Read-only. ' +
    'Authenticated with a subscription token sent as the X-Subscription-Token header.',
  tags: ['search', 'web-search', 'news', 'images', 'brave'],
  vendor: 'Brave',
  category: 'search',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyHeaderName: 'X-Subscription-Token',
  setupNote:
    'Subscribe to the Brave Search API (brave.com/search/api) and copy a subscription token ' +
    'for the plan you need (Web, News, Image, or Video are separate products). It is sent as ' +
    'the X-Subscription-Token request header.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Subscription token',
      setupNote: 'From api-dashboard.search.brave.com. Sent as the X-Subscription-Token header.',
    },
  ],
  definition: {
    apiId: 'brave-search',
    name: 'Brave Search',
    description: 'Brave Search API — web, news, image, and video search.',
    baseUrl: 'https://api.search.brave.com',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['search', 'brave'],
    endpoints: [
      {
        endpointId: 'webSearch',
        name: 'Web search',
        description:
          'Search the web. Returns ranked results with title, url, and description, plus ' +
          'optional infobox, FAQ, and discussion clusters.',
        method: 'GET',
        pathTemplate: '/res/v1/web/search',
        params: [qParam, countParam, offsetParam, countryParam, searchLangParam, safesearchParam],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'count' },
        tags: ['web'],
      },
      {
        endpointId: 'newsSearch',
        name: 'News search',
        description: 'Search recent news articles matching a query, sorted by relevance.',
        method: 'GET',
        pathTemplate: '/res/v1/news/search',
        params: [
          qParam,
          countParam,
          offsetParam,
          countryParam,
          searchLangParam,
          safesearchParam,
          {
            name: 'freshness',
            location: 'query',
            required: false,
            description:
              'Restrict to a recency window: pd (past day), pw (past week), pm (past month), ' +
              'py (past year), or a YYYY-MM-DDtoYYYY-MM-DD range.',
            schema: { type: 'string' },
          },
        ],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'count' },
        tags: ['news'],
      },
      {
        endpointId: 'imageSearch',
        name: 'Image search',
        description: 'Search for images matching a query. Returns thumbnails and source urls.',
        method: 'GET',
        pathTemplate: '/res/v1/images/search',
        params: [qParam, countParam, countryParam, searchLangParam, safesearchParam],
        tags: ['images'],
      },
      {
        endpointId: 'videoSearch',
        name: 'Video search',
        description: 'Search for videos matching a query. Returns titles, urls, and metadata.',
        method: 'GET',
        pathTemplate: '/res/v1/videos/search',
        params: [qParam, countParam, offsetParam, countryParam, searchLangParam, safesearchParam],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'count' },
        tags: ['videos'],
      },
    ],
  },
};
