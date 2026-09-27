import type { ConnectorCatalogEntry } from '@aflow/schemas';

const fileTypeParam = {
  name: 'file_type',
  location: 'query' as const,
  required: true,
  description:
    'Response format. Always pass "json" — the API defaults to XML when this is omitted.',
  schema: { type: 'string', enum: ['json'] },
};

const seriesIdParam = {
  name: 'series_id',
  location: 'query' as const,
  required: true,
  description: 'The FRED series id (e.g. "GDP", "UNRATE", "CPIAUCSL"). Case-sensitive.',
  schema: { type: 'string' },
};

const limitParam = {
  name: 'limit',
  location: 'query' as const,
  required: false,
  description: 'Maximum number of results to return.',
  schema: { type: 'integer', minimum: 1, maximum: 100000 },
};

const offsetParam = {
  name: 'offset',
  location: 'query' as const,
  required: false,
  description: 'Zero-based result offset for paging.',
  schema: { type: 'integer', minimum: 0 },
};

export const FRED_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'fred',
  version: 1,
  name: 'FRED',
  tagline: 'Federal Reserve economic data — time series, releases, and categories.',
  description:
    'FRED (Federal Reserve Economic Data) API from the Federal Reserve Bank of St. Louis. Pull ' +
    'the observation history of any economic series (GDP, unemployment, CPI, interest rates, and ' +
    'hundreds of thousands more), look up series metadata, search the catalog by keyword, browse ' +
    'data releases, and read category reference. Read-only. Authenticated with a free FRED API ' +
    'key sent as the api_key query parameter; always returns JSON when file_type=json is passed ' +
    '(the API defaults to XML).',
  tags: ['economics', 'finance', 'time-series', 'reference', 'data'],
  vendor: 'Federal Reserve Bank of St. Louis',
  category: 'market-data',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyQueryParamName: 'api_key',
  setupNote:
    'Create a free account at fredaccount.stlouisfed.org and request an API key ' +
    '(fredaccount.stlouisfed.org/apikeys). It is sent as the api_key query parameter. Always ' +
    'pass file_type=json (the API returns XML by default). Address a series by its id (e.g. ' +
    '"GDP", "UNRATE").',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'FRED API key',
      setupNote:
        'From a St. Louis Fed account at fredaccount.stlouisfed.org/apikeys. Sent as the api_key ' +
        'query parameter.',
    },
  ],
  definition: {
    apiId: 'fred',
    name: 'FRED',
    description:
      'FRED API — economic series observations, series metadata, catalog search, releases, categories.',
    baseUrl: 'https://api.stlouisfed.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['economics', 'time-series'],
    endpoints: [
      {
        endpointId: 'getSeriesObservations',
        name: 'Get series observations',
        description:
          'The observation history (dated values) of one economic series — one row per period, ' +
          'the core time-series read. Narrow with observation_start / observation_end.',
        method: 'GET',
        pathTemplate: '/fred/series/observations',
        params: [
          seriesIdParam,
          fileTypeParam,
          {
            name: 'observation_start',
            location: 'query',
            required: false,
            description: 'Earliest observation date to return, formatted YYYY-MM-DD.',
            schema: { type: 'string' },
          },
          {
            name: 'observation_end',
            location: 'query',
            required: false,
            description: 'Latest observation date to return, formatted YYYY-MM-DD.',
            schema: { type: 'string' },
          },
          {
            name: 'units',
            location: 'query',
            required: false,
            description:
              'Value transformation: lin (levels, default), chg, ch1, pch, pc1, pca, cch, cca, log.',
            schema: {
              type: 'string',
              enum: ['lin', 'chg', 'ch1', 'pch', 'pc1', 'pca', 'cch', 'cca', 'log'],
            },
          },
          {
            name: 'frequency',
            location: 'query',
            required: false,
            description:
              'Aggregate to a lower frequency: d, w, bw, m, q, sa, a (and week-ending variants).',
            schema: { type: 'string' },
          },
          {
            name: 'sort_order',
            location: 'query',
            required: false,
            description: 'Sort observations by date: asc (oldest first, default) or desc.',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
          limitParam,
          offsetParam,
        ],
        tags: ['series', 'observations'],
      },
      {
        endpointId: 'getSeries',
        name: 'Get series metadata',
        description:
          'Reference metadata for one series — its title, units, frequency, seasonal adjustment, ' +
          'and observation range. Use it to confirm a series id before pulling observations.',
        method: 'GET',
        pathTemplate: '/fred/series',
        params: [seriesIdParam, fileTypeParam],
        tags: ['series', 'reference'],
      },
      {
        endpointId: 'searchSeries',
        name: 'Search series',
        description:
          'Search the FRED catalog by keyword and return matching series with their ids and ' +
          'metadata — the way to discover the series id getSeriesObservations needs.',
        method: 'GET',
        pathTemplate: '/fred/series/search',
        params: [
          {
            name: 'search_text',
            location: 'query',
            required: true,
            description: 'The keyword(s) to search series titles and attributes for.',
            schema: { type: 'string' },
          },
          fileTypeParam,
          {
            name: 'search_type',
            location: 'query',
            required: false,
            description: 'Match against full text (full_text, default) or series id (series_id).',
            schema: { type: 'string', enum: ['full_text', 'series_id'] },
          },
          limitParam,
          offsetParam,
        ],
        tags: ['series', 'search'],
      },
      {
        endpointId: 'listReleases',
        name: 'List releases',
        description:
          'Browse the data releases FRED publishes (e.g. Employment Situation, GDP) with their ' +
          'ids, names, and links — reference for grouping series by their source release.',
        method: 'GET',
        pathTemplate: '/fred/releases',
        params: [fileTypeParam, limitParam, offsetParam],
        tags: ['releases', 'reference'],
      },
      {
        endpointId: 'getCategory',
        name: 'Get category',
        description:
          'Reference details for one FRED category by id — its name and parent. Categories ' +
          'organize the series catalog into a browsable tree.',
        method: 'GET',
        pathTemplate: '/fred/category',
        params: [
          {
            name: 'category_id',
            location: 'query',
            required: true,
            description: 'The FRED category id (integer). The root category is 0.',
            schema: { type: 'integer', minimum: 0 },
          },
          fileTypeParam,
        ],
        tags: ['category', 'reference'],
      },
    ],
  },
};
