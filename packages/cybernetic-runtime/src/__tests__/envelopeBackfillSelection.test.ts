/**
 * The pure selection behind the null-envelope backfill (Plan 269 D16):
 * grace-window cut, oldest-first stability, bound, refusal of malformed
 * terminal rows (no completedAt), and the era-boundary partition that keeps
 * first deploy from re-firing the full pipeline over pre-envelope history.
 */
import { describe, expect, it } from 'vitest';
import {
  partitionEnvelopeBackfillCandidates,
  selectEnvelopeBackfillCandidates,
} from '../ledger/queries.js';

const NOW = new Date('2026-08-06T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('selectEnvelopeBackfillCandidates', () => {
  it('keeps only rows terminal for longer than the grace window', () => {
    const rows = [
      { runId: 'old', completedAt: minutesAgo(30) },
      { runId: 'boundary', completedAt: minutesAgo(10) },
      { runId: 'fresh', completedAt: minutesAgo(1) },
    ];
    const selected = selectEnvelopeBackfillCandidates(rows, {
      now: NOW,
      graceMs: 10 * 60_000,
      limit: 10,
    });
    expect(selected.map((r) => r.runId)).toEqual(['old', 'boundary']);
  });

  it('drops rows with no completedAt — malformed, not backfillable', () => {
    const selected = selectEnvelopeBackfillCandidates([{ runId: 'x', completedAt: null }], {
      now: NOW,
      graceMs: 0,
      limit: 10,
    });
    expect(selected).toEqual([]);
  });

  it('bounds the result, keeping input (oldest-first) order', () => {
    const rows = [
      { runId: 'a', completedAt: minutesAgo(50) },
      { runId: 'b', completedAt: minutesAgo(40) },
      { runId: 'c', completedAt: minutesAgo(30) },
    ];
    const selected = selectEnvelopeBackfillCandidates(rows, {
      now: NOW,
      graceMs: 10 * 60_000,
      limit: 2,
    });
    expect(selected.map((r) => r.runId)).toEqual(['a', 'b']);
  });
});

describe('partitionEnvelopeBackfillCandidates', () => {
  it('splits at the era boundary: terminal before it is historical, after it is crash window', () => {
    const eraStart = minutesAgo(60);
    const { historical, crashWindow } = partitionEnvelopeBackfillCandidates(
      [
        { runId: 'ancient', completedAt: minutesAgo(600) },
        { runId: 'pre-era', completedAt: minutesAgo(61) },
        { runId: 'in-era', completedAt: minutesAgo(30) },
      ],
      { envelopeEraStart: eraStart },
    );
    expect(historical.map((r) => r.runId)).toEqual(['ancient', 'pre-era']);
    expect(crashWindow.map((r) => r.runId)).toEqual(['in-era']);
  });

  it('no envelope ever written (null era start) → everything terminal so far is historical', () => {
    const { historical, crashWindow } = partitionEnvelopeBackfillCandidates(
      [
        { runId: 'a', completedAt: minutesAgo(600) },
        { runId: 'b', completedAt: minutesAgo(15) },
      ],
      { envelopeEraStart: null },
    );
    expect(historical.map((r) => r.runId)).toEqual(['a', 'b']);
    expect(crashWindow).toEqual([]);
  });

  it('a run terminal exactly at the boundary belongs to the crash window (full re-fire is the safe side)', () => {
    const boundary = minutesAgo(60);
    const { crashWindow } = partitionEnvelopeBackfillCandidates(
      [{ runId: 'edge', completedAt: boundary }],
      { envelopeEraStart: boundary },
    );
    expect(crashWindow.map((r) => r.runId)).toEqual(['edge']);
  });
});
