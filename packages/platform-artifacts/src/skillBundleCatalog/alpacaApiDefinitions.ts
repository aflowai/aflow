export const ALPACA_PAPER_KEY_ID = 'alpaca-paper-key-id';
export const ALPACA_PAPER_SECRET_KEY = 'alpaca-paper-secret-key';

const ALPACA_FEED_PARAM_DESCRIPTION =
  'iex (free tier) | sip (paid subscription). Omitting feed defaults to sip, which the free ' +
  'tier rejects with 403 on recent data — always pass iex unless a sip subscription is configured.';

export const ALPACA_ACCOUNT_READ_API_DEFINITION = {
  apiId: 'alpaca-account-read',
  definition: {
    name: 'Alpaca Account (read)',
    baseUrl: 'https://paper-api.alpaca.markets/v2',
    authKind: 'basic' as const,
    endpoints: [
      {
        endpointId: 'get_positions',
        path: '/positions',
        method: 'GET' as const,
        summary: 'List all open positions in the paper account.',
      },
      {
        endpointId: 'get_account',
        path: '/account',
        method: 'GET' as const,
        summary: 'Get account status, equity, cash, buying power.',
      },
      {
        endpointId: 'get_orders_order_id',
        path: '/orders/{order_id}',
        method: 'GET' as const,
        summary: "Get a single order's current status (Layer 2 audit polling).",
      },
      {
        endpointId: 'get_orders',
        path: '/orders',
        method: 'GET' as const,
        summary: 'List orders in the paper account, filterable by status.',
        queryParams: [
          { name: 'status', required: false, description: 'open | closed | all (default open).' },
          { name: 'limit', required: false, description: 'Max orders to return (default 50).' },
          { name: 'symbols', required: false, description: 'Comma-separated ticker filter.' },
          { name: 'direction', required: false, description: 'asc | desc by submitted_at.' },
        ],
      },
      {
        endpointId: 'get_clock',
        path: '/clock',
        method: 'GET' as const,
        summary: 'Market clock — current timestamp, is_open, next_open, next_close.',
      },
      {
        endpointId: 'get_account_portfolio_history',
        path: '/account/portfolio/history',
        method: 'GET' as const,
        summary: 'Account equity / profit-loss time series for the paper account.',
        queryParams: [
          { name: 'period', required: false, description: '1D|1W|1M|3M|1A|all (lookback window).' },
          {
            name: 'timeframe',
            required: false,
            description: '1Min|5Min|15Min|1H|1D (resolution).',
          },
          { name: 'date_start', required: false, description: 'ISO date — start of range.' },
          { name: 'date_end', required: false, description: 'ISO date — end of range.' },
          {
            name: 'extended_hours',
            required: false,
            description: 'true|false — include extended-hours equity.',
          },
        ],
      },
      {
        endpointId: 'get_account_activities',
        path: '/account/activities',
        method: 'GET' as const,
        summary: 'Account activity (fills, dividends, etc.) for the paper account.',
        queryParams: [
          {
            name: 'activity_types',
            required: false,
            description: 'Comma-separated types, e.g. FILL.',
          },
          { name: 'date', required: false, description: 'ISO date — single-day filter.' },
          { name: 'until', required: false, description: 'ISO datetime — upper bound.' },
          { name: 'after', required: false, description: 'ISO datetime — lower bound.' },
          { name: 'direction', required: false, description: 'asc | desc.' },
          { name: 'page_size', required: false, description: 'Max activities to return.' },
        ],
      },
    ],
  },
  conflictPolicy: 'skip' as const,
};

export const ALPACA_MARKET_DATA_API_DEFINITION = {
  apiId: 'alpaca-market-data',
  definition: {
    name: 'Alpaca Market Data',
    baseUrl: 'https://data.alpaca.markets',
    authKind: 'basic' as const,
    endpoints: [
      {
        endpointId: 'get_v2_stocks_symbol_snapshot',
        path: '/v2/stocks/{symbol}/snapshot',
        method: 'GET' as const,
        summary: 'Latest snapshot (quote/trade/daily bar) for one symbol. Pass feed=iex.',
        queryParams: [
          {
            name: 'feed',
            required: true,
            description: ALPACA_FEED_PARAM_DESCRIPTION,
          },
        ],
      },
      {
        endpointId: 'get_v2_stocks_snapshots',
        path: '/v2/stocks/snapshots',
        method: 'GET' as const,
        summary:
          'Latest snapshots (quote/trade/daily bar) for many symbols in one call. Pass feed=iex.',
        queryParams: [
          {
            name: 'symbols',
            required: true,
            description: 'Comma-separated tickers (e.g. SPY,QQQ,AGG).',
          },
          { name: 'feed', required: true, description: ALPACA_FEED_PARAM_DESCRIPTION },
        ],
      },
      {
        endpointId: 'get_v2_stocks_symbol_bars',
        path: '/v2/stocks/{symbol}/bars',
        method: 'GET' as const,
        summary: 'Historical bars for one symbol with configurable timeframe. Pass feed=iex.',
        queryParams: [
          {
            name: 'timeframe',
            required: true,
            description: '1Min|5Min|15Min|1Hour|1Day|1Week|1Month',
          },
          { name: 'start', required: false, description: 'ISO datetime — start of range.' },
          { name: 'end', required: false, description: 'ISO datetime — end of range.' },
          { name: 'limit', required: false, description: 'Max bars to return (1-10000).' },
          { name: 'feed', required: true, description: ALPACA_FEED_PARAM_DESCRIPTION },
          { name: 'adjustment', required: false, description: 'raw | split | dividend | all.' },
        ],
      },
      {
        endpointId: 'get_v1beta1_news',
        path: '/v1beta1/news',
        method: 'GET' as const,
        summary: 'Recent news headlines for one or more symbols.',
        queryParams: [
          { name: 'symbols', required: true, description: 'Comma-separated tickers.' },
          { name: 'start', required: false, description: 'ISO datetime — earliest article.' },
          { name: 'end', required: false, description: 'ISO datetime — latest article.' },
          { name: 'limit', required: false, description: 'Max articles (1-50).' },
        ],
      },
    ],
  },
  conflictPolicy: 'skip' as const,
};

export const ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION = {
  apiId: 'alpaca-paper-orders-write',
  definition: {
    name: 'Alpaca Paper Orders (write)',
    baseUrl: 'https://paper-api.alpaca.markets/v2',
    authKind: 'basic' as const,
    endpoints: [
      {
        endpointId: 'post_orders',
        name: 'Submit order',
        path: '/orders',
        method: 'POST' as const,
        summary:
          'Submit one order. The caller supplies the body per order from its validated ' +
          'inputs; client_order_id makes a resubmit idempotent (a duplicate id is rejected, ' +
          'never double-placed).',
        body: {
          contentType: 'application/json' as const,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['symbol', 'side', 'type', 'time_in_force'],
            properties: {
              symbol: { type: 'string', description: 'Ticker symbol, e.g. "AAPL".' },
              qty: {
                type: 'string',
                description: 'Number of shares (string). Supply qty OR notional, not both.',
              },
              notional: {
                type: 'string',
                description:
                  'Dollar amount (string). Supply notional OR qty, not both. Notional orders ' +
                  'are fractional and cannot be sold short — a short sale must use whole-share qty.',
              },
              side: { enum: ['buy', 'sell'], description: 'Order side.' },
              type: {
                enum: ['market', 'limit', 'stop', 'stop_limit'],
                description: 'Order type.',
              },
              time_in_force: { type: 'string', description: 'e.g. "day", "gtc".' },
              limit_price: { type: 'string', description: 'Required for limit / stop_limit.' },
              stop_price: { type: 'string', description: 'Required for stop / stop_limit.' },
              client_order_id: {
                type: 'string',
                description: 'Client-supplied id; makes a resubmit idempotent.',
              },
            },
          },
        },
      },
      {
        endpointId: 'delete_orders_order_id',
        name: 'Cancel order',
        path: '/orders/{order_id}',
        method: 'DELETE' as const,
        summary:
          'Cancel one open (unfilled) order by broker order id. The remediation for a stale ' +
          'own entry blocking an exit on the same symbol (wash-trade guard): cancel the ' +
          'blocking order, then resubmit the exit. Cancelling a filled order is a no-op 4xx.',
      },
    ],
  },
  conflictPolicy: 'skip' as const,
};
