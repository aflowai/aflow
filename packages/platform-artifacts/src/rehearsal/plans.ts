import {
  BundleRehearsalPlanSchema,
  type BundleRehearsalPlan,
  type RehearsalExchangeWindow,
} from '@aflow/schemas';
import { EXCHANGE_CALENDAR_READ, EXCHANGE_CLOCK_READ } from '../skillCatalog/exchangeClock.js';
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
    },
  ],
  universe: [...REHEARSAL_UNIVERSE],
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.35, medium: 0.5, high: 0.65, maxGap: 0.15 },
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

function cycle(
  stepId: string,
  inputs: Record<string, unknown>,
  exchangeWindow: RehearsalExchangeWindow,
  extraRequired: string[] = [],
) {
  return {
    kind: 'run' as const,
    stepId,
    slug: 'daily-trading-cycle',
    skillCatalogId: 'daily-trading-cycle',
    inputs,
    timeoutMinutes: 30,
    requiredTasks: [...CYCLE_REQUIRED_TASKS, ...extraRequired],
    toleratedFailures: [NO_CALENDAR_SOURCE],
    exchangeWindow,
  };
}

/**
 * The exchange clock and calendar the bundle's own tasks read
 * (`EXCHANGE_CLOCK_READ`, `EXCHANGE_CALENDAR_READ`), so the rehearsal decides
 * each window from the source the runs decide their day and slot from.
 */
const ALPACA_EXCHANGE_SOURCE = {
  apiId: EXCHANGE_CLOCK_READ.inputTemplate.apiId,
  clockEndpointId: EXCHANGE_CLOCK_READ.inputTemplate.endpointId,
  calendarEndpointId: EXCHANGE_CALENDAR_READ.inputTemplate.endpointId,
};

/**
 * Each cycle takes its trading day from the clock's date, and proceeds only
 * on a session day. The after_close cycle resolves on the session's close.
 * The reflection reflects on the latest session that has closed, which is the
 * cycles' session only once that session has closed and before the next
 * date begins. The plan therefore needs the close of one session: it starts
 * after the close and ends before midnight exchange time.
 */
export const ALPACA_REHEARSAL_SCHEDULE =
  'Start the rehearsal on a session day of the exchange calendar, after that session closes: 16:00 ET on a full session, 13:00 ET on an early close. Its steps may take five hours in all, so start it by 19:00 ET, and every step starts before midnight ET on the same date.';

/**
 * The cycle's four slots run before the desk and name no desk folder, so no
 * cycle runs the desk or finds an approved set, and no cycle forms a thesis.
 * The desk step then writes the day's set on its own.
 */
export const ALPACA_THESIS_TRADING_REHEARSAL: BundleRehearsalPlan = BundleRehearsalPlanSchema.parse(
  {
    catalogId: 'alpaca-thesis-trading',
    gateFromVersion: 38,
    window: {
      source: ALPACA_EXCHANGE_SOURCE,
      startsIn: 'session_closed',
      schedule: ALPACA_REHEARSAL_SCHEDULE,
    },
    steps: [
      {
        kind: 'campaign_start',
        stepId: 'start-campaign',
        slug: 'daily-trading-cycle',
        config: ALPACA_REHEARSAL_CAMPAIGN,
      },
      cycle('cycle-pre-market', { slot: 'pre_market' }, 'session_day'),
      cycle('cycle-open', { slot: 'open' }, 'session_day'),
      cycle('cycle-intraday', { slot: 'intraday', slotIndex: 1 }, 'session_day'),
      cycle('cycle-after-close', { slot: 'after_close' }, 'session_closed', [
        WRITE_CLOSE_REPORT_TASK_ID,
      ]),
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
        inputs: { bindingId: FOLDER, tradingDay: { $rehearsal: 'tradingDay' } },
        timeoutMinutes: 90,
        requiredTasks: ['read-campaign', 'frame', 'write-desk-record'],
        toleratedFailures: [],
        exchangeWindow: 'session_day',
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
        exchangeWindow: 'session_closed',
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
