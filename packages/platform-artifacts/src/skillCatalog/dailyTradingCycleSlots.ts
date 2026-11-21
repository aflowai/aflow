/**
 * The slots of one trading day and what a cycle in each may do. The rules are
 * JSON Schema conditionals keyed on the `slot` each task's output carries,
 * which resolve-theses decides and every later task pins as a const — so an
 * action a slot does not allow is a validation error, never a prompt rule.
 */

export const CYCLE_SLOTS = ['pre_market', 'open', 'intraday', 'after_close'] as const;
export type CycleSlot = (typeof CYCLE_SLOTS)[number];

export const MAX_INTRADAY_SLOT_INDEX = 24;

/**
 * How an intraday cycle with no `slotIndex` numbers itself. The hours count
 * from the 09:30 open, not from the clock hour, so every time in the session
 * has an index of 1 or more. A schedule that passes `slotIndex` counts the
 * same way.
 */
export const INTRADAY_INDEX_RULE =
  'its hour of the session from the 09:30 exchange-local open: 09:30–10:29 is 1, 10:30–11:29 is 2';

export const RESOLUTION_OUTCOMES = [
  'confirmed',
  'falsified',
  'expired',
  'entry_failed',
  'tactical_exit',
] as const;

/** `{slotKey}` in ledger paths and client order ids: the slot, or `intraday-{slotIndex}`. */
export const SLOT_KEY_PATTERN = '(pre_market|open|intraday-[1-9][0-9]?|after_close)';
const DATE_PATTERN = '[0-9]{4}-[0-9]{2}-[0-9]{2}';

export const CYCLE_DOC_PATH_PATTERN = `^/portfolio/theses/cycles/${DATE_PATTERN}-${SLOT_KEY_PATTERN}\\.json$`;
export const SNAPSHOT_DOC_PATH_PATTERN = `^/portfolio/snapshots/${DATE_PATTERN}-${SLOT_KEY_PATTERN}\\.json$`;

export const SLOT_SCHEMA = { enum: [...CYCLE_SLOTS] };

export const SLOT_INDEX_SCHEMA = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: MAX_INTRADAY_SLOT_INDEX,
};

export const SLOT_INDEX_INPUT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_INTRADAY_SLOT_INDEX,
};

export const CYCLE_RUN_INPUTS = [
  {
    id: 'slot',
    required: false,
    description:
      'The slot the schedule fires for: pre_market, open, intraday or after_close. Absent, the cycle derives it from the exchange clock.',
    schema: SLOT_SCHEMA,
  },
  {
    id: 'slotIndex',
    required: false,
    description: `Which intraday firing of the trading day this is: ${INTRADAY_INDEX_RULE}. It keeps several intraday cycles on one day apart. Absent on an intraday run, the cycle derives it the same way from the clock.`,
    schema: SLOT_INDEX_INPUT_SCHEMA,
  },
];

function whenSlot(
  slots: readonly CycleSlot[],
  then: Record<string, unknown>,
): Record<string, unknown> {
  return { if: { required: ['slot'], properties: { slot: { enum: [...slots] } } }, then };
}

/**
 * pre_market sees no price of the coming session, so it resolves only order
 * facts and leaves every close for the open. after_close resolves on the
 * close and opens nothing.
 */
export const RESOLVE_SLOT_RULES = [
  whenSlot(['intraday'], { properties: { slotIndex: { type: 'integer' } } }),
  whenSlot(['pre_market', 'open', 'after_close'], { properties: { slotIndex: { type: 'null' } } }),
  whenSlot(['pre_market'], {
    properties: {
      resolutions: {
        items: {
          properties: { outcome: { const: 'entry_failed' }, closePosition: { const: false } },
        },
      },
      repairCloses: { maxItems: 0 },
      orphanFlattens: { maxItems: 0 },
    },
  }),
  whenSlot(['after_close'], {
    properties: {
      resolutions: {
        items: {
          properties: {
            outcome: { enum: RESOLUTION_OUTCOMES.filter((o) => o !== 'tactical_exit') },
          },
        },
      },
      remainingThesesToday: { const: 0 },
    },
  }),
];

/** pre_market theses wait for their entry condition. after_close forms none. */
export const DECIDE_SLOT_RULES = [
  whenSlot(['pre_market'], {
    properties: {
      theses: {
        items: { properties: { entryCondition: { type: 'string', minLength: 1 } } },
      },
    },
  }),
  whenSlot(['after_close'], { properties: { theses: { maxItems: 0 } } }),
];

/**
 * pre_market submits nothing: every result is an entry written as a deferred
 * intention with its entry condition. after_close settles closes only.
 */
export const EXECUTE_SLOT_RULES = [
  whenSlot(['pre_market'], {
    properties: {
      orderResults: {
        items: {
          properties: {
            intent: { const: 'open' },
            disposition: { const: 'deferred' },
            statusCode: { type: 'null' },
            entryCondition: { type: 'string', minLength: 1 },
          },
        },
      },
      submittedCount: { const: 0 },
    },
  }),
  whenSlot(['after_close'], {
    properties: { orderResults: { items: { properties: { intent: { const: 'close' } } } } },
  }),
];
