import type { ConnectorCatalogEntry } from '@aflow/schemas';

const tickerParam = {
  name: 'ticker',
  location: 'path' as const,
  required: true,
  description: 'The ticker symbol of the stock or equity (e.g. "AAPL"). Case-sensitive uppercase.',
  schema: { type: 'string' },
};

const adjustedParam = {
  name: 'adjusted',
  location: 'query' as const,
  required: false,
  description: 'Whether results are adjusted for splits (default true).',
  schema: { type: 'boolean' },
};

export const POLYGON_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'polygon',
  version: 2,
  name: 'Polygon.io',
  tagline: 'Stock market data — aggregate bars, quotes, snapshots, ticker reference, and news.',
  description:
    'Polygon.io market data REST API. Fetch aggregate OHLC bars over any time window, daily ' +
    'open/close, previous-day close, real-time snapshots, ticker reference details, market ' +
    'status, and ticker news. Read-only. Authenticated with a Polygon API key sent as the ' +
    'apiKey query parameter.',
  tags: ['market-data', 'stocks', 'finance', 'news'],
  vendor: 'Polygon.io',
  category: 'market-data',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyQueryParamName: 'apiKey',
  setupNote:
    'Provide your Polygon.io API key (dashboard at polygon.io → API Keys). It is sent as the ' +
    'apiKey query parameter. Free-tier keys are rate-limited and serve end-of-day data; ' +
    'paid tiers unlock real-time endpoints.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Polygon API key',
      setupNote: 'From the polygon.io dashboard → API Keys. Sent as the apiKey query parameter.',
    },
  ],
  definition: {
    apiId: 'polygon',
    name: 'Polygon.io',
    description: 'Polygon.io market data REST API — bars, snapshots, ticker reference, news.',
    baseUrl: 'https://api.polygon.io',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['market-data', 'stocks'],
    endpoints: [
      {
        endpointId: 'getAggregates',
        name: 'Get aggregate bars',
        description:
          'OHLC aggregate bars for a ticker over a date range, at a custom resolution ' +
          '(multiplier × timespan, e.g. 1 day or 5 minute bars).',
        method: 'GET',
        pathTemplate: '/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}',
        params: [
          tickerParam,
          {
            name: 'multiplier',
            location: 'path',
            required: true,
            description: 'The size of the timespan multiplier (e.g. 5 with timespan "minute").',
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'timespan',
            location: 'path',
            required: true,
            description: 'The size of the time window for each bar.',
            schema: {
              type: 'string',
              enum: ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'],
            },
          },
          {
            name: 'from',
            location: 'path',
            required: true,
            description: 'Start of the range — a date (YYYY-MM-DD) or millisecond timestamp.',
            schema: { type: 'string' },
          },
          {
            name: 'to',
            location: 'path',
            required: true,
            description: 'End of the range — a date (YYYY-MM-DD) or millisecond timestamp.',
            schema: { type: 'string' },
          },
          adjustedParam,
          {
            name: 'sort',
            location: 'query',
            required: false,
            description: 'Sort bars by timestamp: asc (oldest first) or desc (newest first).',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
          {
            name: 'limit',
            location: 'query',
            required: false,
            description: 'Maximum number of bars to return (default 5000, max 50000).',
            schema: { type: 'integer', minimum: 1, maximum: 50000 },
          },
        ],
        tags: ['bars', 'aggregates'],
      },
      {
        endpointId: 'getDailyOpenClose',
        name: 'Get daily open/close',
        description:
          'The open, close, high, low, and after-hours prices for a ticker on a specific date.',
        method: 'GET',
        pathTemplate: '/v1/open-close/{ticker}/{date}',
        params: [
          tickerParam,
          {
            name: 'date',
            location: 'path',
            required: true,
            description: 'The trading date to fetch, formatted YYYY-MM-DD.',
            schema: { type: 'string' },
          },
          adjustedParam,
        ],
        tags: ['bars', 'daily'],
      },
      {
        endpointId: 'getPreviousClose',
        name: 'Get previous close',
        description: "The previous trading day's OHLC bar for a ticker.",
        method: 'GET',
        pathTemplate: '/v2/aggs/ticker/{ticker}/prev',
        params: [tickerParam, adjustedParam],
        tags: ['bars', 'daily'],
      },
      {
        endpointId: 'getTickerDetails',
        name: 'Get ticker details',
        description:
          'Reference details for a ticker — company name, market, locale, primary exchange, ' +
          'market cap, and description.',
        method: 'GET',
        pathTemplate: '/v3/reference/tickers/{ticker}',
        params: [
          tickerParam,
          {
            name: 'date',
            location: 'query',
            required: false,
            description:
              'Point-in-time date (YYYY-MM-DD) for the ticker details. Defaults to the latest.',
            schema: { type: 'string' },
          },
        ],
        tags: ['reference'],
      },
      {
        endpointId: 'listTickerNews',
        name: 'List ticker news',
        description:
          'Recent news articles across the market or for one ticker, each with source, ' +
          'publisher, and article URL.',
        method: 'GET',
        pathTemplate: '/v2/reference/news',
        params: [
          {
            name: 'ticker',
            location: 'query',
            required: false,
            description: 'Restrict news to articles mentioning this ticker symbol.',
            schema: { type: 'string' },
          },
          {
            name: 'published_utc',
            location: 'query',
            required: false,
            description: 'Return articles published on this UTC date (YYYY-MM-DD).',
            schema: { type: 'string' },
          },
          {
            name: 'order',
            location: 'query',
            required: false,
            description: 'Order articles by published_utc: asc or desc.',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
          {
            name: 'limit',
            location: 'query',
            required: false,
            description: 'Maximum number of articles to return (default 10, max 1000).',
            schema: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        ],
        tags: ['news'],
      },
      {
        endpointId: 'getMarketStatus',
        name: 'Get market status',
        description:
          'Current trading status of US exchanges and overall markets — open, closed, or ' +
          'extended hours.',
        method: 'GET',
        pathTemplate: '/v1/marketstatus/now',
        params: [],
        tags: ['reference', 'status'],
      },
      {
        endpointId: 'getTickerSnapshot',
        name: 'Get ticker snapshot',
        description:
          "A single ticker's current snapshot — the latest trade, quote, minute bar, day bar, " +
          "and today's change.",
        method: 'GET',
        pathTemplate: '/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}',
        params: [tickerParam],
        tags: ['snapshot'],
      },
    ],
  },
};
