import { BundleRehearsalPlanSchema, type BundleRehearsalPlan } from '@aflow/schemas';
import { INGEST_CALENDAR_TASK } from '../skillCatalog/dailyTradingCycleGather.js';
import { WRITE_CLOSE_REPORT_TASK_ID } from '../skillCatalog/dailyTradingCycleCloseReport.js';

/**
 * A 30-member universe, the campaign contract's ceiling and the size that
 * exposed the offloaded-read and output-budget defects. Every member is a
 * large listed stock the IEX feed carries every session.
 */
export const REHEARSAL_UNIVERSE = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'TSLA',
  'JPM',
  'V',
  'UNH',
  'XOM',
  'JNJ',
  'PG',
  'MA',
  'HD',
  'COST',
  'ABBV',
  'MRK',
  'PEP',
  'KO',
  'AVGO',
  'LLY',
  'WMT',
  'BAC',
  'CVX',
  'ORCL',
  'CRM',
  'ADBE',
  'NFLX',
  'AMD',
] as const;

/** The campaign the alpaca-thesis-trading rehearsal starts and ends. */
export const ALPACA_REHEARSAL_CAMPAIGN = {
  regimeName: 'go-live-rehearsal',
  hypotheses: [
    {
      id: 'rehearsal-breakout',
      name: 'Volume breakouts',
      statement: 'Closes above the 20-day high on 1.5x volume follow through within 3 sessions.',
      thesisBudgetPerDay: 2,
    },
  ],
  universe: [...REHEARSAL_UNIVERSE],
  maxThesesPerDay: 3,
  maxPositionSizePct: 5,
  maxGrossExposurePct: 30,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
  regimeCaps: {
    risk_off: { maxGrossExposurePct: 15, biases: ['short'] },
    stressed: { maxGrossExposurePct: 10, biases: ['long', 'short', 'neutral'] },
  },
};

const CYCLE_REQUIRED_TASKS = [
  'resolve-theses',
  'read-index-bars',
  'read-universe-bars',
  'gather-regime',
  'decide',
  'execute-orders',
  'record',
  'write-cycle-doc',
];

const NO_CALENDAR_SOURCE = {
  taskId: INGEST_CALENDAR_TASK.taskId,
  reason: 'The bundle ships no calendar source, so the optional calendar read fails by design.',
};

const FOLDER = { $rehearsal: 'folderBindingId' };

function cycle(stepId: string, inputs: Record<string, unknown>, extraRequired: string[] = []) {
  return {
    kind: 'run' as const,
    stepId,
    slug: 'daily-trading-cycle',
    skillCatalogId: 'daily-trading-cycle',
    inputs,
    timeoutMinutes: 30,
    requiredTasks: [...CYCLE_REQUIRED_TASKS, ...extraRequired],
    toleratedFailures: [NO_CALENDAR_SOURCE],
  };
}

/**
 * The cycle's four slots run before the desk, so the desk's early start of
 * the pre_market cycle finds that slot recorded and opens nothing. No
 * approved set exists when the cycles run, so no cycle forms a thesis.
 */
export const ALPACA_THESIS_TRADING_REHEARSAL: BundleRehearsalPlan = BundleRehearsalPlanSchema.parse(
  {
    catalogId: 'alpaca-thesis-trading',
    gateFromVersion: 38,
    steps: [
      {
        kind: 'campaign_start',
        stepId: 'start-campaign',
        slug: 'daily-trading-cycle',
        config: ALPACA_REHEARSAL_CAMPAIGN,
      },
      cycle('cycle-pre-market', { slot: 'pre_market' }),
      cycle('cycle-open', { slot: 'open' }),
      cycle('cycle-intraday', { slot: 'intraday', slotIndex: 1 }),
      cycle('cycle-after-close', { slot: 'after_close' }, [WRITE_CLOSE_REPORT_TASK_ID]),
      {
        kind: 'run',
        stepId: 'desk-charter',
        slug: 'desk-charter',
        skillCatalogId: 'desk-charter',
        inputs: { bindingId: FOLDER },
        timeoutMinutes: 45,
        requiredTasks: ['read-campaign', 'verdict', 'settle'],
        toleratedFailures: [],
      },
      {
        kind: 'run',
        stepId: 'desk-pre-market',
        slug: 'strategy-desk',
        skillCatalogId: 'strategy-desk',
        inputs: { bindingId: FOLDER, tradingDay: { $rehearsal: 'tradingDay' }, slot: 'pre_market' },
        timeoutMinutes: 90,
        requiredTasks: ['read-campaign', 'frame', 'settle-desk', 'write-desk-run-record'],
        toleratedFailures: [],
      },
      {
        kind: 'run',
        stepId: 'trading-reflection',
        slug: 'trading-reflection',
        skillCatalogId: 'trading-reflection',
        inputs: { bindingId: FOLDER },
        timeoutMinutes: 45,
        requiredTasks: ['ingest-clock', 'trading-day', 'write-journal', 'settle'],
        toleratedFailures: [],
      },
    ],
    uncovered: [
      {
        skillCatalogId: 'performance-review',
        reason:
          'Its weekly kind reads a closed week of the campaign’s own cycles, and its boundary kind ends the campaign and starts a successor. A one-day rehearsal campaign has neither.',
      },
      {
        skillCatalogId: 'campaign-successor',
        reason:
          'It drafts from the ledger of a campaign boundary, which a one-day rehearsal campaign does not reach.',
      },
    ],
  },
);

export const BUNDLE_REHEARSAL_PLANS: readonly BundleRehearsalPlan[] = [
  ALPACA_THESIS_TRADING_REHEARSAL,
];

export function getBundleRehearsalPlan(catalogId: string): BundleRehearsalPlan | null {
  return BUNDLE_REHEARSAL_PLANS.find((plan) => plan.catalogId === catalogId) ?? null;
}
