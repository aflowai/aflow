/**
 * How execute-orders sizes a short entry, and how it reports an entry that
 * never reached the broker. A short sizes whole shares first. Only where the
 * floor is 0 and the account's `fractional_trading` attribute is true does it
 * send a fractional qty under one share. The attribute says the account
 * trades fractional shares, not that the broker takes a fractional short
 * sale, so a short whole shares can express never changes. An absent
 * attribute sizes whole shares and says the capability was unknown. A failed
 * order names its source, so an order the sizing rule floored to zero never
 * reads as a broker rejection.
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

// A positive decimal under one share: the lookahead refuses "0.000".
const FRACTIONAL_QTY_PATTERN = `^0\\.(?!0+$)[0-9]{1,${String(FRACTIONAL_QTY_DECIMALS)}}$`;
const WHOLE_SHARE_QTY_PATTERN = '^[1-9][0-9]*$';

export const ACCOUNT_CONFIG_TASK_ID = 'ingest-account-config';

/**
 * Alpaca's account read carries no `fractional_trading`. The attribute lives
 * on the account configuration, so a read of the account alone gives null.
 * The read is optional: a stored API definition that predates the endpoint
 * fails it, and the cycle then sizes whole shares with the capability unknown.
 */
export const ACCOUNT_CONFIG_TASK = {
  taskId: ACCOUNT_CONFIG_TASK_ID,
  name: 'Ingest account configuration',
  goal: 'Read whether the account trades fractional shares, from the account configuration. A read that fails leaves the capability unknown: the cycle still runs, sizes short entries in whole shares, and the cycle doc records the failure as accountConfigFault.',
  type: 'operation' as const,
  operation: 'api.http.call',
  retryability: 'safe' as const,
  dependsOn: ['ingest-account'],
  optional: true,
  inputTemplate: {
    apiId: 'alpaca-account-read',
    endpointId: 'get_account_configurations',
    response: { format: 'json' },
  },
  outputProjection: {
    // A configuration that omits the attribute reads null: the capability is unknown.
    fractionalTrading: { path: 'data.fractional_trading', onMissing: 'null' as const },
  },
  outputContract: {
    schema: {
      type: 'object',
      required: ['fractionalTrading'],
      additionalProperties: false,
      properties: { fractionalTrading: { type: ['boolean', 'null'] } },
    },
  },
};

/** Why the configuration read gave nothing, or absent where it succeeded. */
export const ACCOUNT_CONFIG_FAULT_BINDING = {
  kind: 'task_failure' as const,
  taskId: ACCOUNT_CONFIG_TASK_ID,
};

/**
 * The input binding: the attribute as the configuration read gave it, null
 * where it omits it, and absent where the read failed.
 */
export const FRACTIONAL_TRADING_BINDING = {
  fractionalTrading: {
    kind: 'task_output' as const,
    taskId: ACCOUNT_CONFIG_TASK_ID,
    path: 'fractionalTrading',
  },
};

/** The output field, pinned to the ingested attribute. */
export const FRACTIONAL_TRADING_PROPERTY = {
  fractionalTrading: {
    type: ['boolean', 'null'],
    description:
      'The account’s fractional_trading attribute, copied from your input: true, false, or null where the account configuration omits it or your input lacks it. It decides how a short entry is sized only where whole shares size it to 0, and the contract pins it.',
  },
};

export const FRACTIONAL_TRADING_PIN = {
  bindingId: 'fractional-trading-pin',
  from: ACCOUNT_CONFIG_TASK_ID,
  binding: 'value:$.fractionalTrading',
  target: '$.fractionalTrading.const',
  // A failed configuration read pins null, so execution sizes whole shares.
  whenUpstreamFailed: { value: null },
};

export const ORDER_SIZING_PROPERTIES = {
  shortSizing: {
    enum: [...SHORT_SIZING_RULES, null],
    description:
      'The rule that sized a short entry this cycle, set on every submitted or failed short entry. whole_share = qty is floor(notional / price), where that floor is at least 1 or fractionalTrading is false. fractional = the floor is 0 and fractionalTrading is true, so qty is notional / price to 9 decimal places, under one share. It is a last resort, since fractional short sales are unverified on this broker. whole_share_capability_unknown = fractionalTrading is null, so the entry sized whole shares without knowing whether the account trades fractional shares. null on a close, on a long entry, and on a short entry that was deferred, expired or settled as a duplicate.',
  },
  failureSource: {
    enum: [...FAILURE_SOURCES, null],
    description:
      'Why a failed order failed, set on every failed order and null on every other. sizing_rule = the sizing rule gave a qty the broker cannot take, such as 0 whole shares or under the $1 fractional minimum, so no order was sent. broker_rejected = the order was sent and the broker refused it: statusCode and the broker’s own message carry it. not_submitted = no order was sent for another reason, and error names it.',
  },
};

const SHORT_ENTRY = { intent: { const: 'open' }, side: { const: 'sell' } };
const SHORT_ENTRY_KEYS = ['intent', 'side', 'disposition'];

const QTY_PATTERNS: Record<ShortSizingRule, string> = {
  whole_share: WHOLE_SHARE_QTY_PATTERN,
  fractional: FRACTIONAL_QTY_PATTERN,
  whole_share_capability_unknown: WHOLE_SHARE_QTY_PATTERN,
};

/**
 * Under one value of the attribute: the rules a sized short entry may name,
 * the qty each submits, and the rule that owns a sizing_rule failure.
 */
function sizedShortEntriesUse(
  flag: boolean | null,
  rules: readonly ShortSizingRule[],
  sizedToNothingBy: ShortSizingRule,
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
                then: { properties: { shortSizing: { enum: [...rules] } } },
              },
              ...rules.map((rule) => ({
                if: {
                  required: [...SHORT_ENTRY_KEYS, 'shortSizing'],
                  properties: {
                    ...SHORT_ENTRY,
                    disposition: { const: 'submitted' },
                    shortSizing: { const: rule },
                  },
                },
                then: { properties: { qty: { type: 'string', pattern: QTY_PATTERNS[rule] } } },
              })),
              {
                if: {
                  required: ['failureSource'],
                  properties: { failureSource: { const: 'sizing_rule' } },
                },
                then: { properties: { shortSizing: { const: sizedToNothingBy } } },
              },
            ],
          },
        },
      },
    },
  };
}

/**
 * The contract's rules: the ingested attribute picks the sizing rules a short
 * entry may use, and a failed order says whether the broker refused it. A
 * fractional qty is held under one share, so it only sizes a short that whole
 * shares would size to 0.
 */
export const ORDER_SIZING_RULES = [
  sizedShortEntriesUse(true, ['whole_share', 'fractional'], 'fractional'),
  sizedShortEntriesUse(false, ['whole_share'], 'whole_share'),
  sizedShortEntriesUse(null, ['whole_share_capability_unknown'], 'whole_share_capability_unknown'),
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
