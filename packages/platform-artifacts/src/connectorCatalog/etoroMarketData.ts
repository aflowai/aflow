import type { ConnectorCatalogEntry } from '@aflow/schemas';
import { ETORO_BASE_URL, ETORO_CREDENTIAL_PROMPTS, ETORO_KEY_PAIR_HEADERS } from './etoroShared.js';

export const ETORO_MARKET_DATA_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'etoro-market-data',
  version: 1,
  name: 'eToro Market Data',
  tagline: 'Quotes, candles, instrument reference, and exchange data from eToro.',
  description:
    'Read-only eToro market data. Live rates for up to 100 instruments at a time, candle ' +
    'history at intervals from one minute to one week, instrument and exchange reference ' +
    'data, and instrument search. Carries no trading authority — the order routes live in ' +
    'the separate eToro Trading connector, so a space can read the market without holding ' +
    'the ability to place an order.',
  tags: ['market-data', 'stocks', 'crypto', 'finance', 'etoro'],
  vendor: 'eToro',
  category: 'market-data',
  honestyLabel: 'curated',
  authKind: 'api_key_pair',
  apiKeyPairHeaderNames: ETORO_KEY_PAIR_HEADERS,
  setupNote:
    'Create a key at api-portal.etoro.com → Settings → Trading → API Key Management. The ' +
    'User Key is shown once and cannot be retrieved again. Each key is bound to either the ' +
    'Demo or the Real environment at creation and cannot be switched afterwards. The same ' +
    'pair authenticates all three eToro connectors — enter it once and the others resolve it.',
  credentialPrompts: ETORO_CREDENTIAL_PROMPTS,
  definition: {
    apiId: 'etoro-market-data',
    name: 'eToro Market Data',
    description: 'eToro market data — rates, candles, instrument and exchange reference.',
    baseUrl: ETORO_BASE_URL,
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    requestIdHeader: 'x-request-id',
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['market-data', 'etoro'],
    endpoints: [
      {
        endpointId: 'getInstrumentRates',
        name: 'Get instrument rates',
        description:
          'Live ask/bid rates for up to 100 instruments in one call, addressed by eToro ' +
          'instrument id. Resolve a symbol to an id with searchInstruments first.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/instruments/rates',
        params: [
          {
            name: 'instrumentIds',
            location: 'query',
            required: true,
            description:
              'Comma-separated eToro instrument ids to price (maximum 100 per call). These ' +
              'are eToro-internal numeric ids, not ticker symbols.',
            schema: { type: 'string' },
          },
        ],
        tags: ['rates', 'quotes'],
      },
      {
        endpointId: 'getCandleHistory',
        name: 'Get candle history',
        description:
          'OHLC candles for one instrument at a fixed interval, newest-first or oldest-first.',
        method: 'GET',
        pathTemplate:
          '/api/v1/market-data/instruments/{instrumentId}/history/candles/{direction}/{interval}/{candlesCount}',
        params: [
          {
            name: 'instrumentId',
            location: 'path',
            required: true,
            description: 'eToro instrument id to fetch candles for.',
            schema: { type: 'integer' },
          },
          {
            name: 'direction',
            location: 'path',
            required: true,
            description: 'Sort order: asc is oldest-first, desc is newest-first.',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
          {
            name: 'interval',
            location: 'path',
            required: true,
            description: 'Candle granularity.',
            schema: {
              type: 'string',
              enum: [
                'OneMinute',
                'FiveMinutes',
                'TenMinutes',
                'FifteenMinutes',
                'ThirtyMinutes',
                'OneHour',
                'FourHours',
                'OneDay',
                'OneWeek',
              ],
            },
          },
          {
            name: 'candlesCount',
            location: 'path',
            required: true,
            description: 'Number of candles to return. Maximum 1000.',
            schema: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        ],
        tags: ['candles', 'history'],
      },
      {
        endpointId: 'searchInstruments',
        name: 'Search instruments',
        description:
          'Find instruments and resolve symbols to eToro instrument ids. Filtering works by ' +
          'appending a query parameter named after any Instrument response field — for ' +
          'example displayname=Bitcoin or symbolfull=AAPL. There is no free-text search ' +
          'parameter, and an unrecognised filter field is ignored rather than rejected.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/search',
        params: [
          {
            name: 'fields',
            location: 'query',
            required: true,
            description:
              'Comma-separated Instrument fields to return, e.g. ' +
              '"instrumentid,symbolfull,displayname,instrumenttypeid".',
            schema: { type: 'string' },
          },
          {
            name: 'pageSize',
            location: 'query',
            required: false,
            description: 'Results per page.',
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'pageNumber',
            location: 'query',
            required: false,
            description: 'Page number to retrieve.',
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'sort',
            location: 'query',
            required: false,
            description:
              'Field to sort by, ascending by default. Prefix with "-" for descending. An ' +
              'unsortable or unknown field fails the request rather than being ignored.',
            schema: { type: 'string' },
          },
        ],
        tags: ['search', 'reference'],
      },
      {
        endpointId: 'getInstruments',
        name: 'Get instrument display data',
        description:
          'Reference data for instruments, optionally filtered by instrument, exchange, ' +
          'industry, or instrument type. Unfiltered it returns the full instrument list.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/instruments',
        params: [
          {
            name: 'instrumentIds',
            location: 'query',
            required: false,
            description: 'Comma-separated eToro instrument ids to filter on.',
            schema: { type: 'string' },
          },
          {
            name: 'exchangeIds',
            location: 'query',
            required: false,
            description: 'Comma-separated exchange ids to filter on.',
            schema: { type: 'string' },
          },
          {
            name: 'stocksIndustryIds',
            location: 'query',
            required: false,
            description: 'Comma-separated stock industry ids to filter on.',
            schema: { type: 'string' },
          },
          {
            name: 'instrumentTypeIds',
            location: 'query',
            required: false,
            description: 'Comma-separated instrument type ids to filter on.',
            schema: { type: 'string' },
          },
        ],
        tags: ['reference'],
      },
      {
        endpointId: 'listExchanges',
        name: 'List exchanges',
        description: 'Supported exchanges and their ids.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/exchanges',
        params: [
          {
            name: 'exchangeIds',
            location: 'query',
            required: false,
            description: 'Comma-separated exchange ids to retrieve.',
            schema: { type: 'string' },
          },
        ],
        tags: ['reference'],
      },
      {
        endpointId: 'listInstrumentTypes',
        name: 'List instrument types',
        description: 'Instrument type ids and names — the taxonomy behind instrumentTypeIds.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/instrument-types',
        params: [],
        tags: ['reference'],
      },
      {
        endpointId: 'listStocksIndustries',
        name: 'List stock industries',
        description: 'Stock industry ids and names — the taxonomy behind stocksIndustryIds.',
        method: 'GET',
        pathTemplate: '/api/v1/market-data/stocks-industries',
        params: [],
        tags: ['reference'],
      },
    ],
  },
};
