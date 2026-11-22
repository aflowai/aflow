import { describe, expect, it, vi } from 'vitest';
import { getCampaignStartCheck } from '@aflow/schemas';
import {
  checkUniverseCoverage,
  TRADING_UNIVERSE_COVERAGE_CHECK_REF,
} from '../scheduling/tradingUniverseCoverage.js';

const NOW = new Date('2026-07-14T14:00:00Z');
const LIVE = { kind: 'live' as const, authorization: 'Basic a2V5OnNlY3JldA==' };

/** `count` weekday bars ending the session before NOW, oldest first. */
function bars(count: number): Array<{ t: string; c: number }> {
  const out: Array<{ t: string; c: number }> = [];
  const day = new Date('2026-07-13T04:00:00Z');
  while (out.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      out.unshift({ t: day.toISOString().replace('.000', ''), c: 100 + out.length });
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return out;
}

function feed(body: unknown, status = 200) {
  return vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

describe('the universe check at campaign start', () => {
  it('is registered under the ref the campaign contract names', () => {
    expect(getCampaignStartCheck(TRADING_UNIVERSE_COVERAGE_CHECK_REF)).not.toBeNull();
  });

  it('reads the bars the cycle reads, through the binding’s credentials', async () => {
    const fetchImpl = feed({ bars: { AAPL: bars(60), MSFT: bars(60) }, next_page_token: null });
    const result = await checkUniverseCoverage(['AAPL', 'MSFT'], {
      access: () => Promise.resolve(LIVE),
      fetchImpl,
      now: () => NOW,
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const query = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      'https://data.alpaca.markets/v2/stocks/bars',
    );
    expect(Object.fromEntries(query)).toMatchObject({
      symbols: 'AAPL,MSFT',
      timeframe: '1Day',
      feed: 'iex',
      adjustment: 'all',
      start: '2026-04-05T14:00:00.000Z',
    });
    expect((init.headers as Record<string, string>)['Authorization']).toBe(LIVE.authorization);
  });

  it('refuses a member with too few sessions, and one the feed does not carry', async () => {
    const result = await checkUniverseCoverage(['AAPL', 'NEWCO', 'ZZZZ'], {
      access: () => Promise.resolve(LIVE),
      fetchImpl: feed({ bars: { AAPL: bars(60), NEWCO: bars(12) }, next_page_token: null }),
      now: () => NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      details: {
        universeGaps: [
          { symbol: 'NEWCO', sessions: 12 },
          { symbol: 'ZZZZ', sessions: 0 },
        ],
      },
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain('NEWCO has 12 sessions');
    expect(result.message).toContain('ZZZZ has no bars');
    expect(result.message).toContain('20 sessions of every member');
  });

  it('does not count a bar of the start day, which may still be forming', async () => {
    const forming = [...bars(19), { t: '2026-07-14T04:00:00Z', c: 120 }];
    const result = await checkUniverseCoverage(['NEWCO'], {
      access: () => Promise.resolve(LIVE),
      fetchImpl: feed({ bars: { NEWCO: forming }, next_page_token: null }),
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, details: { universeGaps: [{ sessions: 19 }] } });
  });

  it('refuses when the binding or the feed cannot be read, saying why', async () => {
    const noBinding = await checkUniverseCoverage(['AAPL'], {
      access: () => Promise.resolve({ kind: 'refused', message: 'the space has no binding.' }),
    });
    expect(noBinding).toEqual({ ok: false, message: 'the space has no binding.' });
    const forbidden = await checkUniverseCoverage(['AAPL'], {
      access: () => Promise.resolve(LIVE),
      fetchImpl: feed({ message: 'forbidden' }, 403),
      now: () => NOW,
    });
    expect(forbidden).toMatchObject({ ok: false });
    if (forbidden.ok) throw new Error('expected a refusal');
    expect(forbidden.message).toContain('answered 403');
  });

  it('passes a simulated binding, which answers the cycle from its simulation', async () => {
    const fetchImpl = feed({});
    const result = await checkUniverseCoverage(['AAPL'], {
      access: () => Promise.resolve({ kind: 'simulated' }),
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
