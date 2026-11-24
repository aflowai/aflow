/**
 * How execute-orders sizes a short entry, and how it reports an entry that
 * never reached the broker. The account's `fractional_trading` attribute
 * decides the sizing rule: true sizes fractional shares, false sizes whole
 * shares, and an absent attribute sizes whole shares and says the capability
 * was unknown. A failed order names its source, so an order the sizing rule
 * floored to zero never reads as a broker rejection.
 */

export const SHORT_SIZING_RULES = [
  'fractional',
  'whole_share',
  'whole_share_capability_unknown',
] as const;
export type ShortSizingRule = (typeof SHORT_SIZING_RULES)[number];

export const FAILURE_SOURCES = ['sizing_rule', 'broker_rejected', 'not_submitted'] as const;

/** The broker's fractional limits: qty to 9 decimal places, and at least $1 of notional. */
export const FRACTIONAL_QTY_DECIMALS = 9;
export const FRACTIONAL_MIN_NOTIONAL_USD = 1;

// A positive decimal: the lookahead refuses "0" and "0.000".
const FRACTIONAL_QTY_PATTERN = `^(?!0+(\\.0+)?$)[0-9]+(\\.[0-9]{1,${String(FRACTIONAL_QTY_DECIMALS)}})?$`;
const WHOLE_SHARE_QTY_PATTERN = '^[1-9][0-9]*$';

/** The input binding: the attribute as ingest-account read it, null where the account omits it. */
export const FRACTIONAL_TRADING_BINDING = {
  fractionalTrading: {
    kind: 'task_output' as const,
    taskId: 'ingest-account',
    path: 'fractionalTrading',
  },
};

/** The output field, pinned to the ingested attribute. */
export const FRACTIONAL_TRADING_PROPERTY = {
  fractionalTrading: {
    type: ['boolean', 'null'],
    description:
      'The account’s fractional_trading attribute, copied from your input: true, false, or null where the account read omits it. It decides how a short entry is sized, and the contract pins it.',
  },
};

export const FRACTIONAL_TRADING_PIN = {
  bindingId: 'fractional-trading-pin',
  from: 'ingest-account',
  binding: 'value:$.fractionalTrading',
  target: '$.fractionalTrading.const',
};

export const ORDER_SIZING_PROPERTIES = {
  shortSizing: {
    enum: [...SHORT_SIZING_RULES, null],
    description:
      'The rule that sized a short entry this cycle, set on every submitted or failed short entry. fractional = fractionalTrading is true, so qty = notional / price to 9 decimal places. whole_share = fractionalTrading is false, so qty = floor(notional / price). whole_share_capability_unknown = fractionalTrading is null, so the entry sized whole shares without knowing whether the account trades fractional shares. null on a close, on a long entry, and on a short entry that was deferred, expired or settled as a duplicate.',
  },
  failureSource: {
    enum: [...FAILURE_SOURCES, null],
    description:
      'Why a failed order failed, set on every failed order and null on every other. sizing_rule = the sizing rule gave a qty the broker cannot take, such as 0 whole shares or under the $1 fractional minimum, so no order was sent. broker_rejected = the order was sent and the broker refused it: statusCode and the broker’s own message carry it. not_submitted = no order was sent for another reason, and error names it.',
  },
};

const SHORT_ENTRY = { intent: { const: 'open' }, side: { const: 'sell' } };
const SHORT_ENTRY_KEYS = ['intent', 'side', 'disposition'];

function sizedShortEntriesUse(
  flag: boolean | null,
  rule: ShortSizingRule,
  submittedQtyPattern: string,
) {
  return {
    if: { required: ['fractionalTrading'], properties: { fractionalTrading: { const: flag } } },
    then: {
      properties: {
        orderResults: {
          items: {
            allOf: [
              {
                if: {
                  required: SHORT_ENTRY_KEYS,
                  properties: { ...SHORT_ENTRY, disposition: { enum: ['submitted', 'failed'] } },
                },
                then: { properties: { shortSizing: { const: rule } } },
              },
              {
                if: {
                  required: SHORT_ENTRY_KEYS,
                  properties: { ...SHORT_ENTRY, disposition: { const: 'submitted' } },
                },
                then: { properties: { qty: { type: 'string', pattern: submittedQtyPattern } } },
              },
            ],
          },
        },
      },
    },
  };
}

/**
 * The contract's rules: the ingested attribute picks the sizing rule of every
 * sized short entry, and a failed order says whether the broker refused it.
 */
export const ORDER_SIZING_RULES = [
  sizedShortEntriesUse(true, 'fractional', FRACTIONAL_QTY_PATTERN),
  sizedShortEntriesUse(false, 'whole_share', WHOLE_SHARE_QTY_PATTERN),
  sizedShortEntriesUse(null, 'whole_share_capability_unknown', WHOLE_SHARE_QTY_PATTERN),
  {
    properties: {
      orderResults: {
        items: {
          allOf: [
            {
              if: {
                required: SHORT_ENTRY_KEYS,
                not: {
                  properties: { ...SHORT_ENTRY, disposition: { enum: ['submitted', 'failed'] } },
                },
              },
              then: { properties: { shortSizing: { type: 'null' } } },
            },
            {
              if: { required: ['disposition'], properties: { disposition: { const: 'failed' } } },
              then: {
                properties: {
                  failureSource: { enum: [...FAILURE_SOURCES] },
                  error: { type: 'string', minLength: 1 },
                },
              },
              else: { properties: { failureSource: { type: 'null' } } },
            },
            {
              if: {
                required: ['failureSource'],
                properties: { failureSource: { const: 'broker_rejected' } },
              },
              then: { properties: { statusCode: { type: 'integer' } } },
            },
            {
              if: {
                required: ['failureSource'],
                properties: { failureSource: { enum: ['sizing_rule', 'not_submitted'] } },
              },
              then: { properties: { statusCode: { type: 'null' } } },
            },
            {
              if: {
                required: ['failureSource'],
                properties: { failureSource: { const: 'sizing_rule' } },
              },
              then: { properties: SHORT_ENTRY },
            },
          ],
        },
      },
    },
  },
];
