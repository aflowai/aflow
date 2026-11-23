/**
 * The Daily Trading Cycle's campaign contract and the per-arm table its
 * record step reports. A campaign tests several named hypotheses side by
 * side, one arm each. Every thesis cites its arm, each arm has its own daily
 * thesis budget, and the boundary rules the window is judged by are fields
 * declared at campaign start, and so are the caps for each market-regime
 * state. Every field is frozen mid-campaign.
 */
import type { SkillCampaignContract } from '@aflow/schemas';
import { CAMPAIGN_REGIME_CAPS_RULE, REGIME_CAPS_FIELD } from './dailyTradingCycleRegime.js';
import { RESOLUTION_OUTCOMES } from './dailyTradingCycleSlots.js';
import { UNIVERSE_COVERAGE_CHECK_REF } from './dailyTradingCycleUniverse.js';

/** Rules between campaign fields, run over the whole config at campaign start. */
const CAMPAIGN_ARMS_RULE = 'trading.campaign-arms';

/**
 * Campaign start moves every thesis doc of an earlier campaign or skill
 * version out of the live ledger, in one pass, and reports each move. The
 * ledger then holds the new campaign's docs alone.
 */
const THESIS_LEDGER_ARCHIVE_MIGRATION = 'trading.archive-thesis-ledger';

const HYPOTHESIS_ID_PATTERN = '^[a-z0-9][a-z0-9-]{1,31}$';
const PROBABILITY = { type: 'number', minimum: 0, maximum: 1 };

/** The longest evaluation window a campaign may declare, in trading days. */
export const WINDOW_TRADING_DAYS_MAX = 60;

export const DAILY_TRADING_CYCLE_CAMPAIGN: SkillCampaignContract = {
  validatorRefs: [CAMPAIGN_ARMS_RULE, CAMPAIGN_REGIME_CAPS_RULE],
  startChecks: [UNIVERSE_COVERAGE_CHECK_REF],
  startMigrations: [THESIS_LEDGER_ARCHIVE_MIGRATION],
  fields: {
    regimeName: {
      schema: {
        type: 'string',
        minLength: 3,
        maxLength: 64,
        pattern: '^[a-z0-9][a-z0-9-]*$',
      },
      identity: true,
      label: 'Regime name',
      description:
        'Short slug naming this strategy regime (e.g. "momentum-breakouts-1"). Identifies the campaign.',
    },
    hypotheses: {
      schema: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          required: ['id', 'name', 'statement', 'thesisBudgetPerDay'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: HYPOTHESIS_ID_PATTERN },
            name: { type: 'string', minLength: 3, maxLength: 80 },
            statement: { type: 'string', minLength: 20, maxLength: 1000 },
            thesisBudgetPerDay: { type: 'integer', minimum: 0, maximum: 10 },
          },
        },
      },
      mutable: false,
      label: 'Hypotheses',
      description:
        'The named, falsifiable hypotheses this campaign tests side by side, one arm each: a kebab-case id, a name, the statement, and the most theses the arm may open in one trading day. Every thesis cites one arm by id. No arm’s budget may exceed the theses/day cap. Frozen for the campaign window.',
    },
    universe: {
      schema: {
        type: 'array',
        items: { type: 'string', pattern: '^[A-Z][A-Z.]{0,9}$' },
        minItems: 1,
        maxItems: 30,
      },
      mutable: false,
      label: 'Universe',
      description:
        'Tickers theses may trade. The decide contract rejects any instrument outside this list. Campaign start reads each member’s IEX daily bars over the last 100 calendar days through the market-data binding, and refuses a member with fewer than the 20 sessions the regime’s breadth needs, naming it.',
    },
    maxThesesPerDay: {
      schema: { type: 'integer', minimum: 0, maximum: 10 },
      mutable: false,
      label: 'Theses per trading day cap',
      description:
        'Maximum new theses per trading day, across all its slots and arms. Theses opened by an earlier slot count against it, and it bounds every arm’s own budget. More theses mean more resolutions and faster loop cycles.',
    },
    maxPositionSizePct: {
      schema: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
      mutable: false,
      label: 'Per-position size cap (%)',
      description: 'Maximum entry size as a percent of account equity, per thesis.',
    },
    maxGrossExposurePct: {
      schema: { type: 'number', exclusiveMinimum: 0, maximum: 200 },
      mutable: false,
      label: 'Gross exposure cap (%)',
      description:
        'Maximum gross exposure (sum of absolute position notionals ÷ equity × 100) after each cycle.',
    },
    regimeCaps: REGIME_CAPS_FIELD,
    minHorizonTradingDays: {
      schema: { type: 'integer', minimum: 1, maximum: 5 },
      mutable: false,
      label: 'Minimum thesis horizon (trading days)',
      description: 'Shortest allowed thesis deadline. Must not exceed the maximum horizon.',
    },
    maxHorizonTradingDays: {
      schema: { type: 'integer', minimum: 1, maximum: 5 },
      mutable: false,
      label: 'Maximum thesis horizon (trading days)',
      description: 'Longest allowed thesis deadline.',
    },
    windowTradingDays: {
      schema: { type: 'integer', minimum: 5, maximum: WINDOW_TRADING_DAYS_MAX },
      mutable: false,
      label: 'Evaluation window (trading days)',
      description:
        'The pre-registered window this regime is evaluated over. Layer-2 outcome metrics (benchmark-relative return, Sharpe, drawdown) are read only at the weekly checkpoint and at the window boundary — never daily.',
    },
    pooledSampleFloor: {
      schema: { type: 'integer', minimum: 1, maximum: 1000 },
      mutable: false,
      label: 'Pooled sample floor',
      description:
        'The fewest resolutions of filled entries (confirmed, falsified, expired or tactical_exit), pooled across every arm, before the boundary reads a verdict. A window below it reads inconclusive. Declared at campaign start and never tuned mid-campaign.',
    },
    expectancyFloorR: {
      schema: { type: 'number', minimum: -10, maximum: 10 },
      mutable: false,
      label: 'Expectancy floor (R)',
      description:
        'The expectancy in R an arm must reach at the boundary to carry into the next campaign. R is one filled thesis’s realized return over its risk at entry, the distance from entry to its falsification level. Expectancy is the mean R over the arm’s filled resolutions.',
    },
    calibrationRule: {
      schema: {
        type: 'object',
        required: ['low', 'medium', 'high', 'maxGap'],
        additionalProperties: false,
        properties: {
          low: PROBABILITY,
          medium: PROBABILITY,
          high: PROBABILITY,
          maxGap: PROBABILITY,
        },
      },
      mutable: false,
      label: 'Calibration rule',
      description:
        'The hit rate each stated confidence claims (low, medium, high, rising) and the largest gap allowed at the boundary between that claim and the confirmed share of its filled criteria resolutions (confirmed, falsified or expired). An entry_failed or tactical_exit resolution is no calibration point.',
    },
  },
};

const COUNT = { type: 'integer', minimum: 0 };

const ARM_ROW_SCHEMA = {
  type: 'object',
  required: ['hypothesisId', 'opened', 'open', 'resolved'],
  additionalProperties: false,
  properties: {
    hypothesisId: { type: 'string' },
    opened: { ...COUNT, description: 'Theses of this arm in the ledger: open plus resolved.' },
    open: { ...COUNT, description: 'Theses of this arm with an open doc and no resolved doc.' },
    resolved: {
      type: 'object',
      required: [...RESOLUTION_OUTCOMES],
      additionalProperties: false,
      properties: Object.fromEntries(RESOLUTION_OUTCOMES.map((outcome) => [outcome, COUNT])),
    },
  },
};

/**
 * One row per campaign arm, counted over the open and resolved thesis docs
 * whose `regimeName` is this campaign's. The record contract pins the arm set
 * to the campaign and a registered validator refuses any row the ledger does
 * not give.
 */
export const ARM_TABLE_SCHEMA = {
  type: ['object', 'null'],
  required: ['regimeName', 'arms'],
  additionalProperties: false,
  description:
    'The per-arm table on after_close, null on every other slot. Count it from the thesis docs after this cycle’s writes. The contract refuses a row the ledger does not give.',
  properties: {
    regimeName: { type: 'string' },
    arms: { type: 'array', items: ARM_ROW_SCHEMA },
  },
};

const isAfterClose = {
  required: ['cycleDoc'],
  properties: { cycleDoc: { required: ['slot'], properties: { slot: { const: 'after_close' } } } },
};

/** The after_close record reports the table, in its output and its snapshot. */
export const RECORD_ARM_TABLE_RULES = [
  {
    if: isAfterClose,
    then: {
      properties: {
        armTable: { type: 'object' },
        snapshotDoc: { properties: { armTable: { type: 'object' } } },
      },
    },
    else: {
      properties: {
        armTable: { type: 'null' },
        snapshotDoc: { properties: { armTable: { type: 'null' } } },
      },
    },
  },
];

const campaignArmIds = 'enum:$.hypotheses[*].id';
const campaignArmCount = 'count:$.hypotheses';

/**
 * The record contract's bindings to the campaign arms. The arm table has one
 * row per hypothesis, each id a campaign id, and the cycle doc's resolved
 * theses cite only those ids. Campaign start archives every doc of an earlier
 * campaign, so a resolved thesis always cites one of them. trading.arm-table
 * refuses, on every slot, a thesis doc without its thesisId, regimeName or
 * hypothesisId, and on after_close any row the ledger does not give.
 */
export const RECORD_ARM_BINDINGS = (
  [
    ['arm-table-regime-pin', 'value:$.regimeName', '$.armTable.regimeName.const'],
    ['arm-table-arm-ids', campaignArmIds, '$.armTable.arms.items.hypothesisId.enum'],
    [
      'cycle-doc-resolved-arm-ids',
      campaignArmIds,
      '$.cycleDoc.thesesResolved.items.hypothesisId.enum',
    ],
    ['arm-table-arm-floor', campaignArmCount, '$.armTable.arms.minItems'],
    ['arm-table-arm-ceiling', campaignArmCount, '$.armTable.arms.maxItems'],
  ] as const
).map(([bindingId, binding, target]) => ({ bindingId, from: '$campaign', binding, target }));
