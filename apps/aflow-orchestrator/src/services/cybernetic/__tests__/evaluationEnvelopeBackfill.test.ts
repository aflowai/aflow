/**
 * Null-envelope backfill (Plan 269 D16): a terminal run whose post-run hook
 * died before writing the evaluation envelope gets a decision RECORDED — only
 * past the grace window, with per-run error isolation. Evaluation is never
 * re-run, because the hook's paid and irreversible effects precede the
 * envelope write. Runs terminal before the envelope era (derived from the
 * earliest envelope decidedAt) carry a different reason for the same missing
 * envelope.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockListMissing = vi.fn();
const mockEraStart = vi.fn();
const mockLoadEvalSuite = vi.fn();
const mockWriteEnvelope = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    listRunsMissingEvaluationEnvelope: (...a: unknown[]) => mockListMissing(...a),
    getEarliestEnvelopeDecidedAt: (...a: unknown[]) => mockEraStart(...a),
    loadEvalSuite: (...a: unknown[]) => mockLoadEvalSuite(...a),
    writeRunEvaluationEnvelope: (...a: unknown[]) => mockWriteEnvelope(...a),
  };
});

import { backfillMissingEvaluationEnvelopes } from '../evaluationEnvelopeBackfill.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const deps = { db: {} as never, redis: {} as never, payloadStore: {} as never };
const NOW = new Date('2026-08-06T12:00:00Z');

function row(runId: string, minutesAgo: number) {
  return {
    runId,
    spaceId: 'space-1',
    workflowSlug: 'daily-metrics',
    completedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** The decision argument of the nth `writeRunEvaluationEnvelope` call. */
function writeCall(n: number) {
  return mockWriteEnvelope.mock.calls[n]![2] as {
    runId: string;
    write: { kind: string; decision: string; errorMessage?: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the envelope era started long ago — every candidate is genuine
  // crash window unless a test says otherwise.
  mockEraStart.mockResolvedValue(minutesAgo(100 * 24 * 60));
  mockLoadEvalSuite.mockResolvedValue(null);
  mockWriteEnvelope.mockResolvedValue({ written: true });
});

describe('backfillMissingEvaluationEnvelopes', () => {
  it('no candidates → no-op', async () => {
    mockListMissing.mockResolvedValueOnce([]);
    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, { now: NOW });
    expect(result).toEqual({
      scanned: 0,
      crashWindowWrites: 0,
      historicalPlainWrites: 0,
      errors: 0,
    });
    expect(mockWriteEnvelope).not.toHaveBeenCalled();
    expect(mockEraStart).not.toHaveBeenCalled();
  });

  it('records a decision only for runs terminal past the grace window', async () => {
    mockListMissing.mockResolvedValueOnce([
      row('run-old', 30),
      row('run-fresh', 2), // inside the grace window — the in-process hook may still land
    ]);

    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, {
      now: NOW,
      graceMs: 10 * 60_000,
    });

    expect(result).toMatchObject({ scanned: 2, crashWindowWrites: 1, errors: 0 });
    expect(mockWriteEnvelope).toHaveBeenCalledOnce();
    expect(writeCall(0)).toMatchObject({ runId: 'run-old' });
  });

  it('a terminal run with no completedAt is skipped entirely', async () => {
    mockListMissing.mockResolvedValueOnce([{ ...row('run-broken', 60), completedAt: null }]);
    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, { now: NOW });
    expect(result).toMatchObject({ crashWindowWrites: 0, historicalPlainWrites: 0 });
    expect(mockWriteEnvelope).not.toHaveBeenCalled();
  });

  it('isolates per-run failures', async () => {
    mockListMissing.mockResolvedValueOnce([row('run-a', 60), row('run-b', 50), row('run-c', 40)]);
    mockWriteEnvelope.mockRejectedValueOnce(new Error('db down'));

    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, {
      now: NOW,
      graceMs: 10 * 60_000,
    });

    expect(result).toMatchObject({ scanned: 3, crashWindowWrites: 2, errors: 1 });
    expect(mockWriteEnvelope).toHaveBeenCalledTimes(3);
  });
});

describe('backfillMissingEvaluationEnvelopes — evaluation is recorded, never re-run', () => {
  it("a crash-window run WITH a suite records 'error' naming the interrupted hook", async () => {
    mockLoadEvalSuite.mockResolvedValue({ goalCriteria: [] });
    mockListMissing.mockResolvedValueOnce([row('run-crash-window', 30)]);

    await backfillMissingEvaluationEnvelopes(deps, TENANT, { now: NOW, graceMs: 10 * 60_000 });

    const write = writeCall(0).write;
    expect(write.decision).toBe('error');
    expect(write.errorMessage).toContain('did not complete');
    expect(write.errorMessage).toContain('double');
  });

  it('a crash-window run with NO suite records no_suite — it lost nothing', async () => {
    mockListMissing.mockResolvedValueOnce([row('run-crash-window', 30)]);
    await backfillMissingEvaluationEnvelopes(deps, TENANT, { now: NOW, graceMs: 10 * 60_000 });
    expect(writeCall(0).write).toMatchObject({ decision: 'no_suite' });
  });

  // The founding defect: the pass used to re-fire the whole post-run hook for
  // a crash-window run. Judge model calls, the hook-failed event, score and
  // candidate materialization and the Coach triggers all run BEFORE the
  // envelope write, so a missing envelope cannot prove they did not happen —
  // a re-fire double-charges the operator and feeds the learning loop the
  // same evidence twice. A mocked assertion would go vacuous the moment the
  // import came back, so this reads the source.
  it('never reaches for the post-run hook', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../evaluationEnvelopeBackfill.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+'[^']*postRunHooks\.js'/);
    expect(source).not.toContain('fireCyberneticPostRunHooksStandalone');
  });
});

describe('backfillMissingEvaluationEnvelopes — pre-envelope history (D16 split)', () => {
  it('a run terminal before the era boundary carries the pre-envelope reason instead', async () => {
    mockEraStart.mockResolvedValue(minutesAgo(60));
    mockLoadEvalSuite.mockResolvedValue({ goalCriteria: [] });
    mockListMissing.mockResolvedValueOnce([
      row('run-historical', 600),
      row('run-crash-window', 30),
    ]);

    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, {
      now: NOW,
      graceMs: 10 * 60_000,
    });

    expect(result).toMatchObject({
      crashWindowWrites: 1,
      historicalPlainWrites: 1,
      errors: 0,
    });
    expect(writeCall(0)).toMatchObject({ runId: 'run-historical' });
    expect(writeCall(0).write.errorMessage).toContain('before the evaluation envelope existed');
    expect(writeCall(1)).toMatchObject({ runId: 'run-crash-window' });
    expect(writeCall(1).write.errorMessage).toContain('did not complete');
  });

  it('no envelope ever written (first deploy) → the entire backlog drains as plain writes', async () => {
    mockEraStart.mockResolvedValue(null);
    mockListMissing.mockResolvedValueOnce([row('run-a', 600), row('run-b', 500), row('run-c', 30)]);

    const result = await backfillMissingEvaluationEnvelopes(deps, TENANT, {
      now: NOW,
      graceMs: 10 * 60_000,
      limit: 2,
    });

    // Every write is cheap, so the whole fetched page drains in one pass.
    expect(result).toMatchObject({ crashWindowWrites: 0, historicalPlainWrites: 3, errors: 0 });
    expect(mockWriteEnvelope).toHaveBeenCalledTimes(3);
  });
});
