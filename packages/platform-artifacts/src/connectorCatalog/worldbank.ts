import type { ConnectorCatalogEntry } from '@aflow/schemas';

const formatParam = {
  name: 'format',
  location: 'query' as const,
  required: true,
  description:
    'Response format. Always pass "json" — the API defaults to XML when this is omitted. The ' +
    'JSON body is a two-element array: element 0 is pagination metadata (page, pages, total), ' +
    'element 1 is the row array.',
  schema: { type: 'string', enum: ['json'] },
};

const pageParam = {
  name: 'page',
  location: 'query' as const,
  required: false,
  description: 'Page number to fetch (1-based). Total pages come back in the metadata element.',
  schema: { type: 'integer', minimum: 1 },
};

const perPageParam = {
  name: 'per_page',
  location: 'query' as const,
  required: false,
  description: 'Rows per page (default 50). Raise it to pull a long indicator series in one call.',
  schema: { type: 'integer', minimum: 1, maximum: 20000 },
};

export const WORLD_BANK_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'world-bank',
  version: 1,
  name: 'World Bank Open Data',
  tagline: 'Development indicators, time series, and reference data for every country.',
  description:
    'World Bank Indicators API (v2). Pull a country’s time series for any of the thousands of ' +
    'development indicators (GDP, population, life expectancy, CO₂, and more), browse the ' +
    'indicator catalog, and list countries with their region and income-group metadata. ' +
    'Read-only, keyless, returns JSON when format=json is passed (the API defaults to XML). ' +
    'Country and indicator are addressed by code, not name.',
  tags: ['economics', 'development', 'statistics', 'reference', 'open-data'],
  vendor: 'The World Bank',
  category: 'data',
  honestyLabel: 'curated',
  authKind: 'none',
  setupNote:
    'No credential required — the World Bank Open Data API is keyless and open. Always pass ' +
    'format=json (the API returns XML by default). Address a country by its ISO code (e.g. "US", ' +
    '"DE", or the 3-letter "USA") and an indicator by its code (e.g. "NY.GDP.MKTP.CD").',
  definition: {
    apiId: 'world-bank',
    name: 'World Bank Open Data',
    description:
      'World Bank Indicators API (v2) — country indicator series, indicator catalog, country reference.',
    baseUrl: 'https://api.worldbank.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['economics', 'development'],
    endpoints: [
      {
        endpointId: 'getIndicator',
        name: 'Get country indicator series',
        description:
          'The time series of one indicator for one country — one row per year with the value, ' +
          'newest year first. Narrow the years with the date param.',
        method: 'GET',
        pathTemplate: '/v2/country/{country}/indicator/{indicator}',
        params: [
          {
            name: 'country',
            location: 'path',
            required: true,
            description:
              'Country code — the 2-letter or 3-letter ISO code (e.g. "US" or "USA"). Use "all" ' +
              'for every country, or a semicolon-separated list (e.g. "US;DE;FR").',
            schema: { type: 'string' },
          },
          {
            name: 'indicator',
            location: 'path',
            required: true,
            description:
              'Indicator code (e.g. "NY.GDP.MKTP.CD" for GDP in current US$, "SP.POP.TOTL" for ' +
              'total population). Discover codes via listIndicators.',
            schema: { type: 'string' },
          },
          formatParam,
          {
            name: 'date',
            location: 'query',
            required: false,
            description:
              'Restrict to a year or an inclusive year range, e.g. "2020" or "2000:2020".',
            schema: { type: 'string' },
          },
          pageParam,
          perPageParam,
        ],
        pagination: { style: 'offset', cursorParam: 'page', limitParam: 'per_page' },
        tags: ['indicators', 'series'],
      },
      {
        endpointId: 'listIndicators',
        name: 'List indicators',
        description:
          'Browse the catalog of available indicators — each with its code, name, source, and ' +
          'topic. Paged; use it to find the indicator code getIndicator needs.',
        method: 'GET',
        pathTemplate: '/v2/indicator',
        params: [formatParam, pageParam, perPageParam],
        pagination: { style: 'offset', cursorParam: 'page', limitParam: 'per_page' },
        tags: ['indicators', 'reference'],
      },
      {
        endpointId: 'listCountries',
        name: 'List countries',
        description:
          'List countries and aggregates with their region, income group, lending type, and ' +
          'capital — the reference table for the country codes getIndicator accepts.',
        method: 'GET',
        pathTemplate: '/v2/country',
        params: [formatParam, pageParam, perPageParam],
        pagination: { style: 'offset', cursorParam: 'page', limitParam: 'per_page' },
        tags: ['reference', 'countries'],
      },
    ],
  },
};
