import type { ConnectorCatalogEntry } from '@aflow/schemas';

const limitParam = {
  name: 'limit',
  location: 'query' as const,
  required: false,
  description: 'Number of objects to return per page (1–100, default 10).',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

const startingAfterParam = {
  name: 'starting_after',
  location: 'query' as const,
  required: false,
  description:
    'Cursor for the next page — the id of the last object of the previous page. Omit for the first page.',
  schema: { type: 'string' },
};

const endingBeforeParam = {
  name: 'ending_before',
  location: 'query' as const,
  required: false,
  description:
    'Cursor for the previous page — the id of the first object of the current page. Omit for the first page.',
  schema: { type: 'string' },
};

const customerFilterParam = {
  name: 'customer',
  location: 'query' as const,
  required: false,
  description: 'Return only objects belonging to this customer id (starts with "cus_").',
  schema: { type: 'string' },
};

export const STRIPE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'stripe',
  version: 2,
  name: 'Stripe',
  tagline: 'Read Stripe billing, customers, and payments; create customers and payment links.',
  description:
    'Stripe REST API. Read-heavy: list and read customers, charges, payment intents, invoices, ' +
    'subscriptions, products, and prices, and read the account balance. Two low-risk writes: ' +
    'create a customer and create a payment link. Reads take query filters; writes are ' +
    'form-encoded (application/x-www-form-urlencoded). Authenticated with a secret API key sent ' +
    'as a bearer token.',
  tags: ['payments', 'billing', 'subscriptions', 'finance', 'stripe'],
  vendor: 'Stripe',
  category: 'payments',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Provide a Stripe secret API key (Dashboard → Developers → API keys; starts with "sk_live_" ' +
    'or "sk_test_"). It is sent as Authorization: Bearer <key>. This connector exposes only ' +
    'reads plus createCustomer and createPaymentLink — no charge, refund, payout, or delete ' +
    'endpoints — but a live secret key still grants those on the account, so prefer a ' +
    'restricted key scoped to the resources you need.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Stripe secret key',
      setupNote:
        'From Dashboard → Developers → API keys (starts with "sk_"). Sent as Authorization: Bearer. Prefer a restricted key.',
    },
  ],
  definition: {
    apiId: 'stripe',
    name: 'Stripe',
    description: 'Stripe REST API — customers, charges, payment intents, invoices, billing.',
    baseUrl: 'https://api.stripe.com',
    version: '1',
    callMode: 'endpoint',
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['payments', 'stripe'],
    endpoints: [
      {
        endpointId: 'listCustomers',
        name: 'List customers',
        description:
          'List customers, most recent first. Filter by email to find a specific customer.',
        method: 'GET',
        pathTemplate: '/v1/customers',
        params: [
          {
            name: 'email',
            location: 'query',
            required: false,
            description: 'Return only customers with this exact email address.',
            schema: { type: 'string' },
          },
          limitParam,
          startingAfterParam,
          endingBeforeParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['customers'],
      },
      {
        endpointId: 'getCustomer',
        name: 'Get customer',
        description: 'Fetch a single customer by id, including balance, currency, and metadata.',
        method: 'GET',
        pathTemplate: '/v1/customers/{customer}',
        params: [
          {
            name: 'customer',
            location: 'path',
            required: true,
            description: 'The customer id (starts with "cus_").',
            schema: { type: 'string' },
          },
        ],
        tags: ['customers'],
      },
      {
        endpointId: 'listCharges',
        name: 'List charges',
        description:
          'List charges, most recent first, optionally restricted to one customer. A charge is a ' +
          'single attempt to move money.',
        method: 'GET',
        pathTemplate: '/v1/charges',
        params: [customerFilterParam, limitParam, startingAfterParam, endingBeforeParam],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['charges'],
      },
      {
        endpointId: 'getCharge',
        name: 'Get charge',
        description: 'Fetch a single charge by id, including its amount, status, and outcome.',
        method: 'GET',
        pathTemplate: '/v1/charges/{charge}',
        params: [
          {
            name: 'charge',
            location: 'path',
            required: true,
            description: 'The charge id (starts with "ch_").',
            schema: { type: 'string' },
          },
        ],
        tags: ['charges'],
      },
      {
        endpointId: 'listPaymentIntents',
        name: 'List payment intents',
        description:
          'List payment intents, most recent first, optionally restricted to one customer. A ' +
          'payment intent tracks a payment through its lifecycle (the modern object above charges).',
        method: 'GET',
        pathTemplate: '/v1/payment_intents',
        params: [customerFilterParam, limitParam, startingAfterParam, endingBeforeParam],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['payment-intents'],
      },
      {
        endpointId: 'getPaymentIntent',
        name: 'Get payment intent',
        description: 'Fetch a single payment intent by id, including its status and amount.',
        method: 'GET',
        pathTemplate: '/v1/payment_intents/{payment_intent}',
        params: [
          {
            name: 'payment_intent',
            location: 'path',
            required: true,
            description: 'The payment intent id (starts with "pi_").',
            schema: { type: 'string' },
          },
        ],
        tags: ['payment-intents'],
      },
      {
        endpointId: 'listInvoices',
        name: 'List invoices',
        description:
          'List invoices, most recent first. Filter by customer or by status (draft, open, paid, ' +
          'uncollectible, void).',
        method: 'GET',
        pathTemplate: '/v1/invoices',
        params: [
          customerFilterParam,
          {
            name: 'status',
            location: 'query',
            required: false,
            description: 'Filter by invoice status.',
            schema: {
              type: 'string',
              enum: ['draft', 'open', 'paid', 'uncollectible', 'void'],
            },
          },
          limitParam,
          startingAfterParam,
          endingBeforeParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['invoices'],
      },
      {
        endpointId: 'listSubscriptions',
        name: 'List subscriptions',
        description:
          'List subscriptions, most recent first. Filter by customer or by status (active, ' +
          'past_due, canceled, trialing, …).',
        method: 'GET',
        pathTemplate: '/v1/subscriptions',
        params: [
          customerFilterParam,
          {
            name: 'status',
            location: 'query',
            required: false,
            description:
              'Filter by subscription status (e.g. active, past_due, canceled, trialing; "all" for every status).',
            schema: {
              type: 'string',
              enum: [
                'active',
                'past_due',
                'unpaid',
                'canceled',
                'incomplete',
                'incomplete_expired',
                'trialing',
                'paused',
                'ended',
                'all',
              ],
            },
          },
          limitParam,
          startingAfterParam,
          endingBeforeParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['subscriptions'],
      },
      {
        endpointId: 'getBalance',
        name: 'Get balance',
        description:
          'Fetch the current account balance — available and pending funds per currency.',
        method: 'GET',
        pathTemplate: '/v1/balance',
        params: [],
        tags: ['balance'],
      },
      {
        endpointId: 'listProducts',
        name: 'List products',
        description: 'List products, most recent first. Filter to only active products.',
        method: 'GET',
        pathTemplate: '/v1/products',
        params: [
          {
            name: 'active',
            location: 'query',
            required: false,
            description: 'Return only active (true) or only inactive (false) products.',
            schema: { type: 'boolean' },
          },
          limitParam,
          startingAfterParam,
          endingBeforeParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['products'],
      },
      {
        endpointId: 'listPrices',
        name: 'List prices',
        description:
          'List prices, most recent first. Filter by product or to only active prices. A price id ' +
          '(starts with "price_") is what createPaymentLink references.',
        method: 'GET',
        pathTemplate: '/v1/prices',
        params: [
          {
            name: 'product',
            location: 'query',
            required: false,
            description: 'Return only prices for this product id (starts with "prod_").',
            schema: { type: 'string' },
          },
          {
            name: 'active',
            location: 'query',
            required: false,
            description: 'Return only active (true) or only inactive (false) prices.',
            schema: { type: 'boolean' },
          },
          limitParam,
          startingAfterParam,
          endingBeforeParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'starting_after', limitParam: 'limit' },
        tags: ['prices'],
      },
      {
        endpointId: 'createCustomer',
        name: 'Create customer',
        description:
          'Create a customer. Form-encoded body. Nested params (address, metadata) use bracketed ' +
          'keys, e.g. "metadata[plan]".',
        method: 'POST',
        writeRiskTier: 'high',
        pathTemplate: '/v1/customers',
        bodyEncoding: 'form-urlencoded',
        params: [
          {
            name: 'body',
            location: 'body',
            required: false,
            description: 'The customer fields (form-encoded).',
            schema: {
              type: 'object',
              properties: {
                email: {
                  type: 'string',
                  description: "The customer's email address.",
                },
                name: {
                  type: 'string',
                  description: "The customer's full name or business name.",
                },
                description: {
                  type: 'string',
                  description: 'An arbitrary description shown in the Stripe dashboard.',
                },
                'metadata[key]': {
                  type: 'string',
                  description:
                    'Optional key/value metadata written as bracketed keys — replace "key" with ' +
                    'your own, e.g. "metadata[plan]": "pro". Repeat the pattern for more entries.',
                },
              },
              additionalProperties: true,
            },
          },
        ],
        tags: ['customers'],
      },
      {
        endpointId: 'createPaymentLink',
        name: 'Create payment link',
        description:
          'Create a reusable payment link customers can pay at a Stripe-hosted URL. Form-encoded ' +
          'body. Line items are an ARRAY of nested params written as bracketed, index-numbered ' +
          'keys — "line_items[0][price]" + "line_items[0][quantity]", "line_items[1][price]" + ' +
          '"line_items[1][quantity]", and so on. Resolve each price id (starts with "price_") from ' +
          'listPrices.',
        method: 'POST',
        writeRiskTier: 'high',
        pathTemplate: '/v1/payment_links',
        bodyEncoding: 'form-urlencoded',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The payment link fields (form-encoded).',
            schema: {
              type: 'object',
              required: ['line_items[0][price]', 'line_items[0][quantity]'],
              properties: {
                'line_items[0][price]': {
                  type: 'string',
                  description: 'Price id of the first line item (starts with "price_").',
                },
                'line_items[0][quantity]': {
                  type: 'integer',
                  minimum: 1,
                  description: 'Quantity of the first line item.',
                },
                'line_items[1][price]': {
                  type: 'string',
                  description: 'Price id of a second line item (starts with "price_"), if any.',
                },
                'line_items[1][quantity]': {
                  type: 'integer',
                  minimum: 1,
                  description: 'Quantity of the second line item, if any.',
                },
                'metadata[key]': {
                  type: 'string',
                  description:
                    'Optional key/value metadata written as bracketed keys — replace "key" with ' +
                    'your own. Repeat for more entries.',
                },
              },
              additionalProperties: true,
            },
          },
        ],
        tags: ['payment-links'],
      },
    ],
  },
};
