/**
 * The ONE digest shape. The compose task's `outputContract` embeds this as
 * `properties.digest` and the bundle's seeded card ships it verbatim as
 * `dataSchema` — the render step validates the composed data against the
 * exact schema the producer was held to, so the two surfaces cannot drift.
 */
export const TICKER_DIGEST_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ticker',
    'companyName',
    'asOf',
    'focus',
    'priceSummary',
    'bars',
    'news',
    'watchItems',
    'brief',
  ],
  properties: {
    ticker: { type: 'string', minLength: 1, maxLength: 10 },
    companyName: { type: 'string', minLength: 1, maxLength: 200 },
    asOf: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'The latest completed trading session the digest covers.',
    },
    focus: {
      type: ['string', 'null'],
      maxLength: 300,
      description: 'The run’s focus note echoed back; null when none was given.',
    },
    priceSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['lastClose', 'changePct1d', 'high30d', 'low30d', 'changePct30d', 'avgVolume30d'],
      properties: {
        lastClose: { type: 'number', description: 'Close of the latest fetched session.' },
        changePct1d: {
          type: 'number',
          description: 'Percent change from the prior session’s close to lastClose.',
        },
        high30d: { type: 'number', description: 'Highest high across the fetched window.' },
        low30d: { type: 'number', description: 'Lowest low across the fetched window.' },
        changePct30d: {
          type: 'number',
          description: 'Percent change from the first fetched close to lastClose.',
        },
        avgVolume30d: {
          type: 'number',
          description: 'Mean daily volume across the fetched window, whole shares.',
        },
      },
    },
    bars: {
      type: 'array',
      minItems: 1,
      maxItems: 45,
      description: 'Daily closes for the fetched window, oldest first — the trend strip.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'close'],
        properties: {
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          close: { type: 'number' },
          volume: { type: 'number' },
        },
      },
    },
    news: {
      type: 'array',
      maxItems: 12,
      description:
        'Sourced coverage selected from the fetched feeds — every item carries its real article URL.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'source', 'url', 'publishedAt'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          source: { type: 'string', minLength: 1, maxLength: 128 },
          url: { type: 'string', pattern: '^https://', maxLength: 2048 },
          publishedAt: { type: 'string', minLength: 1, maxLength: 64 },
          note: {
            type: ['string', 'null'],
            maxLength: 300,
            description: 'One sentence on why this item matters; null for plain coverage.',
          },
        },
      },
    },
    watchItems: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      description:
        'Concrete risks and things to watch, each grounded in a fetched number or a cited item.',
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
    brief: {
      type: 'string',
      minLength: 1,
      maxLength: 1500,
      description: 'The prose brief: what the price did, what the news says, what to watch.',
    },
  },
} as const;
