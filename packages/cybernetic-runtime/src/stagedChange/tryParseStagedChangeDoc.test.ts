import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  tryParseStagedChangeDoc,
  normalizeStagedChangeRaw,
  __resetParseFailureDedupForTests,
} from './tryParseStagedChangeDoc.js';
import { getCyberneticLogger } from '../logger.js';

// Logger must be configured before getCyberneticLogger() is called
// anywhere in this module's import graph.
beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

function makeValidStagedChange(overrides: Record<string, unknown> = {}): string {
  const sc = {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'workflow_refinement' as const,
    status: 'proposed' as const,
    source: 'coach' as const,
    authorityLevel: 'stage_for_review' as const,
    resolutionRoute: 'tenant_ratification' as const,
    rebaseState: 'clean' as const,
    coachSessionId: '00000000-0000-0000-0000-000000000002',
    targetWorkflowSlug: 'wf',
    pinnedRevision: 1,
    proposal: {
      summary: 's',
      rationale: 'r',
      confidence: 'low' as const,
      ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'x' }],
    },
    evidence: {
      sourceSessionIds: ['00000000-0000-0000-0000-000000000003'],
    },
    proposedAt: '2026-05-25T09:00:00.000Z',
    expiresAt: '2026-06-25T09:00:00.000Z',
    ...overrides,
  };
  return JSON.stringify(sc);
}

const baseCtx = {
  tenantId: 't-1',
  spaceId: 's-1',
  docPath: '/coach/staged/test.json',
  reader: 'test',
};

beforeEach(() => {
  vi.restoreAllMocks();
  __resetParseFailureDedupForTests();
  // Silence warn output during tests but capture for assertions.
  const logger = getCyberneticLogger();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

describe('tryParseStagedChangeDoc', () => {
  it('returns { ok: true } for a valid StagedChange doc', () => {
    const result = tryParseStagedChangeDoc(makeValidStagedChange(), baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staged.id).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.staged.status).toBe('proposed');
    }
  });

  it('returns { ok: false, reason: "json" } for malformed JSON', () => {
    const result = tryParseStagedChangeDoc('{not valid json', baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('json');
      expect(result.zodPath).toBeUndefined();
    }

    const logger = getCyberneticLogger();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(msg)).toContain('json parse failure');
    expect(ctx).toMatchObject({
      tenantId: 't-1',
      spaceId: 's-1',
      docPath: '/coach/staged/test.json',
      reader: 'test',
      reason: 'json',
    });
  });

  it('returns { ok: false, reason: "schema", zodPath } for a schema-rejected doc', () => {
    // Strip the required `proposedAt` field — schema must reject.
    const doc = JSON.parse(makeValidStagedChange()) as Record<string, unknown>;
    delete doc['proposedAt'];
    const result = tryParseStagedChangeDoc(JSON.stringify(doc), baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('schema');
      expect(result.zodPath).toBeTruthy();
    }

    const logger = getCyberneticLogger();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(ctx).toMatchObject({ reason: 'schema' });
    // `zodPath` lives on the log context — should be the path of the missing field.
    expect(String((ctx as Record<string, unknown>)['zodPath'])).toContain('proposedAt');
  });

  it('dedups warn output for identical-content failures within the same window', () => {
    const badJson = '{not valid json';
    tryParseStagedChangeDoc(badJson, baseCtx);
    tryParseStagedChangeDoc(badJson, baseCtx);
    tryParseStagedChangeDoc(badJson, baseCtx);

    const logger = getCyberneticLogger();
    // First call logs; the next two are dedup'd by content_hash.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs separately when the content hash differs even if reason/path match', () => {
    tryParseStagedChangeDoc('{bad-a', baseCtx);
    tryParseStagedChangeDoc('{bad-b', baseCtx);

    const logger = getCyberneticLogger();
    // Two distinct content hashes → two warn lines.
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('normalizes a pre-causeStatus warrant so the doc parses (defaults to inferred)', () => {
    const doc = JSON.parse(makeValidStagedChange()) as Record<string, unknown>;
    doc['evidence'] = {
      sourceSessionIds: [],
      warrant: {
        claim: 'c',
        evidenceSummary: 'e',
        warrant: 'w',
        expectedEffect: 'x',
      },
    };
    const result = tryParseStagedChangeDoc(JSON.stringify(doc), baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staged.evidence.warrant?.causeStatus).toBe('inferred');
    }
    // A recovered doc must not log a parse failure.
    expect(getCyberneticLogger().warn).not.toHaveBeenCalled();
  });

  it('drops an incomplete validations block (missing required contract)', () => {
    const doc = JSON.parse(makeValidStagedChange()) as Record<string, unknown>;
    const proposal = doc['proposal'] as Record<string, unknown>;
    proposal['validations'] = { capability: { issues: [], warnings: [] } };
    const result = tryParseStagedChangeDoc(JSON.stringify(doc), baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.staged.proposal.validations).toBeUndefined();
    }
  });

  it('puts doc id / path / tenant / space in the LOG context, not in metric labels', () => {
    tryParseStagedChangeDoc('{bad', baseCtx);
    const logger = getCyberneticLogger();
    const [, ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const log = ctx as Record<string, unknown>;
    expect(log['tenantId']).toBe('t-1');
    expect(log['spaceId']).toBe('s-1');
    expect(log['docPath']).toBe('/coach/staged/test.json');
    expect(log['contentHash']).toBeTruthy();
    // (We can't easily intercept the OTel counter add() in a node-env
    // unit test without bootstrapping the SDK; the contract that
    // doc/tenant/space go through the LOG path is the load-bearing
    // assertion — those are the high-cardinality fields we deliberately
    // route to logs only.)
  });
});

describe('normalizeStagedChangeRaw', () => {
  it('preserves an already-valid causeStatus', () => {
    const raw = { evidence: { warrant: { causeStatus: 'observed' } } };
    normalizeStagedChangeRaw(raw);
    expect(raw.evidence.warrant.causeStatus).toBe('observed');
  });

  it('leaves a complete validations block intact', () => {
    const raw = {
      proposal: { validations: { contract: { valid: true }, capability: { issues: [] } } },
    };
    normalizeStagedChangeRaw(raw);
    expect(raw.proposal.validations).toBeDefined();
  });

  it('never fabricates fields inside the proposal ops', () => {
    const raw = {
      proposal: { ops: [{ op: 'update_task_goal', taskId: 'a' }] },
      evidence: { warrant: {} },
    };
    normalizeStagedChangeRaw(raw);
    expect(raw.proposal.ops).toEqual([{ op: 'update_task_goal', taskId: 'a' }]);
  });

  it('is a no-op on non-object input', () => {
    expect(normalizeStagedChangeRaw(null)).toBeNull();
    expect(normalizeStagedChangeRaw('x')).toBe('x');
  });
});
