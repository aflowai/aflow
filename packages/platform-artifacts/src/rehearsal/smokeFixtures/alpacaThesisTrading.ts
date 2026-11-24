import { GOAL_HORIZONS, GOAL_LAYERS, PRINCIPLE_KINDS } from '../../skillCatalog/deskCharter.js';
import type {
  BundleSmokeFixtures,
  SmokeSkillFixture,
  SmokeTaskAnswer,
} from '../mockRehearsalClient.js';
import { createMockIntegrations, type MockIntegrations } from './mockIntegrations.js';

/**
 * The smoke fixtures of alpaca-thesis-trading: one session day, read after
 * its close, as its rehearsal plan runs it. Alpaca answers from these reads,
 * every agent and harness from a plausible answer, and no approved set
 * exists, so no cycle opens a thesis and no order is placed. The bundle
 * ships no market-calendar integration, so its read is left unanswered and
 * fails, as the plan tolerates.
 */

const TRADING_DAY = '2026-07-14';
const NEXT_DAY = '2026-07-15';
const AFTER_CLOSE = `${TRADING_DAY}T17:30:00-04:00`;

const output = (value: Record<string, unknown>): SmokeTaskAnswer => ({ output: value });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The weekdays from `start` to `end`, both included. */
function weekdaysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let at = new Date(`${start}T12:00:00Z`); ; at.setUTCDate(at.getUTCDate() + 1)) {
    const day = at.toISOString().slice(0, 10);
    if (day > end) return days;
    if (at.getUTCDay() !== 0 && at.getUTCDay() !== 6) days.push(day);
  }
}

/** Sixty sessions of daily bars ending on the trading day: a steady seeded rise per symbol. */
function dailyBars(symbol: string) {
  let seed = 7;
  for (let i = 0; i < symbol.length; i += 1) seed = (seed * 31 + symbol.charCodeAt(i)) % 997;
  const base = 50 + seed;
  return weekdaysBetween('2026-04-17', TRADING_DAY).map((day, i) => {
    const close = Math.round((base + i * 0.4 + (i % 3) * 0.3) * 100) / 100;
    return {
      t: `${day}T04:00:00Z`,
      o: close - 0.2,
      h: close + 0.5,
      l: close - 0.6,
      c: close,
      v: 1_000_000 + seed * 1_000,
      n: 5_000,
      vw: close,
    };
  });
}

function alpaca(input: Record<string, unknown>): SmokeTaskAnswer | undefined {
  const params = isRecord(input['params']) ? input['params'] : {};
  switch (`${String(input['apiId'])} ${String(input['endpointId'])}`) {
    case 'alpaca-account-read get_clock':
      return output({
        data: {
          timestamp: AFTER_CLOSE,
          is_open: false,
          next_open: `${NEXT_DAY}T09:30:00-04:00`,
          next_close: `${NEXT_DAY}T16:00:00-04:00`,
        },
      });
    case 'alpaca-account-read get_account':
      return output({
        data: { equity: '100000', cash: '100000', buying_power: '200000', status: 'ACTIVE' },
      });
    case 'alpaca-account-read get_positions':
    case 'alpaca-account-read get_orders':
      return output({ data: [] });
    case 'alpaca-account-read get_calendar':
      return output({
        data: weekdaysBetween(String(params['start']), String(params['end'])).map((date) => ({
          date,
          open: '09:30',
          close: '16:00',
          session_open: '0400',
          session_close: '2000',
          settlement_date: date,
        })),
      });
    case 'alpaca-market-data get_v2_stocks_bars': {
      const symbols = String(params['symbols']).split(',');
      return output({
        data: {
          bars: Object.fromEntries(symbols.map((s) => [s, dailyBars(s)])),
          next_page_token: null,
        },
      });
    }
    default:
      return undefined;
  }
}

const slotKey = (slot: unknown, slotIndex: unknown) =>
  slot === 'intraday' ? `intraday-${String(slotIndex)}` : String(slot);

function cycleTask(taskId: string, input: Record<string, unknown>): SmokeTaskAnswer | undefined {
  switch (taskId) {
    case 'resolve-theses': {
      const slot = input['requestedSlot'];
      const afterClose = slot === 'after_close';
      return output({
        tradingDay: TRADING_DAY,
        slot,
        slotIndex: slot === 'intraday' ? input['requestedSlotIndex'] : null,
        proceed: true,
        noopReason: null,
        resolutions: [],
        openThesesAfter: [],
        pendingIntentions: [],
        repairCloses: [],
        orphanFlattens: [],
        maxThesesPerDay: input['maxThesesPerDay'],
        thesesOpenedToday: 0,
        remainingThesesToday: afterClose ? 0 : input['maxThesesPerDay'],
        coverageNote: 'No slot was missed since the last cycle.',
        benchmarkClose: afterClose ? dailyBars('SPY').at(-1)!.c : null,
      });
    }
    case 'decide':
      return output({
        tradingDay: input['tradingDay'],
        regimeName: input['regimeName'] ?? null,
        slot: input['slot'],
        slotIndex: input['slotIndex'] ?? null,
        marketState: input['marketState'],
        bias: null,
        approvedSetFault: null,
        theses: [],
        projectedGrossExposurePct: 0,
        decisionRationale: 'No approved set exists for this slot, so the cycle opens no thesis.',
      });
    case 'execute-orders':
      return output({ orderResults: [], submittedCount: 0, deferredCount: 0, failedCount: 0 });
    case 'record': {
      const key = slotKey(input['slot'], input['slotIndex']);
      return output({
        cycleDoc: {
          tradingDay: input['tradingDay'],
          slot: input['slot'],
          slotIndex: input['slotIndex'] ?? null,
          coverageNote: input['coverageNote'],
          thesesOpened: [],
          openedApprovals: [],
          approvedSetFault: null,
          thesesResolved: [],
          submittedCount: 0,
          deferredCount: 0,
          failedCount: 0,
          projectedGrossExposurePct: 0,
          decisionRationale: input['decisionRationale'],
        },
        snapshotDoc: {
          equity: 100000,
          cash: 100000,
          positions: [],
          brokerGrossExposurePct: 0,
          grossExposurePct: 0,
          orphanFlattens: [],
          armTable: null,
          benchmarkClose: null,
        },
        cycleDocPath: `/portfolio/theses/cycles/${String(input['tradingDay'])}-${key}.json`,
        snapshotDocPath: `/portfolio/snapshots/${String(input['tradingDay'])}-${key}.json`,
      });
    }
    case 'read-day-resolutions':
      return output({ tradingDay: input['tradingDay'], resolutions: [], thesesOpened: [] });
    case 'reflect':
      return output({
        tradingDay: input['tradingDay'],
        slot: 'after_close',
        reasons: [],
        candidateChanges: [],
      });
    default:
      return undefined;
  }
}

const harnessResult = (result: Record<string, unknown>) =>
  output({ result, harness: { id: 'smoke' } });

function charterTask(taskId: string): SmokeTaskAnswer | undefined {
  switch (taskId) {
    case 'draft':
      return harnessResult({
        goals: {
          markdown: '# Goals\n\nBeat SPY buy-and-hold over the window.',
          thresholds: GOAL_LAYERS.flatMap((layer) =>
            GOAL_HORIZONS.map((horizon) => ({
              id: `${layer}-${horizon}`,
              layer,
              horizon,
              metric: layer === 'layer1' ? 'cycle reliability' : 'excess return over SPY',
              comparator: '>=',
              value: layer === 'layer1' ? 0.95 : 0,
              statement: `The ${layer} bar per ${horizon}.`,
            })),
          ),
        },
        principles: {
          markdown: '# Principles\n\nNever average into a falsified thesis.',
          rules: PRINCIPLE_KINDS.map((kind) => ({
            id: kind.replace(/_/g, '-'),
            kind,
            rule: `The ${kind} rule.`,
          })),
        },
        rationale: 'From the plan doc and the campaign contract.',
      });
    case 'review':
      return harnessResult({
        verdict: 'approved',
        findings: [],
        reason: 'Both drafts hold the campaign’s rules.',
      });
    default:
      return undefined;
  }
}

function deskTask(taskId: string, input: Record<string, unknown>): SmokeTaskAnswer | undefined {
  if (taskId !== 'review-run') return undefined;
  const inputs = isRecord(input['inputs']) ? input['inputs'] : {};
  return output({
    outcome: 'completed',
    runId: '00000000-0000-4000-8000-000000002000',
    result: {
      output: {
        deskOutcome: 'no_cycle',
        stoppedAt: 'The review approved no candidate.',
        approvedSetPath: null,
        frameReason: `The review framed ${String(inputs['slot'])} on ${String(inputs['tradingDay'])}.`,
      },
    },
  });
}

function reflectionTask(
  taskId: string,
  input: Record<string, unknown>,
): SmokeTaskAnswer | undefined {
  switch (taskId) {
    case 'read-day':
      return output({
        cycles: [
          {
            path: `/portfolio/theses/cycles/${String(input['tradingDay'])}-after_close.json`,
            slot: 'after_close',
          },
        ],
        deskRecords: [],
        deskRuns: [],
        lensReviews: [],
        resolutions: [],
        snapshot: null,
        journal: [],
        readNote: 'Read the day: four cycles, no thesis opened.',
      });
    case 'analyst':
      return harnessResult({
        tradingDay: TRADING_DAY,
        headline: 'No approved set, so the day opened nothing.',
        entry: `# ${TRADING_DAY}\n\nEvery slot ran, and no thesis opened.`,
        followUps: [],
      });
    default:
      return undefined;
  }
}

function skill(
  integrations: MockIntegrations,
  answer: (taskId: string, input: Record<string, unknown>) => SmokeTaskAnswer | undefined,
): SmokeSkillFixture {
  return (task, input, context) =>
    integrations.answer(task, input, context) ??
    (task.operation === 'api.http.call' ? alpaca(input) : answer(task.taskId, input));
}

export function createAlpacaThesisTradingSmokeFixtures(): BundleSmokeFixtures {
  const integrations = createMockIntegrations();
  return {
    catalogId: 'alpaca-thesis-trading',
    exchange: {
      timestamp: AFTER_CLOSE,
      isOpen: false,
      sessions: weekdaysBetween(TRADING_DAY, '2026-07-28').map((date) => ({
        date,
        open: '09:30',
        close: '16:00',
      })),
    },
    parameters: { folderBindingId: 'smoke-folder' },
    skills: {
      'daily-trading-cycle': skill(integrations, cycleTask),
      'desk-charter': skill(integrations, charterTask),
      'strategy-desk': skill(integrations, deskTask),
      'trading-reflection': skill(integrations, reflectionTask),
    },
  };
}
