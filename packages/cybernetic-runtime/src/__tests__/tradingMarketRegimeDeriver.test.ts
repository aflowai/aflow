import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunDeriver, lookupValidator, WorkflowTaskSchema } from '@aflow/schemas';
import { gatherMarketRegime } from '@aflow/platform-artifacts';
import { configureLogging } from '@aflow/observability';
import {
  runRegisteredOutputValidators,
  unregisteredValidatorIssue,
} from '../scheduling/runOutputValidators.js';
import {
  TRADING_CYCLE_CALENDAR_WINDOW_DERIVER,
  TRADING_CYCLE_DAY_DERIVER,
  TRADING_MARKET_REGIME_DERIVER,
  TRADING_REFLECTION_CALENDAR_WINDOW_DERIVER,
  TRADING_REFLECTION_DAY_DERIVER,
} from '../scheduling/tradingMarketRegime.js';
// A registered validator makes the skill check run: an empty registry skips it.
import '../scheduling/tradingCampaignArms.js';

vi.mock('@aflow/platform-artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/platform-artifacts')>()),
  gatherMarketRegime: vi.fn(),
}));

configureLogging({ service: 'test', level: 'silent' });

const ARGS = { tradingDay: '2026-07-14', slot: 'open' };
const GATHERED = {
  tradingDay: '2026-07-14',
  slot: 'open',
  clock: {
    timestamp: '2026-07-14T09:37:00-04:00',
    isOpen: true,
    nextOpen: '2026-07-15T09:30:00-04:00',
    nextClose: '2026-07-14T16:00:00-04:00',
  },
  marketRegime: {
    asOf: '2026-07-13',
    state: 'mixed' as const,
    indexes: {
      SPY: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
      QQQ: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
      IWM: {
        close: 1,
        sma20: 1,
        sma50: 1,
        aboveSma20: false,
        aboveSma50: false,
        realizedVolPct: 0,
      },
    },
    realizedVolPct: 0,
    breadth: { above: 0, total: 1, share: 0 },
  },
  read: { bindingId: 'alpaca-market-data-default' as const, asOf: '2026-07-13', count: 51 },
};

function deriver() {
  const fn = getRunDeriver(TRADING_MARKET_REGIME_DERIVER);
  if (!fn) throw new Error('trading.market-regime is not a registered run deriver');
  return fn;
}

beforeEach(() => {
  vi.mocked(gatherMarketRegime).mockReset();
});

describe('trading.market-regime', () => {
  it('is registered as a run deriver that computes the regime from its arguments', () => {
    vi.mocked(gatherMarketRegime).mockReturnValue({ ok: true, value: GATHERED });
    expect(deriver()(ARGS)).toEqual({ ok: true, value: GATHERED });
    expect(gatherMarketRegime).toHaveBeenCalledWith(ARGS);
  });

  it('passes the refusal through, so gather-regime fails and the cycle decides unavailable', () => {
    const refusal = { ok: false as const, message: 'read-index-bars produced no bars.' };
    vi.mocked(gatherMarketRegime).mockReturnValue(refusal);
    expect(deriver()({})).toEqual(refusal);
  });
});

describe('trading.cycle-day', () => {
  const session = (date: string) => ({ date, open: '09:30', close: '16:00' });
  // 2026-07-11 and 2026-07-12 are a weekend, so the calendar holds no session for them.
  const calendar = {
    start: '2026-07-08',
    end: '2026-07-15',
    sessions: [
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
    ].map(session),
  };
  const day = (timestamp: string, slot?: string, isOpen = false, nextOpen?: string) =>
    getRunDeriver(TRADING_CYCLE_DAY_DERIVER)?.({
      clock: {
        timestamp,
        isOpen,
        nextOpen: nextOpen ?? `${timestamp.slice(0, 10)}T09:30:00-04:00`,
      },
      ...(slot !== undefined ? { slot } : {}),
      calendar: { ...calendar, end: timestamp.slice(0, 10) },
    });

  it('is registered as a run deriver whose window reads the clock date and the week before', () => {
    const fn = getRunDeriver(TRADING_CYCLE_CALENDAR_WINDOW_DERIVER);
    if (!fn) throw new Error('trading.cycle-calendar-window is not a registered run deriver');
    expect(fn({ clock: { timestamp: '2026-07-15T00:30:00-04:00' } })).toEqual({
      ok: true,
      value: { start: '2026-07-08', end: '2026-07-15' },
    });
    expect(fn({ clock: { timestamp: 'yesterday' } })).toMatchObject({
      ok: false,
      message: expect.stringContaining('The cycle reads no day'),
    });
  });

  it('takes the clock date on pre_market, open and intraday', () => {
    expect(getRunDeriver(TRADING_CYCLE_DAY_DERIVER)).toBeDefined();
    expect(day('2026-07-14T08:47:00-04:00', 'pre_market')).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
    expect(day('2026-07-14T10:40:00-04:00', 'intraday', true)).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
    // With no slot named, a closed market whose next open is later today is pre_market.
    expect(day('2026-07-14T08:47:00-04:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
  });

  it('settles an after_close run on the session it closes', () => {
    expect(day('2026-07-14T16:23:00-04:00', 'after_close')).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
    // A delayed or retried after_close run at 00:30 ET the next day still closes the prior session.
    expect(day('2026-07-15T00:30:00-04:00', 'after_close')).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-14' },
    });
    // With no slot named, a closed market whose next open is on a later date is after_close.
    expect(day('2026-07-15T00:30:00-04:00', undefined, false, '2026-07-16T09:30:00-04:00')).toEqual(
      { ok: true, value: { tradingDay: '2026-07-14' } },
    );
    // A weekend closes the session before it.
    expect(day('2026-07-12T17:00:00-04:00', 'after_close')).toEqual({
      ok: true,
      value: { tradingDay: '2026-07-10' },
    });
  });

  it('refuses a clock or calendar that does not parse, and an after_close with no closed session', () => {
    expect(
      getRunDeriver(TRADING_CYCLE_DAY_DERIVER)?.({ clock: { timestamp: 'yesterday' } }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('The exchange clock or calendar does not parse'),
    });
    expect(
      getRunDeriver(TRADING_CYCLE_DAY_DERIVER)?.({
        clock: {
          timestamp: '2026-07-15T00:30:00-04:00',
          isOpen: false,
          nextOpen: '2026-07-15T09:30:00-04:00',
        },
        slot: 'after_close',
        calendar: { start: '2026-07-15', end: '2026-07-15', sessions: [session('2026-07-15')] },
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('has no session to close'),
    });
  });
});

describe('trading.reflection-day', () => {
  const session = (date: string) => ({ date, open: '09:30', close: '16:00' });
  // 2026-11-26 is Thanksgiving, so the calendar holds no session for it.
  const sessions = ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'].map(
    session,
  );
  const derive = (fn: NonNullable<ReturnType<typeof getRunDeriver>>, timestamp: string) =>
    fn({
      clock: { timestamp, isOpen: false },
      calendar: { start: '2026-11-19', end: '2026-11-26', sessions },
    });

  it('is registered as a run deriver that reads the calendar window from the exchange clock', () => {
    const fn = getRunDeriver(TRADING_REFLECTION_CALENDAR_WINDOW_DERIVER);
    if (!fn) throw new Error('trading.reflection-calendar-window is not a registered run deriver');
    expect(fn({ clock: { timestamp: '2026-11-26T16:45:00-05:00' } })).toEqual({
      ok: true,
      value: { start: '2026-11-19', end: '2026-11-26' },
    });
  });

  it('is registered as a run deriver that reads the trading day from the clock and calendar', () => {
    const fn = getRunDeriver(TRADING_REFLECTION_DAY_DERIVER);
    if (!fn) throw new Error('trading.reflection-day is not a registered run deriver');
    expect(derive(fn, '2026-11-25T16:45:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-25' },
    });
    // A late reflection, after midnight, still reads the session that closed.
    expect(derive(fn, '2026-11-26T00:30:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-25' },
    });
    // A market holiday and a weekend read the session that closed last.
    expect(derive(fn, '2026-11-26T16:45:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-25' },
    });
    expect(derive(fn, '2026-11-21T16:45:00-05:00')).toEqual({
      ok: true,
      value: { tradingDay: '2026-11-20' },
    });
    expect(derive(fn, '2026-11-25T15:00:00-05:00')).toMatchObject({
      ok: false,
      message: expect.stringContaining('closes at 16:00'),
    });
  });
});

describe('the trading.market-regime validatorRef a cycle before version 12 names', () => {
  const ctx = {
    tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
    spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
    workflowRunId: 'run-cycle-0714',
    db: {},
  };
  const V11_VALIDATOR_REF = 'trading.market-regime';
  const v11GatherRegime = {
    taskId: 'gather-regime',
    name: 'Gather market regime',
    type: 'agent',
    optional: true,
    goal: 'Gather the market regime from the index and universe reads.',
    outputContract: {
      schema: { type: 'object' },
      validatorRefs: [V11_VALIDATOR_REF],
    },
  };

  it('is no registered validator, so the skill check names it', () => {
    expect(lookupValidator(V11_VALIDATOR_REF)).toBeNull();
    const parsed = WorkflowTaskSchema.safeParse(v11GatherRegime);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join('\n')).toContain(
      '"trading.market-regime" is not a registered validator',
    );
    expect(parsed.error?.issues.map((i) => i.message).join('\n')).toContain(
      'updates that bundle through Store → Update, because a later version may no longer name "trading.market-regime"',
    );
  });

  it('refuses every gathered regime on submit, so the cycle decides unavailable', async () => {
    const issues = await runRegisteredOutputValidators(
      v11GatherRegime.outputContract.validatorRefs,
      { tradingDay: '2026-07-14', slot: 'open', marketRegime: GATHERED.marketRegime },
      ctx,
    );
    expect(issues).toEqual([unregisteredValidatorIssue(V11_VALIDATOR_REF)]);
    expect(gatherMarketRegime).not.toHaveBeenCalled();
  });
});
