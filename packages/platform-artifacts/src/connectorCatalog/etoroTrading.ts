import type { ConnectorCatalogEntry } from '@aflow/schemas';
import { ETORO_BASE_URL, ETORO_CREDENTIAL_PROMPTS, ETORO_KEY_PAIR_HEADERS } from './etoroShared.js';

/**
 * The order body eToro accepts on both the execution route and the two
 * read-semantics what-if routes. Shared so a cost preview cannot drift from
 * the order it is previewing.
 */
const orderBodyProperties = {
  action: {
    type: 'string',
    enum: ['open'],
    description: 'Only open is supported. Closing goes through closePosition.',
  },
  transaction: {
    type: 'string',
    enum: ['buy', 'sellShort'],
    description: 'buy opens long, sellShort opens short. sell and buyToCover are not supported.',
  },
  symbol: {
    type: 'string',
    description: 'Ticker symbol. Mutually exclusive with instrumentId — supply exactly one.',
  },
  instrumentId: {
    type: 'integer',
    description: 'eToro instrument id. Mutually exclusive with symbol — supply exactly one.',
  },
  settlementType: {
    type: 'string',
    enum: ['cfd', 'real', 'realFutures', 'marginTrade'],
    description:
      'Settlement treatment. eToro may report CFD on an unleveraged order, which changes ' +
      'dividend and tax handling — read it back off the order rather than assuming.',
  },
  orderType: {
    type: 'string',
    enum: ['mkt', 'mit'],
    description: 'mkt is a market order; mit is market-if-touched and requires triggerRate.',
  },
  triggerRate: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'Trigger price. Required when orderType is mit.',
  },
  leverage: {
    type: 'integer',
    minimum: 1,
    description: 'Defaults to 1. Anything above 1 requires stopLossRate.',
  },
  amount: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'Cash amount to invest. Mutually exclusive with units and contracts.',
  },
  orderCurrency: { type: 'string', enum: ['usd'], description: 'Only usd is supported.' },
  units: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'Units to buy. Mutually exclusive with amount and contracts.',
  },
  contracts: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'Whole contracts, realFutures only. Mutually exclusive with amount and units.',
  },
  stopLossRate: {
    type: 'number',
    description:
      'Stop-loss price. Required when leverage exceeds 1, when transaction is sellShort, ' +
      'when settlementType is realFutures, or when stopLossType is trailing.',
  },
  takeProfitRate: { type: 'number', minimum: 0, description: 'Take-profit price.' },
  stopLossType: { type: 'string', enum: ['fixed', 'trailing'], description: 'Defaults to fixed.' },
  additionalMargin: { type: 'number', description: 'realFutures only.' },
} as const;

export const ETORO_TRADING_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'etoro-trading',
  version: 1,
  name: 'eToro Trading',
  tagline: 'Place, modify, close, and cancel orders on the connected eToro account.',
  description:
    'Order execution against the connected eToro account: open positions by cash amount or ' +
    'units, market or market-if-touched, close positions in whole or in part, cancel pending ' +
    'orders, and move stop-loss and take-profit on an open position. Cost preview and ' +
    'eligibility checks are read-only despite being POSTs. Every route is treated as though ' +
    'the money is real, because the connector carries whatever authority the installed key ' +
    'carries. Opening a position and widening a stop require operator approval; closing and ' +
    'cancelling an entry sit one tier lower, since an exit that waits on an unanswered ' +
    'approval leaves the position open.',
  tags: ['trading', 'orders', 'brokerage', 'finance', 'etoro'],
  vendor: 'eToro',
  category: 'finance',
  honestyLabel: 'curated',
  authKind: 'api_key_pair',
  apiKeyPairHeaderNames: ETORO_KEY_PAIR_HEADERS,
  setupNote:
    'This connector can move real money. eToro binds a key to either the Demo or the Real ' +
    'environment at creation and the choice cannot be changed afterwards, so the environment ' +
    'is decided by which key is pasted here — nothing in the key reveals which, and the ' +
    'platform cannot tell. Order creation and stop-loss changes are gated behind operator ' +
    'approval by default. Approving one order authorises one order: position sizing and ' +
    'total exposure are the calling strategy responsibility, not the approval gate.',
  credentialPrompts: ETORO_CREDENTIAL_PROMPTS,
  definition: {
    apiId: 'etoro-trading',
    name: 'eToro Trading',
    description: 'eToro order execution — open, close, cancel, modify, and what-if pricing.',
    baseUrl: ETORO_BASE_URL,
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    requestIdHeader: 'x-request-id',
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] },
    tags: ['trading', 'etoro'],
    endpoints: [
      {
        endpointId: 'createOrder',
        name: 'Create an order',
        description:
          'Open a position. A 200 means the order was SUBMITTED, not filled — the response ' +
          'carries orderId and referenceId, and the terminal state is read from lookupOrder. ' +
          'Status 11 (WaitingForMarket) can persist for hours when the market is closed or a ' +
          'trigger has not been reached. Re-submitting a pending order creates a second one.',
        method: 'POST',
        writeRiskTier: 'high',
        pathTemplate: '/api/v2/trading/execution/orders',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The order to open.',
            schema: {
              type: 'object',
              required: ['action', 'transaction'],
              properties: orderBodyProperties,
            },
          },
        ],
        tags: ['orders', 'execution'],
      },
      {
        endpointId: 'cancelOrder',
        name: 'Cancel a pending order',
        description:
          'Cancel an order that has not executed yet. Reduces exposure by preventing an ' +
          'entry, so it is tiered below order creation.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/api/v2/trading/execution/orders/{orderId}',
        params: [
          {
            name: 'orderId',
            location: 'path',
            required: true,
            description: 'Id of the order to cancel.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['orders', 'execution'],
      },
      {
        endpointId: 'closePosition',
        name: 'Close a position',
        description:
          'Close an open position in whole or in part. Omit UnitsToDeduct to close it ' +
          'entirely. Submission returns statusID 1; the fill and proceeds are read from ' +
          'getCloseOrder. Note the PascalCase body field names — this route differs from ' +
          'every other body on this connector.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/api/v1/trading/execution/market-close-orders/positions/{positionId}',
        params: [
          {
            name: 'positionId',
            location: 'path',
            required: true,
            description: 'Id of the position to close.',
            schema: { type: 'integer' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'How much of the position to close.',
            schema: {
              type: 'object',
              required: ['InstrumentId'],
              properties: {
                InstrumentId: {
                  type: 'integer',
                  description: 'eToro instrument id of the position being closed.',
                },
                UnitsToDeduct: {
                  type: 'number',
                  exclusiveMinimum: 0,
                  description: 'Units to close. Omit to close the whole position.',
                },
              },
            },
          },
        ],
        tags: ['orders', 'execution'],
      },
      {
        endpointId: 'cancelCloseOrder',
        name: 'Cancel a pending close order',
        description:
          'Cancel a close order that has not executed yet. This KEEPS the position open, so ' +
          'it increases exposure and is tiered with the risk-taking writes rather than with ' +
          'the other cancel.',
        method: 'DELETE',
        writeRiskTier: 'high',
        pathTemplate: '/api/v1/trading/execution/market-close-orders/{orderId}',
        params: [
          {
            name: 'orderId',
            location: 'path',
            required: true,
            description: 'Id of the pending close order to cancel.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['orders', 'execution'],
      },
      {
        endpointId: 'modifyPosition',
        name: 'Modify stop-loss and take-profit',
        description:
          'Move or clear the stop-loss and take-profit on an open position. Tiered with the ' +
          'risk-taking writes because widening or clearing a stop increases exposure. ' +
          'Returns 202 with an operationId — the change is accepted, not yet applied.',
        method: 'PATCH',
        writeRiskTier: 'high',
        pathTemplate: '/api/v2/trading/positions/{positionId}',
        params: [
          {
            name: 'positionId',
            location: 'path',
            required: true,
            description: 'Id of the open position to modify.',
            schema: { type: 'integer' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The stop-loss and take-profit changes to apply.',
            schema: {
              type: 'object',
              properties: {
                stopLossRate: { type: 'number', description: 'New stop-loss price.' },
                takeProfitRate: { type: 'number', description: 'New take-profit price.' },
                stopLossType: { type: 'string', enum: ['fixed', 'trailing'] },
                clearStopLoss: { type: 'boolean', description: 'Remove the stop-loss entirely.' },
                clearTakeProfit: {
                  type: 'boolean',
                  description: 'Remove the take-profit entirely.',
                },
              },
            },
          },
        ],
        tags: ['positions'],
      },
      {
        endpointId: 'getCosts',
        name: 'Get what-if cost breakdown',
        description:
          'Fee and spread breakdown for a proposed order. A POST that changes nothing — ' +
          'reading it places no order. Treat the figures as an estimate: observed cash ' +
          'movement has differed from the preview.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/api/v2/trading/info/costs',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The proposed order to price. Same shape as createOrder.',
            schema: {
              type: 'object',
              required: ['action', 'transaction'],
              properties: orderBodyProperties,
            },
          },
        ],
        tags: ['costs', 'what-if'],
      },
      {
        endpointId: 'checkEligibility',
        name: 'Check trading eligibility',
        description:
          'Whether the connected account may trade the given instruments, with per-instrument ' +
          'limits: minimum exposure, maximum units, allowed leverages, supported order types, ' +
          'and whether fractional units are permitted. A POST that changes nothing. Does not ' +
          'detect an account-level trading block — that surfaces as error code 623 on ' +
          'placement.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/api/v2/trading/info/eligibility',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description:
              'Instruments to check. Supply instrumentIds, symbols, or both — at least one, ' +
              'and no more than 100 instruments combined.',
            schema: {
              type: 'object',
              properties: {
                instrumentIds: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'eToro instrument ids to check.',
                },
                symbols: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Ticker symbols to check.',
                },
                currency: { type: 'string', enum: ['USD'], description: 'Defaults to USD.' },
              },
            },
          },
        ],
        tags: ['eligibility', 'what-if'],
      },
      {
        endpointId: 'lookupOrder',
        name: 'Look up an order',
        description:
          'Resolve what an order actually did. Look up by the numeric orderId, or by ' +
          'referenceId — the request id sent when the order was submitted. Status 1 is ' +
          'submitted, 3 is filled, 11 is waiting for market.',
        method: 'GET',
        pathTemplate: '/api/v2/trading/info/orders:lookup',
        params: [
          {
            name: 'orderId',
            location: 'query',
            required: false,
            description: 'Numeric order id. Mutually exclusive with referenceId.',
            schema: { type: 'integer' },
          },
          {
            name: 'referenceId',
            location: 'query',
            required: false,
            description:
              'The request id sent when the order was submitted. Mutually exclusive with ' +
              'orderId.',
            schema: { type: 'string' },
          },
        ],
        tags: ['orders', 'status'],
      },
      {
        endpointId: 'getCloseOrder',
        name: 'Get close order result',
        description:
          'Result of a close order, including proceeds and the per-position fill rate. The ' +
          'terminal state appears here as statusID 3 with errorCode 0.',
        method: 'GET',
        pathTemplate: '/api/v1/trading/info/real/close-orders/{orderId}',
        params: [
          {
            name: 'orderId',
            location: 'path',
            required: true,
            description: 'Id of the close order to resolve.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['orders', 'status'],
      },
    ],
  },
};
