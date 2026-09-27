import type { ConnectorCatalogEntry } from '@aflow/schemas';

const crawlIdParam = {
  name: 'id',
  location: 'path' as const,
  required: true,
  description: 'The crawl job id returned by the crawl endpoint.',
  schema: { type: 'string' },
};

const formatsSchema = {
  type: 'array',
  description:
    'Output formats to return for each page. "markdown" (default) is the cleaned content; ' +
    '"html" is the sanitized HTML; "rawHtml" is the untouched HTML; "links" lists outbound ' +
    'links; "screenshot" captures the rendered page.',
  items: {
    type: 'string',
    enum: ['markdown', 'html', 'rawHtml', 'links', 'screenshot'],
  },
};

const scrapeOptionsSchema = {
  type: 'object',
  description: 'How each crawled page is scraped — same options as the scrape endpoint.',
  properties: {
    formats: formatsSchema,
    onlyMainContent: {
      type: 'boolean',
      description: 'Strip navigation, headers, and footers, keeping only the main content.',
    },
  },
  additionalProperties: true,
};

export const FIRECRAWL_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'firecrawl',
  version: 2,
  name: 'Firecrawl',
  tagline: 'Scrape, crawl, map, and search the web into clean LLM-ready content.',
  description:
    'Firecrawl API. Scrape a single URL into clean markdown or structured HTML, crawl an ' +
    'entire site and poll the job for results, map a site to its list of URLs, and run a web ' +
    'search that returns scraped page content. Authenticated with an API key sent as a bearer ' +
    'token.',
  tags: ['scraping', 'crawling', 'web', 'llm', 'firecrawl'],
  vendor: 'Firecrawl',
  category: 'developer-tools',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create an API key at firecrawl.dev (starts with "fc-"). It is sent as ' +
    'Authorization: Bearer <token>.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Firecrawl API key',
      setupNote:
        'From firecrawl.dev/app/api-keys (starts with "fc-"). Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'firecrawl',
    name: 'Firecrawl',
    description: 'Firecrawl API — scrape, crawl, map, and search.',
    baseUrl: 'https://api.firecrawl.dev',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['scraping', 'firecrawl'],
    endpoints: [
      {
        endpointId: 'scrape',
        name: 'Scrape URL',
        description:
          'Scrape a single URL and return its content in the requested formats. Synchronous — ' +
          'the response carries the scraped content directly.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/scrape',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The scrape request.',
            schema: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string', description: 'The absolute URL to scrape.' },
                formats: formatsSchema,
                onlyMainContent: {
                  type: 'boolean',
                  description:
                    'Strip navigation, headers, and footers, keeping only the main content.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['scrape'],
      },
      {
        endpointId: 'crawl',
        name: 'Start crawl',
        description:
          'Start an asynchronous crawl of a site starting at a URL. Returns a job id — poll ' +
          'getCrawlStatus with it for the results.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/crawl',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The crawl request.',
            schema: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string', description: 'The absolute URL to start crawling from.' },
                limit: {
                  type: 'integer',
                  description: 'Maximum number of pages to crawl.',
                  minimum: 1,
                },
                scrapeOptions: scrapeOptionsSchema,
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['crawl'],
      },
      {
        endpointId: 'getCrawlStatus',
        name: 'Get crawl status',
        description:
          'Poll a crawl job by id for its status and, once complete, the scraped pages. ' +
          'Cursor-paginated via the "next" url in the response.',
        method: 'GET',
        pathTemplate: '/v1/crawl/{id}',
        params: [crawlIdParam],
        tags: ['crawl'],
      },
      {
        endpointId: 'map',
        name: 'Map site',
        description:
          'Map a site to the list of URLs it contains, without scraping them — a fast way to ' +
          'discover a site’s pages before crawling.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/map',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The map request.',
            schema: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string', description: 'The absolute URL to map.' },
                search: {
                  type: 'string',
                  description: 'Filter the mapped URLs to those matching this term.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['map'],
      },
      {
        endpointId: 'search',
        name: 'Search',
        description:
          'Run a web search and return the matching results, optionally with each result ' +
          'page scraped into content.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/search',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The search request.',
            schema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string', description: 'The search query.' },
                limit: {
                  type: 'integer',
                  description: 'Maximum number of results to return.',
                  minimum: 1,
                },
                scrapeOptions: scrapeOptionsSchema,
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['search'],
      },
    ],
  },
};
