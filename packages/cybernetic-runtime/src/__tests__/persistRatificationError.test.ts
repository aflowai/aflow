import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StagedChange } from '@aflow/schemas';

// ============================================================================
// In-memory mock of the memory-doc repo
// ============================================================================

const mockDocs = new Map<string, string>();

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({ schema: 'test' }),
  createMemoryDocRepository: () => ({
    getByPath: async (path: string) => {
      const content = mockDocs.get(path);
      if (!content) return null;
      return { inlineContent: content, path };
    },
    put: async (opts: { path: string; inlineContent: string }) => {
      mockDocs.set(opts.path, opts.inlineContent);
      return { id: 'doc-id', path: opts.path, currentVersion: 1 };
    },
  }),
}));

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// Imports after mocks are registered.
const { persistRatificationError } = await import('../stagedChange/persistRatificationError.js');
const { RatificationApplyError } = await import('../stagedChange/applyRatifiedOps.js');

const ctx = {
  tenantId: 'tenant-1',
  spaceId: '00000000-0000-0000-0000-000000000000',
  db: {} as never,
};

// ============================================================================
// Fixtures
// ============================================================================

function makeProposal(overrides?: Partial<StagedChange>): StagedChange {
  return {
    id: '00000000-0000-0000-0000-00000000a001',
    kind: 'workflow_refinement',
    source: 'coach',
    status: 'proposed',
    targetWorkflowSlug: 'my-skill',
    proposal: {
      summary: 'Tighten goal phrasing on task-a',
      rationale: 'Run reflections suggest a clearer goal would help.',
      confidence: 'medium',
      ops: [{ op: 'update_task_goal', taskId: 'task-a', newGoal: 'Solve X precisely' }],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'stage_for_review',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-05-12T00:00:00.000Z',
    expiresAt: '2026-06-12T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-00000000c001',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('persistRatificationError', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('writes lastRatificationError onto the staged-change doc', async () => {
    const sc = makeProposal();
    const err = new RatificationApplyError(
      'update_task_goal',
      'Task task-a not found',
      'target_skill_missing',
    );

    const updated = await persistRatificationError(ctx, sc, err);
    expect(updated).not.toBeNull();
    expect(updated?.lastRatificationError).toMatchObject({
      reason: 'target_skill_missing',
      op: 'update_task_goal',
      detail: 'Task task-a not found',
    });
    expect(updated?.lastRatificationError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does NOT change status — proposal stays in `proposed` so Retry is meaningful', async () => {
    const sc = makeProposal();
    const err = new RatificationApplyError('post_validation', 'Graph invalid', 'post_validation');

    const updated = await persistRatificationError(ctx, sc, err);
    expect(updated?.status).toBe('proposed');
  });

  it('persists at the tenant_ratification path for tenant-routed proposals', async () => {
    const sc = makeProposal({ resolutionRoute: 'tenant_ratification' });
    const err = new RatificationApplyError('update_task_goal', 'boom');

    await persistRatificationError(ctx, sc, err);
    expect(mockDocs.has(`/coach/staged/${sc.id}.json`)).toBe(true);
    expect(mockDocs.has(`/coach/platform-issues/${sc.id}.json`)).toBe(false);
  });

  it('persists at the platform-issues path for platform_issue proposals', async () => {
    // While in practice a platform_issue proposal hits the
    // PROPOSAL_NOT_RATIFIABLE 422 before reaching applyRatifiedOps, the
    // helper must respect resolutionRoute when it IS reached.
    const sc = makeProposal({ resolutionRoute: 'platform_issue' });
    const err = new RatificationApplyError(
      'platform_artifact_read_only',
      'platform workflow is read-only',
      'platform_artifact_read_only',
    );

    await persistRatificationError(ctx, sc, err);
    expect(mockDocs.has(`/coach/platform-issues/${sc.id}.json`)).toBe(true);
    expect(mockDocs.has(`/coach/staged/${sc.id}.json`)).toBe(false);
  });

  it('overwrites a prior lastRatificationError on subsequent failures', async () => {
    const sc = makeProposal();
    const firstErr = new RatificationApplyError('add_task', 'boom one', 'transient');
    const second = await persistRatificationError(ctx, sc, firstErr);
    expect(second?.lastRatificationError?.detail).toBe('boom one');

    // Simulate the operator retrying and hitting a different failure.
    const updated: StagedChange = {
      ...sc,
      lastRatificationError: second?.lastRatificationError,
    };
    const secondErr = new RatificationApplyError(
      'update_task_goal',
      'task vanished',
      'target_skill_missing',
    );
    const third = await persistRatificationError(ctx, updated, secondErr);
    expect(third?.lastRatificationError?.detail).toBe('task vanished');
    expect(third?.lastRatificationError?.reason).toBe('target_skill_missing');
  });

  it('truncates op + detail so long Zod / graph-validation messages still persist', async () => {
    // Schema caps op@120 and detail@500. Real apply failures emit Zod
    // error.message values that are several KB. Without clamping, the
    // post-mutation StagedChangeSchema.parse would throw and the helper
    // would log + return null — the operator would see the 422 once but
    // the proposal doc would lose the snapshot.
    const sc = makeProposal();
    const longOp = 'a'.repeat(500);
    const longDetail = 'b'.repeat(5000);
    const err = new RatificationApplyError(longOp, longDetail, 'post_validation');

    const updated = await persistRatificationError(ctx, sc, err);
    expect(updated).not.toBeNull();
    expect(updated?.lastRatificationError?.op.length).toBeLessThanOrEqual(120);
    expect(updated?.lastRatificationError?.detail.length).toBeLessThanOrEqual(500);
    expect(updated?.lastRatificationError?.op.endsWith('...')).toBe(true);
    expect(updated?.lastRatificationError?.detail.endsWith('...')).toBe(true);
    expect(updated?.lastRatificationError?.reason).toBe('post_validation');
  });

  it('defaults reason to `transient` when omitted at the throw site', async () => {
    const sc = makeProposal();
    // Legacy throw sites pass only (op, detail); the constructor default
    // kicks in. This is the safe fallback because Retry is meaningful for
    // anything not explicitly classified.
    const err = new RatificationApplyError('add_task', 'random failure');
    expect(err.reason).toBe('transient');

    const updated = await persistRatificationError(ctx, sc, err);
    expect(updated?.lastRatificationError?.reason).toBe('transient');
  });
});
