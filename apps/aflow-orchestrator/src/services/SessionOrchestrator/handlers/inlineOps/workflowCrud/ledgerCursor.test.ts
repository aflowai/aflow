import { describe, it, expect } from 'vitest';
import type { WorkflowRunSummary } from '@aflow/cybernetic-runtime';
import { buildTrajectory, nextCursorFromRuns, parseLedgerCursor } from './shared.js';

function makeRun(overrides: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return {
    id: 'row-1',
    spaceId: 'space-1',
    workflowSlug: 'kaggle',
    runId: 'run-1',
    sessionId: null,
    status: 'completed',
    workflowRevision: 1,
    startedAt: new Date('2026-06-07T10:00:00.000Z'),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 0,
    resumeAttemptCount: 0,
    learningCount: 0,
    score: null,
    ...overrides,
  };
}

describe('nextCursorFromRuns', () => {
  it('encodes "<ISO>|<runId>" for the oldest row on a full page', () => {
    const runs = [
      makeRun({ runId: 'run-3', startedAt: new Date('2026-06-07T10:02:00.000Z') }),
      makeRun({ runId: 'run-2', startedAt: new Date('2026-06-07T10:01:00.000Z') }),
      makeRun({ runId: 'run-1', startedAt: new Date('2026-06-07T10:00:00.000Z') }),
    ];
    expect(nextCursorFromRuns(runs, 3)).toBe('2026-06-07T10:00:00.000Z|run-1');
  });

  it('returns undefined when the page was not filled (no more rows)', () => {
    const runs = [makeRun({ runId: 'run-1' })];
    expect(nextCursorFromRuns(runs, 5)).toBeUndefined();
  });

  it('returns undefined for a zero limit', () => {
    expect(nextCursorFromRuns([makeRun({})], 0)).toBeUndefined();
  });
});

describe('parseLedgerCursor', () => {
  it('round-trips a composite cursor into { before, beforeRunId }', () => {
    const cursor = nextCursorFromRuns(
      [
        makeRun({ runId: 'run-2', startedAt: new Date('2026-06-07T10:01:00.000Z') }),
        makeRun({ runId: 'run-1', startedAt: new Date('2026-06-07T10:00:00.000Z') }),
      ],
      2,
    );
    const parsed = parseLedgerCursor(cursor);
    expect(parsed.before?.toISOString()).toBe('2026-06-07T10:00:00.000Z');
    expect(parsed.beforeRunId).toBe('run-1');
  });

  it('tolerates a bare ISO timestamp (no runId half)', () => {
    const parsed = parseLedgerCursor('2026-06-07T10:00:00.000Z');
    expect(parsed.before?.toISOString()).toBe('2026-06-07T10:00:00.000Z');
    expect(parsed.beforeRunId).toBeUndefined();
  });

  it('returns {} for undefined or an unparseable cursor', () => {
    expect(parseLedgerCursor(undefined)).toEqual({});
    expect(parseLedgerCursor('not-a-date|run-1')).toEqual({});
  });
});

describe('buildTrajectory', () => {
  it('maps summaries to compact rows, omitting absent optionals', () => {
    const rows = buildTrajectory([
      makeRun({
        runId: 'run-9',
        status: 'failed',
        startedAt: new Date('2026-06-07T10:00:00.000Z'),
        completedAt: new Date('2026-06-07T10:05:00.000Z'),
        learningCount: 2,
        totalCostCents: 12,
        score: null,
      }),
    ]);
    expect(rows).toEqual([
      {
        runId: 'run-9',
        status: 'failed',
        startedAt: '2026-06-07T10:00:00.000Z',
        completedAt: '2026-06-07T10:05:00.000Z',
        learningCount: 2,
        costCents: 12,
        score: null,
      },
    ]);
  });

  it('omits completedAt and costCents when null', () => {
    const [row] = buildTrajectory([
      makeRun({ runId: 'r', completedAt: null, totalCostCents: null }),
    ]);
    expect(row).not.toHaveProperty('completedAt');
    expect(row).not.toHaveProperty('costCents');
  });
});
