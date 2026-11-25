/**
 * The Performance Review's period is read by rule from the stored docs, so a
 * window of any length and any number of desk reruns reaches the review whole
 * and no agent output has to carry it.
 */
import { describe, expect, it } from 'vitest';
import { getCampaignReader } from '@aflow/schemas';
import { REVIEW_PERIOD_READER } from '@aflow/platform-artifacts';
import {
  exchangeDayOf,
  pooledSampleOf,
  reviewPeriodOf,
  reviewPeriodPathRanges,
  storedDocsOf,
  TRADING_REVIEW_PERIOD_READER,
  type StoredDoc,
} from '../scheduling/tradingReviewPeriod.js';
import type { ThesisLedgerDoc } from '../scheduling/tradingArmTable.js';

const REGIME = 'momentum-breakouts-1';
const AT = '2026-11-20T21:00:00.000Z';

const doc = (path: string, body: unknown, updatedAt = AT): StoredDoc => ({
  path,
  content: typeof body === 'string' ? body : JSON.stringify(body),
  updatedAt,
});

function resolved(thesisId: string, outcome: string, regimeName = REGIME): ThesisLedgerDoc {
  return {
    path: `/portfolio/theses/resolved/${thesisId}.json`,
    content: JSON.stringify({ thesisId, regimeName, hypothesisId: 'breakout', outcome }),
  };
}

const LEDGER: ThesisLedgerDoc[] = [
  resolved('aapl-1', 'confirmed'),
  resolved('aapl-2', 'falsified'),
  resolved('msft-1', 'expired'),
  resolved('msft-2', 'tactical_exit'),
  // An entry that never filled is no sample point.
  resolved('spy-1', 'entry_failed'),
  // Another campaign's resolution counts for that campaign alone.
  resolved('old-1', 'confirmed', 'momentum-0'),
  {
    path: '/portfolio/theses/open/aapl-3.json',
    content: JSON.stringify({ thesisId: 'aapl-3', regimeName: REGIME, hypothesisId: 'breakout' }),
  },
];

const REQUEST = {
  regimeName: REGIME,
  windowStart: '2026-11-02',
  periodStart: '2026-11-23',
  periodEnd: '2026-11-27',
};

const SLOTS = [
  'pre_market',
  'open',
  ...Array.from({ length: 7 }, (_, i) => `intraday-${String(i + 1)}`),
  'after_close',
];

/** Every weekday from the first day, as many as asked. */
function tradingDays(from: string, count: number): string[] {
  const days: string[] = [];
  const at = new Date(`${from}T12:00:00Z`);
  while (days.length < count) {
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return days;
}

describe('trading.review-period', () => {
  it('is registered as a campaign reader, under the name the Performance Review reads it by', () => {
    expect(TRADING_REVIEW_PERIOD_READER).toBe(REVIEW_PERIOD_READER);
    expect(getCampaignReader(REVIEW_PERIOD_READER)).not.toBeNull();
  });

  it('counts the pooled sample over the ledger: filled resolutions of the campaign alone', () => {
    expect(pooledSampleOf(LEDGER, REGIME)).toBe(4);
    expect(pooledSampleOf(LEDGER, 'momentum-0')).toBe(1);
  });

  it('reads the period’s docs as stored, each with its path, and a field a doc lacks as null', () => {
    const period = reviewPeriodOf(
      [
        ...LEDGER.map((d) => ({ ...d, updatedAt: AT })),
        doc('/portfolio/theses/cycles/2026-11-24-open.json', {
          tradingDay: '2026-11-24',
          slot: 'open',
        }),
        // Outside the period.
        doc('/portfolio/theses/cycles/2026-11-20-open.json', { tradingDay: '2026-11-20' }),
        doc('/portfolio/snapshots/2026-11-03-after_close.json', { equity: 100100, armTable: {} }),
        doc('/portfolio/snapshots/2026-11-24-open.json', { equity: 1 }),
        // Before the window.
        doc('/portfolio/snapshots/2026-10-30-after_close.json', { equity: 99000 }),
        doc('/research/2026-11-24/desk-open.json', { stoppedAt: 'approved' }),
        doc('/research/2026-11-24/desk-runs/open-run-1.json', { deskOutcome: 'set_written' }),
        doc('/research/2026-11-24/desk-runs/open-run-2.json', { deskOutcome: 'review_refused' }),
        doc('/research/2026-11-24/approved-theses.json', {
          tradingDay: '2026-11-24',
          reviewRunId: 'run-1',
          candidates: [],
          lenses: {},
          vetoes: [],
          extra: 'not copied',
        }),
        doc('/research/journal/2026-11-24.md', '# The day'),
        doc(
          '/strategy/reviews/2026-11-16-to-2026-11-20.md',
          '# Last week',
          '2026-11-20T22:00:00.000Z',
        ),
        doc('/portfolio/theses/cycles/2026-11-25-open.json', 'not json'),
      ],
      REQUEST,
    );
    expect(period.pooledN).toBe(4);
    expect(period.regimeName).toBe(REGIME);
    expect(period.cycles).toEqual([
      {
        path: '/portfolio/theses/cycles/2026-11-24-open.json',
        tradingDay: '2026-11-24',
        slot: 'open',
      },
    ]);
    expect(period.snapshots).toEqual([
      {
        path: '/portfolio/snapshots/2026-11-03-after_close.json',
        tradingDay: '2026-11-03',
        equity: 100100,
        benchmarkClose: null,
        grossExposurePct: null,
        brokerGrossExposurePct: null,
        armTable: {},
      },
    ]);
    expect(period.resolvedTheses.map((t) => t['thesisId'])).toEqual([
      'aapl-1',
      'aapl-2',
      'msft-1',
      'msft-2',
      'spy-1',
    ]);
    expect(period.resolvedTheses[0]).toMatchObject({ realizedR: null, outcome: 'confirmed' });
    expect(period.openTheses).toHaveLength(1);
    // Every desk run keeps its own record, and every one is read.
    expect(period.deskRecords.map((r) => r['path'])).toEqual([
      '/research/2026-11-24/desk-open.json',
      '/research/2026-11-24/desk-runs/open-run-1.json',
      '/research/2026-11-24/desk-runs/open-run-2.json',
    ]);
    expect(period.lensReviews).toEqual([
      {
        path: '/research/2026-11-24/approved-theses.json',
        tradingDay: '2026-11-24',
        candidates: [],
        lenses: {},
        vetoes: [],
      },
    ]);
    expect(period.journal).toEqual([
      { path: '/research/journal/2026-11-24.md', tradingDay: '2026-11-24', text: '# The day' },
    ]);
    expect(period.priorReviews).toEqual([
      { path: '/strategy/reviews/2026-11-16-to-2026-11-20.md', text: '# Last week' },
    ]);
    // A doc it could not read is named, never dropped silently.
    expect(period.readNote).toContain('/portfolio/theses/cycles/2026-11-25-open.json');
  });

  it('reads the longest window whole, with desk reruns past one a slot', () => {
    const days = tradingDays('2026-09-01', 60);
    const docs: StoredDoc[] = days.flatMap((day) => [
      ...SLOTS.flatMap((slot) => [
        doc(`/portfolio/theses/cycles/${day}-${slot}.json`, { tradingDay: day, slot }),
        doc(`/research/${day}/desk-${slot}.json`, { slot }),
        ...[1, 2, 3].map((run) =>
          doc(`/research/${day}/desk-runs/${slot}-run-${String(run)}.json`, { run }),
        ),
      ]),
      doc(`/research/${day}/approved-theses.json`, { tradingDay: day, candidates: [], lenses: {} }),
    ]);
    const period = reviewPeriodOf(docs, {
      ...REQUEST,
      windowStart: days[0]!,
      periodStart: days[0]!,
      periodEnd: days[days.length - 1]!,
    });
    expect(period.cycles).toHaveLength(600);
    expect(period.deskRecords).toHaveLength(2400);
    expect(period.lensReviews).toHaveLength(60);
  });

  it('bounds the query to the period’s paths, in byte order', () => {
    const ranges = reviewPeriodPathRanges(REQUEST);
    const read = (path: string) =>
      ranges.some((range) => path >= range.from && path < range.through);
    expect(read('/portfolio/theses/cycles/2026-11-23-pre_market.json')).toBe(true);
    expect(read('/portfolio/theses/cycles/2026-11-27-after_close.json')).toBe(true);
    expect(read('/portfolio/theses/cycles/2026-11-20-after_close.json')).toBe(false);
    expect(read('/portfolio/theses/cycles/2026-11-30-open.json')).toBe(false);
    expect(read('/research/2026-11-27/desk-runs/open-run-9.json')).toBe(true);
    expect(read('/research/2026-11-28/desk-open.json')).toBe(false);
    expect(read('/research/journal/2026-11-24.md')).toBe(true);
    // The window's snapshots reach back to the campaign's first day.
    expect(read('/portfolio/snapshots/2026-11-02-after_close.json')).toBe(true);
    expect(read('/portfolio/snapshots/2026-10-30-after_close.json')).toBe(false);
  });

  it('reads a doc over the inline threshold whole from the payload store', async () => {
    const updatedAt = new Date(AT);
    const big = JSON.stringify({ tradingDay: '2026-11-24', notes: 'x'.repeat(70_000) });
    const store = {
      retrieve: (ref: string) =>
        ref === 'gs://bucket/body/big.json'
          ? Promise.resolve(big)
          : Promise.reject(new Error('gone')),
      retrieveBytes: () => Promise.reject(new Error('binary')),
    };
    const docs = await storedDocsOf(
      [
        { path: '/a.json', inlineContent: '{}', payloadRef: null, updatedAt },
        {
          path: '/b.json',
          inlineContent: null,
          payloadRef: 'gs://bucket/body/big.json',
          updatedAt,
        },
        {
          path: '/c.json',
          inlineContent: null,
          payloadRef: 'gs://bucket/body/lost.json',
          updatedAt,
        },
      ],
      store as never,
    );
    expect(docs.map((d) => d.content)).toEqual(['{}', big, null]);
    const period = reviewPeriodOf(
      [
        { ...docs[1]!, path: '/portfolio/theses/cycles/2026-11-24-open.json' },
        { ...docs[2]!, path: '/portfolio/theses/cycles/2026-11-25-open.json' },
      ],
      REQUEST,
    );
    expect(period.cycles).toHaveLength(1);
    // A body the store could not give is still named.
    expect(period.readNote).toContain('/portfolio/theses/cycles/2026-11-25-open.json');
  });

  it('dates the window from the campaign start in exchange time', () => {
    // 01:30 UTC is the evening before in New York.
    expect(exchangeDayOf('2026-11-03T01:30:00.000Z')).toBe('2026-11-02');
  });

  it('refuses a period it cannot date', async () => {
    const reader = getCampaignReader(TRADING_REVIEW_PERIOD_READER)!;
    const result = await reader({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'daily-trading-cycle',
      config: { regimeName: REGIME },
      startedAt: AT,
      args: { periodStart: '2026-11-27', periodEnd: '2026-11-23' },
      db: null,
      payloadStore: null,
    });
    expect(result.ok).toBe(false);
  });
});
