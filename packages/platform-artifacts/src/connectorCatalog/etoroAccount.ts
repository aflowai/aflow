import type { ConnectorCatalogEntry } from '@aflow/schemas';
import { ETORO_BASE_URL, ETORO_CREDENTIAL_PROMPTS, ETORO_KEY_PAIR_HEADERS } from './etoroShared.js';

export const ETORO_ACCOUNT_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'etoro-account',
  version: 1,
  name: 'eToro Account',
  tagline: 'Portfolio, positions, balances, P&L, and trade history for the connected account.',
  description:
    'Read-only view of the connected eToro account: aggregate portfolio, per-instrument ' +
    'breakdown with positions and open orders, balances across every account type, realised ' +
    'and unrealised P&L, and trade history. Carries no trading authority — a space can hold ' +
    'this connector to report on the account without being able to move it.',
  tags: ['portfolio', 'balances', 'finance', 'etoro'],
  vendor: 'eToro',
  category: 'finance',
  honestyLabel: 'curated',
  authKind: 'api_key_pair',
  apiKeyPairHeaderNames: ETORO_KEY_PAIR_HEADERS,
  setupNote:
    'Uses the same eToro key pair as the other eToro connectors — enter it once and this ' +
    'one resolves it. The key is bound to either the Demo or the Real environment at ' +
    'creation, and the account this connector reports on is whichever the key belongs to.',
  credentialPrompts: ETORO_CREDENTIAL_PROMPTS,
  definition: {
    apiId: 'etoro-account',
    name: 'eToro Account',
    description: 'eToro account state — portfolio, positions, balances, P&L, trade history.',
    baseUrl: ETORO_BASE_URL,
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    requestIdHeader: 'x-request-id',
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['portfolio', 'etoro'],
    endpoints: [
      {
        endpointId: 'getAggregatePortfolio',
        name: 'Get aggregate portfolio',
        description:
          'Portfolio snapshot rolled up per instrument — invested, value, units, and open ' +
          'position count. One snapshot, so the figures are mutually consistent.',
        method: 'GET',
        pathTemplate: '/api/v1/trading/info/aggregate-portfolio',
        params: [
          {
            name: 'conversionMode',
            location: 'query',
            required: false,
            description:
              'Rate used to convert non-USD assets while the market is closed. Realtime uses ' +
              'live FX; eToroApp matches what the eToro app displays.',
            schema: { type: 'string', enum: ['eToroApp', 'Realtime'] },
          },
          {
            name: 'instrumentIds',
            location: 'query',
            required: false,
            description: 'Comma-separated eToro instrument ids to scope the response to.',
            schema: { type: 'string' },
          },
          {
            name: 'mirrorIds',
            location: 'query',
            required: false,
            description: 'Comma-separated mirror ids to scope copy-trading data to.',
            schema: { type: 'string' },
          },
        ],
        tags: ['portfolio'],
      },
      {
        endpointId: 'getPortfolioBreakdown',
        name: 'Get portfolio breakdown',
        description: 'Full portfolio breakdown — positions, orders, and copied traders.',
        method: 'GET',
        pathTemplate: '/api/v1/trading/info/portfolio',
        params: [],
        tags: ['portfolio', 'positions'],
      },
      {
        endpointId: 'getInstrumentBreakdown',
        name: 'Get instrument breakdown',
        description:
          'Per-instrument breakdown with configurable position, order, and mirror detail. ' +
          'Requires the account CID header, which getUserProfile returns.',
        method: 'GET',
        pathTemplate: '/api/v2/trading/info/instrument-breakdown',
        params: [
          {
            name: 'CID',
            location: 'header',
            required: true,
            description:
              'Client identifier for the account. Read it from getUserProfile — this is the ' +
              'only endpoint here that requires it.',
            schema: { type: 'integer' },
          },
          {
            name: 'conversionMode',
            location: 'query',
            required: false,
            description: 'Conversion for non-USD assets while the market is closed.',
            schema: { type: 'string', enum: ['eToroApp', 'Realtime'] },
          },
          {
            name: 'positionLevel',
            location: 'query',
            required: false,
            description: 'How much position data to return.',
            schema: { type: 'string', enum: ['None', 'Normal'] },
          },
          {
            name: 'orderLevel',
            location: 'query',
            required: false,
            description: 'How much order data to return.',
            schema: { type: 'string', enum: ['None', 'Normal'] },
          },
          {
            name: 'mirrorLevel',
            location: 'query',
            required: false,
            description: 'How much copy-trading data to return.',
            schema: { type: 'string', enum: ['None', 'Details'] },
          },
          {
            name: 'instrumentIds',
            location: 'query',
            required: false,
            description: 'Comma-separated instrument ids to filter on (maximum 100).',
            schema: { type: 'string' },
          },
          {
            name: 'mirrorIds',
            location: 'query',
            required: false,
            description:
              'Comma-separated mirror ids to filter on (maximum 100). Mirror id 0 is the ' +
              'manually traded part of the portfolio.',
            schema: { type: 'string' },
          },
        ],
        tags: ['portfolio', 'positions'],
      },
      {
        endpointId: 'getAccountPnl',
        name: 'Get account P&L',
        description: 'Account-level profit and loss alongside portfolio details.',
        method: 'GET',
        pathTemplate: '/api/v1/trading/info/real/pnl',
        params: [],
        tags: ['pnl'],
      },
      {
        endpointId: 'listTradeHistory',
        name: 'List trade history',
        description: 'Closed trades from a start date onward, paginated.',
        method: 'GET',
        pathTemplate: '/api/v1/trading/info/trade/history',
        params: [
          {
            name: 'minDate',
            location: 'query',
            required: true,
            description: 'Start of the period to return, as a date (YYYY-MM-DD).',
            schema: { type: 'string' },
          },
          {
            name: 'page',
            location: 'query',
            required: false,
            description: 'Page number.',
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'pageSize',
            location: 'query',
            required: false,
            description: 'Trades per page.',
            schema: { type: 'integer', minimum: 1 },
          },
        ],
        tags: ['history'],
      },
      {
        endpointId: 'getBalances',
        name: 'Get balances',
        description:
          'Balances across every account type — Trading, Cash, Options, Crypto, MoneyFarm, ' +
          'Spaceship. Amounts are in each account native currency regardless of ' +
          'displayCurrency, and the field naming the spendable amount differs by account ' +
          'type, so read the response equityDetails rather than assuming one field.',
        method: 'GET',
        pathTemplate: '/api/v1/balances',
        params: [
          {
            name: 'accountTypes',
            location: 'query',
            required: false,
            description:
              'Comma-separated account types to include: Trading, Cash, Options, Crypto, ' +
              'MoneyFarm, Spaceship. Defaults to all.',
            schema: { type: 'string' },
          },
          {
            name: 'displayCurrency',
            location: 'query',
            required: false,
            description: 'ISO 4217 code for totals and conversions. Defaults to USD.',
            schema: { type: 'string' },
          },
          {
            name: 'includeZeroBalances',
            location: 'query',
            required: false,
            description: 'Include accounts with a zero balance. Defaults to false.',
            schema: { type: 'boolean' },
          },
          {
            name: 'includeSubAccounts',
            location: 'query',
            required: false,
            description: 'Include sub-account Trading balances.',
            schema: { type: 'boolean' },
          },
          {
            name: 'expand',
            location: 'query',
            required: false,
            description:
              'Comma-separated optional sections to include. equityDetails carries the ' +
              'spendable amounts.',
            schema: { type: 'string' },
          },
        ],
        tags: ['balances'],
      },
      {
        endpointId: 'getUserProfile',
        name: 'Get user profile',
        description:
          'Profile and account summary, including the CID that getInstrumentBreakdown needs. ' +
          'Called with no parameters it returns the connected account.',
        method: 'GET',
        pathTemplate: '/api/v1/user-info/people',
        params: [
          {
            name: 'usernames',
            location: 'query',
            required: false,
            description: 'Comma-separated usernames to look up.',
            schema: { type: 'string' },
          },
          {
            name: 'cidList',
            location: 'query',
            required: false,
            description: 'Comma-separated customer ids to look up.',
            schema: { type: 'string' },
          },
        ],
        tags: ['profile'],
      },
    ],
  },
};
