import type { ConnectorCatalogEntry } from '@aflow/schemas';

const formatParam = {
  name: 'format',
  location: 'query' as const,
  required: true,
  description: 'Output format. Always pass "json" so the response is JSON rather than HTML.',
  schema: { type: 'string', enum: ['json'] },
};

const actionQueryParam = {
  name: 'action',
  location: 'query' as const,
  required: true,
  description: 'The action API action. Always "query" for these read endpoints.',
  schema: { type: 'string', enum: ['query'] },
};

export const WIKIPEDIA_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'wikipedia',
  version: 1,
  name: 'Wikipedia',
  tagline: 'search and read Wikipedia articles',
  description:
    'English Wikipedia read API. Full-text search for articles, read a clean one-paragraph ' +
    'summary of a page, read the full plain-text intro or article extract, and list the ' +
    'internal links on a page. Read-only, keyless — no credentials required. Mixes the ' +
    'MediaWiki action API (/w/api.php, JSON) with the cleaner REST summary endpoint ' +
    '(/api/rest_v1). Responses are JSON.',
  tags: ['reference', 'encyclopedia', 'search', 'knowledge', 'wikipedia'],
  vendor: 'Wikimedia Foundation',
  category: 'reference',
  honestyLabel: 'curated',
  authKind: 'none',
  definition: {
    apiId: 'wikipedia',
    name: 'Wikipedia',
    description:
      'English Wikipedia read API — article search, page summary, page extract, and page links.',
    baseUrl: 'https://en.wikipedia.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['reference', 'wikipedia'],
    endpoints: [
      {
        endpointId: 'search',
        name: 'Search articles',
        description:
          'Full-text search for articles matching a query. Returns a list of matching pages ' +
          'with title, a snippet, and word/size counts (query.search[]). Use the returned ' +
          'title with getPageSummary or getPageExtract to read a page. Response is JSON.',
        method: 'GET',
        pathTemplate: '/w/api.php',
        params: [
          actionQueryParam,
          formatParam,
          {
            name: 'list',
            location: 'query',
            required: true,
            description: 'The query list module. Always "search" for this endpoint.',
            schema: { type: 'string', enum: ['search'] },
          },
          {
            name: 'srsearch',
            location: 'query',
            required: true,
            description: 'The search term or phrase to look for.',
            schema: { type: 'string' },
          },
          {
            name: 'srlimit',
            location: 'query',
            required: false,
            description: 'Maximum number of results to return (default 10, max 500).',
            schema: { type: 'integer', minimum: 1, maximum: 500 },
          },
          {
            name: 'sroffset',
            location: 'query',
            required: false,
            description: 'Zero-based offset to page through results.',
            schema: { type: 'integer', minimum: 0 },
          },
        ],
        pagination: { style: 'offset', cursorParam: 'sroffset', limitParam: 'srlimit' },
        tags: ['search'],
      },
      {
        endpointId: 'getPageSummary',
        name: 'Get page summary',
        description:
          'The clean REST summary of a page — title, a one-paragraph plain-text extract, a ' +
          'description, and thumbnail/URL metadata. The cleanest way to read what an article ' +
          'is about. Provide the exact page title (spaces or underscores both work, e.g. ' +
          '"Albert Einstein"). Response is JSON.',
        method: 'GET',
        pathTemplate: '/api/rest_v1/page/summary/{title}',
        params: [
          {
            name: 'title',
            location: 'path',
            required: true,
            description:
              'The exact page title, e.g. "Albert Einstein" (from a search result title).',
            schema: { type: 'string' },
          },
        ],
        tags: ['read'],
      },
      {
        endpointId: 'getPageExtract',
        name: 'Get page extract',
        description:
          'The full plain-text extract of a page via the action API (prop=extracts). Set ' +
          'exintro=1 for just the intro section, or omit it for the whole article as plain ' +
          'text. The extract is under query.pages[pageid].extract. Response is JSON.',
        method: 'GET',
        pathTemplate: '/w/api.php',
        params: [
          actionQueryParam,
          formatParam,
          {
            name: 'prop',
            location: 'query',
            required: true,
            description: 'The page property to fetch. Always "extracts" for this endpoint.',
            schema: { type: 'string', enum: ['extracts'] },
          },
          {
            name: 'titles',
            location: 'query',
            required: true,
            description:
              'The page title to fetch (spaces or underscores both work). Multiple titles may ' +
              'be joined with "|".',
            schema: { type: 'string' },
          },
          {
            name: 'explaintext',
            location: 'query',
            required: false,
            description: 'Set "1" to return the extract as plain text rather than limited HTML.',
            schema: { type: 'string', enum: ['1'] },
          },
          {
            name: 'exintro',
            location: 'query',
            required: false,
            description: 'Set "1" to return only the intro section instead of the whole article.',
            schema: { type: 'string', enum: ['1'] },
          },
        ],
        tags: ['read'],
      },
      {
        endpointId: 'getPageLinks',
        name: 'Get page links',
        description:
          'List the internal wiki links (other article titles) on a page via the action API ' +
          '(prop=links). Links are under query.pages[pageid].links[].title. Use to walk from ' +
          'one topic to related articles. Response is JSON.',
        method: 'GET',
        pathTemplate: '/w/api.php',
        params: [
          actionQueryParam,
          formatParam,
          {
            name: 'prop',
            location: 'query',
            required: true,
            description: 'The page property to fetch. Always "links" for this endpoint.',
            schema: { type: 'string', enum: ['links'] },
          },
          {
            name: 'titles',
            location: 'query',
            required: true,
            description: 'The page title whose links to list (spaces or underscores both work).',
            schema: { type: 'string' },
          },
          {
            name: 'pllimit',
            location: 'query',
            required: false,
            description: 'Maximum number of links to return (default 10, max 500).',
            schema: { type: 'integer', minimum: 1, maximum: 500 },
          },
        ],
        tags: ['read', 'links'],
      },
    ],
  },
};
