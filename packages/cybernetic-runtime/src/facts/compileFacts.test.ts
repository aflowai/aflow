import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Redis } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import { compileCoachFacts } from './compileFacts.js';
import { formatCoachFactsForPrompt } from './formatFactsForPrompt.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const STUB_DB = {} as never;

function stubRedisWithEvents(entries: Array<[string, string[]]>): Redis {
  return {
    xrevrange: vi.fn().mockResolvedValue(entries),
  } as unknown as Redis;
}

const STUB_REDIS = stubRedisWithEvents([]);

const VALID_TENANT_ID = '00000000-0000-0000-0000-000000000099';

describe('compileCoachFacts — input plumbing', () => {
  it('returns a parsed facts record even when all queries fail (defensive empty path)', async () => {
    const facts = await compileCoachFacts({
      db: STUB_DB,
      redis: STUB_REDIS,
      tenantId: VALID_TENANT_ID,
      spaceId: '00000000-0000-0000-0000-000000000001',
      runId: '00000000-0000-0000-0000-000000000002',
      workflowSlug: 'my-skill',
    });
    expect(facts.runId).toBe('00000000-0000-0000-0000-000000000002');
    expect(facts.taskFailures).toEqual([]);
    expect(facts.missingInputs).toEqual([]);
    expect(facts.missingTools).toEqual([]);
    expect(facts.priorObservationRollup).toEqual([]);
    expect(facts.priorProposalHistory).toEqual([]);
  });

  it('produces an evalDeltas record when an evalResult is supplied', async () => {
    const facts = await compileCoachFacts({
      db: STUB_DB,
      redis: STUB_REDIS,
      tenantId: VALID_TENANT_ID,
      spaceId: '00000000-0000-0000-0000-000000000001',
      runId: '00000000-0000-0000-0000-000000000002',
      workflowSlug: 'my-skill',
      evalResult: {
        verdict: 'fail',
        scores: { overall: 0.42 },
        regressionDetected: true,
      },
      evalBaselineOverall: 0.75,
    });
    expect(facts.evalDeltas).toBeDefined();
    expect(facts.evalDeltas?.regressionConfirmed).toBe(true);
    expect(facts.evalDeltas?.overall).toBeCloseTo(0.42 - 0.75, 5);
  });
});

describe('formatCoachFactsForPrompt', () => {
  it('returns empty string for an empty facts record', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [],
      priorProposalHistory: [],
      priorObservationRollup: [],
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    expect(formatCoachFactsForPrompt(facts)).toBe('');
  });

  it('renders a Facts section heading + task failure detail when failures present', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [
        {
          taskId: 'train',
          attempt: 2,
          errorCategory: 'timeout' as const,
          errorMessage: 'Step timed out after 30s',
          repeatedShapeCount: 2,
        },
      ],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [],
      priorProposalHistory: [],
      priorObservationRollup: [],
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    const out = formatCoachFactsForPrompt(facts);
    expect(out).toContain('## Facts');
    expect(out).toContain('### Task failures');
    expect(out).toContain('train attempt 2');
    expect(out).toContain('timeout');
    expect(out).toContain('×2 this run');
  });

  it('teaches the prompt that facts win on disagreement', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [
        {
          taskId: 't',
          attempt: 1,
          errorCategory: 'unknown' as const,
          errorMessage: 'x',
          repeatedShapeCount: 1,
        },
      ],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [],
      priorProposalHistory: [],
      priorObservationRollup: [],
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    const out = formatCoachFactsForPrompt(facts);
    expect(out).toMatch(/trust these over the digest narrative on conflict/i);
  });

  it('renders dataflowBreaks when present (Phase 3b enrichment)', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [
        { fromTaskId: 'extract', toTaskId: 'train', detail: 'extract output had no rows' },
        { fromTaskId: 'fetch', detail: 'fetch failed; downstream tasks blocked' },
      ],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [],
      priorProposalHistory: [],
      priorObservationRollup: [],
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    const out = formatCoachFactsForPrompt(facts);
    expect(out).toContain('### Dataflow breaks');
    expect(out).toContain('extract → train');
    expect(out).toContain('fetch → ?');
    expect(out).toContain('extract output had no rows');
  });

  it('renders scopeSignal when present (Phase 3b enrichment)', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [],
      priorProposalHistory: [],
      priorObservationRollup: [],
      scopeSignal: {
        kind: 'outcome_divergence' as const,
        detail: 'recent runs split by intent cluster',
      },
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    const out = formatCoachFactsForPrompt(facts);
    expect(out).toContain('### Scope signal');
    expect(out).toContain('outcome_divergence');
    expect(out).toContain('recent runs split by intent cluster');
  });

  it('renders repeatedToolShapes.detail when enriched (Phase 3b)', () => {
    const facts = {
      factsId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      compiledAt: '2026-05-26T00:00:00.000Z',
      taskFailures: [],
      missingInputs: [],
      missingTools: [],
      contractViolations: [],
      dataflowBreaks: [],
      costLatencyAnomalies: [],
      platformEnvironmentSignals: [],
      repeatedToolShapes: [
        {
          operationId: 'ai.generate',
          argShapeFingerprint: 'fp-1',
          count: 3,
          allSucceeded: false,
          detail: 'Retry loop after transient provider 5xx',
        },
        {
          operationId: 'api.http.call',
          argShapeFingerprint: 'fp-2',
          count: 2,
          allSucceeded: true,
        },
      ],
      priorProposalHistory: [],
      priorObservationRollup: [],
    } as Parameters<typeof formatCoachFactsForPrompt>[0];
    const out = formatCoachFactsForPrompt(facts);
    expect(out).toContain('### Repeated tool-call shapes');
    expect(out).toContain('ai.generate repeated ×3');
    expect(out).toContain('Retry loop after transient provider 5xx');
    // No detail on fp-2 — the base line stands.
    expect(out).toContain('api.http.call repeated ×2');
  });
});
