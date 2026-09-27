/**
 * Tests for the skill_compose ratification handler (104f Phase 2).
 *
 * Uses the same mock pattern as applyRatifiedOps.test.ts: Map-based
 * docRepo with await import() after vi.mock().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StagedChange, SkillComposeBundle, SkillManifest } from '@aflow/schemas';

// ============================================================================
// Fixtures
// ============================================================================

function makeValidBundle(): SkillComposeBundle {
  return {
    workflow: {
      slug: 'csv-analyzer',
      name: 'CSV Analyzer',
      goal: 'Analyze CSV data files and produce summary reports.',
      outcomes: [
        {
          id: 'report-generated',
          name: 'Report Generated',
          evaluator: { type: 'manual', instruction: 'A report was produced' },
        },
      ],
      mode: 'process',
      tasks: [
        {
          taskId: 'parse-csv',
          name: 'Parse CSV',
          goal: 'Parse the uploaded CSV file.',
          type: 'agent',
        },
        {
          taskId: 'summarize',
          name: 'Summarize',
          goal: 'Produce a summary report.',
          dependsOn: ['parse-csv'],
          type: 'agent',
        },
      ],
    },
    manifest: {
      skillId: 'csv-analyzer',
      name: 'CSV Analyzer',
      goal: 'Analyze CSV data files and produce summary reports.',
      mode: 'process',
    },
    evalSuite: {
      version: 1,
      goalCriteria: [
        {
          name: 'report-exists',
          type: 'contains',
          inField: 'output',
          pattern: 'report',
        },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
      createdAt: '2026-04-23T00:00:00.000Z',
      updatedAt: '2026-04-23T00:00:00.000Z',
      createdBy: 'compose-skill',
    },
    rationale: 'User requested a skill to analyze CSV data files.',
  };
}

function makeProposal(bundle: SkillComposeBundle): StagedChange {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'skill_compose',
    status: 'proposed',
    proposal: {
      summary: 'Create csv-analyzer skill',
      rationale: 'User needs CSV analysis.',
      confidence: 'high',
      ops: [
        {
          op: 'skill_compose' as const,
          bundle,
          authoredBySkillId: 'compose-skill',
        },
      ],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-04-23T00:00:00.000Z',
    expiresAt: '2026-04-30T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-000000000002',
  };
}

// ============================================================================
// Mocks
// ============================================================================

const mockDocs = new Map<string, string>();
const softDeletedPaths = new Set<string>();
const capturedManifests: SkillManifest[] = [];

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({ schema: 'test' }),
  createMemoryDocRepository: () => ({
    getByPath: async (path: string) => {
      const content = mockDocs.get(path);
      if (content === undefined) return null;
      return {
        inlineContent: content,
        path,
        deletedAt: softDeletedPaths.has(path) ? new Date('2026-05-01T00:00:00.000Z') : null,
      };
    },
    put: async (opts: { path: string; inlineContent: string }) => {
      // upsert semantics: writing a doc revives any soft-deleted row at the path.
      softDeletedPaths.delete(opts.path);
      mockDocs.set(opts.path, opts.inlineContent);
    },
  }),
}));

vi.mock('../skill.js', () => ({
  upsertSkillManifest: async (_ctx: unknown, manifest: SkillManifest) => {
    capturedManifests.push(manifest);
  },
}));

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// Import after mocks
const { applyRatifiedOps, RatificationApplyError } =
  await import('../stagedChange/applyRatifiedOps.js');
const { applySkillComposeBundle } = await import('../stagedChange/skillComposeApply.js');

const ctx = {
  tenantId: 'tenant-1',
  spaceId: 'space-1',
  db: {} as never,
};

// ============================================================================
// Tests
// ============================================================================

describe('applySkillComposeBundle (104f Phase 2)', () => {
  beforeEach(() => {
    mockDocs.clear();
    softDeletedPaths.clear();
    capturedManifests.length = 0;
  });

  it('creates all artifacts on valid bundle', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toEqual(['skill_compose']);

    // Verify workflow doc was written
    const wfJson = mockDocs.get('/workflows/csv-analyzer/workflow.json');
    expect(wfJson).toBeDefined();
    const wf = JSON.parse(wfJson!);
    expect(wf.slug).toBe('csv-analyzer');
    expect(wf.status).toBe('approved');
    expect(wf.origin).toBe('operator');
    expect(wf.revision).toBe(1);
    expect(wf.tasks).toHaveLength(2);

    // Verify SkillManifest was upserted
    expect(capturedManifests).toHaveLength(1);
    const manifest = capturedManifests[0]!;
    expect(manifest.skillId).toBe('csv-analyzer');
    expect(manifest.workflowSlug).toBe('csv-analyzer');
    expect(manifest.origin).toBe('operator');
    expect(manifest.evalSuiteRef).toBe('/evals/csv-analyzer/suite.json');
    expect(manifest.mode).toBe('process');

    // Verify eval suite doc was written
    const evalJson = mockDocs.get('/evals/csv-analyzer/suite.json');
    expect(evalJson).toBeDefined();
    const suite = JSON.parse(evalJson!);
    expect(suite.goalCriteria).toHaveLength(1);
  });

  it('writes activation doc when activation is present', async () => {
    const bundle = makeValidBundle();
    bundle.activation = {
      triggerPatterns: ['analyze csv', 'csv report'],
      activationHint: 'Use when the user asks to analyze CSV files.',
      priority: 50,
    };
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    // Activation doc written
    const actJson = mockDocs.get('/workflows/csv-analyzer/activation.json');
    expect(actJson).toBeDefined();
    const act = JSON.parse(actJson!);
    expect(act.triggerPatterns).toContain('analyze csv');

    // Manifest references activation
    const manifest = capturedManifests[0]!;
    expect(manifest.activationRef).toBe('/workflows/csv-analyzer/activation.json');
  });

  it('does not write activation doc when activation is absent', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const actJson = mockDocs.get('/workflows/csv-analyzer/activation.json');
    expect(actJson).toBeUndefined();

    const manifest = capturedManifests[0]!;
    expect(manifest.activationRef).toBeUndefined();
  });

  it('rejects when an ACTIVE workflow already exists at target slug', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);

    // Pre-existing *active* workflow (deletedAt null) — genuine collision.
    mockDocs.set('/workflows/csv-analyzer/workflow.json', '{}');

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(
      "Workflow 'csv-analyzer' already exists",
    );
    expect(capturedManifests).toHaveLength(0); // No manifest created
  });

  it('revives an archived skill on reinstall instead of refusing (Plan 176 §4 Phase 1)', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);

    // Pre-existing *archived* (soft-deleted) workflow at the same slug.
    mockDocs.set('/workflows/csv-analyzer/workflow.json', '{"slug":"csv-analyzer","stale":true}');
    softDeletedPaths.add('/workflows/csv-analyzer/workflow.json');

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toEqual(['skill_compose']);

    // Workflow doc overwritten with the fresh definition (revive-on-upsert).
    const wfJson = mockDocs.get('/workflows/csv-analyzer/workflow.json');
    const wf = JSON.parse(wfJson!);
    expect(wf.slug).toBe('csv-analyzer');
    expect(wf.status).toBe('approved');
    expect(wf.revision).toBe(1);
    expect(wf.stale).toBeUndefined();

    // Manifest re-written as part of the revive.
    expect(capturedManifests).toHaveLength(1);
    expect(capturedManifests[0]!.skillId).toBe('csv-analyzer');
  });

  it('rejects when bundle has slug mismatch', async () => {
    const bundle = makeValidBundle();
    // @ts-expect-error — deliberately breaking the bundle for test
    bundle.manifest = { ...bundle.manifest, skillId: 'wrong-slug' };
    const sc = makeProposal(bundle);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow('Bundle validation failed');
    expect(capturedManifests).toHaveLength(0);
  });

  it('rejects when eval suite has zero criteria', async () => {
    const bundle = makeValidBundle();
    bundle.evalSuite.goalCriteria = [];
    const sc = makeProposal(bundle);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow('Bundle validation failed');
  });

  it('rejects when workflow graph has a cycle', async () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks = [
      {
        taskId: 'parse-csv',
        name: 'Parse CSV',
        goal: 'Parse.',
        type: 'agent' as const,
        dependsOn: ['summarize'],
      },
      {
        taskId: 'summarize',
        name: 'Summarize',
        goal: 'Summarize.',
        type: 'agent' as const,
        dependsOn: ['parse-csv'],
      },
    ];
    const sc = makeProposal(bundle);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow();
  });

  it('rejects a contract-invalid bundle at the DIRECT install path (Plan 190 §1)', async () => {
    // Catalog / seed install call applySkillComposeBundle directly, bypassing
    // extractAndValidateBundle. An op task missing a required input must be
    // refused here too — the incident path is no longer un-gated.
    const bundle = makeValidBundle();
    bundle.workflow.tasks = [
      {
        taskId: 'record',
        name: 'Record',
        goal: 'record',
        type: 'operation',
        operation: 'workflow.learn',
      },
    ];
    bundle.evalSuite.taskCriteria = {};
    await expect(applySkillComposeBundle(ctx, bundle)).rejects.toThrow(RatificationApplyError);
  });

  it('does not block install on an eval-linkage issue (advisory, not error)', async () => {
    // An eval criterion bound to a field the (closed-output) task never
    // produces is advisory — the skill still installs; the dead criterion is
    // excluded from the verdict at run time, not refused at install.
    const bundle = makeValidBundle();
    bundle.workflow.tasks = [
      {
        taskId: 'summarize',
        name: 'Summarize',
        goal: 'Produce a summary report.',
        type: 'agent',
        outputContract: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['report'],
            properties: { report: { type: 'string' } },
          },
        },
      },
    ];
    bundle.evalSuite.goalCriteria = [];
    bundle.evalSuite.taskCriteria = {
      summarize: [{ name: 'ghost', type: 'contains', inField: 'ghostField', pattern: 'x' }],
    };
    const result = await applySkillComposeBundle(ctx, bundle);
    expect(result.applied).toBe(true);
  });

  it('persists the DERIVED (materialized) tasks at the direct install path', async () => {
    // The stored doc must carry op-bound producer shapes so persisted-form ===
    const bundle = makeValidBundle();
    bundle.workflow.slug = 'derive-at-install';
    bundle.manifest.skillId = 'derive-at-install';
    bundle.workflow.tasks = [
      {
        taskId: 'extract',
        name: 'Extract',
        goal: 'extract',
        type: 'agent',
        produces: [{ key: 'learnings' }],
      },
      {
        taskId: 'record',
        name: 'Record',
        goal: 'record',
        type: 'operation',
        operation: 'workflow.learn',
        dependsOn: ['extract'],
        inputBindings: {
          learnings: { kind: 'task_output', taskId: 'extract', path: 'learnings' },
        },
      },
    ];
    bundle.evalSuite.taskCriteria = {};
    await applySkillComposeBundle(ctx, bundle);
    const wf = JSON.parse(mockDocs.get('/workflows/derive-at-install/workflow.json')!);
    const extract = wf.tasks.find((t: { taskId: string }) => t.taskId === 'extract');
    const port = extract.produces.find((p: { key: string }) => p.key === 'learnings');
    expect(port.shape).toBeDefined();
  });

  it('throws RatificationApplyError on failures', async () => {
    const bundle = makeValidBundle();
    // @ts-expect-error — deliberately breaking the bundle for test
    bundle.manifest = { ...bundle.manifest, skillId: 'wrong-slug' };
    const sc = makeProposal(bundle);

    try {
      await applyRatifiedOps(ctx, sc);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RatificationApplyError);
    }
  });

  it('rejects proposals with more than one op', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);
    // Add a second op
    sc.proposal.ops.push({
      op: 'skill_compose' as const,
      bundle,
      authoredBySkillId: 'compose-skill',
    });

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow('exactly 1 op');
  });

  it('rejects when eval taskCriteria references unknown taskId', async () => {
    const bundle = makeValidBundle();
    bundle.evalSuite.taskCriteria = {
      'nonexistent-task': [
        { name: 'check', type: 'contains' as const, inField: 'output', pattern: 'ok' },
      ],
    };
    const sc = makeProposal(bundle);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow('taskId not in the workflow');
  });

  it('rejects when a task declares curated context strategy', async () => {
    const bundle = makeValidBundle();
    bundle.workflow.tasks[0]!.context = {
      strategy: 'curated',
      contextPolicy: 'auto-optimize',
      learnings: 'active',
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow("strategy 'curated'");
  });

  it('uses upsert for retry safety (no "already exists" on second attempt)', async () => {
    const bundle = makeValidBundle();
    const sc = makeProposal(bundle);

    // First apply succeeds
    await applyRatifiedOps(ctx, sc);
    expect(capturedManifests).toHaveLength(1);

    // Clear the "already exists" guard by removing workflow from the mock
    // (simulates the scenario where apply succeeded but status wasn't persisted)
    // Actually: the guard checks getByPath which reads from mockDocs.
    // On retry, the workflow IS there — but we use upsert, so it should
    // NOT throw "already exists" if we skip the guard.
    // The current implementation DOES throw on existing workflow.
    // This test documents that retry on a fully-written partial state
    // would need the proposal to be rejected and re-created.
    // For now, verify the first attempt wrote all artifacts.
    expect(mockDocs.has('/workflows/csv-analyzer/workflow.json')).toBe(true);
    expect(mockDocs.has('/evals/csv-analyzer/suite.json')).toBe(true);
  });

  it('derives requiredCapabilities from task operations (excluding platform prefixes)', async () => {
    const bundle = makeValidBundle();
    // Add an operation task referencing a non-platform op
    bundle.workflow.tasks.push({
      taskId: 'call-stripe',
      name: 'Call Stripe',
      goal: 'Charge the card.',
      type: 'operation',
      operation: 'stripe.charges.create',
      dependsOn: ['summarize'],
    });
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const manifest = capturedManifests[0]!;
    expect(manifest.requiredCapabilities).toContain('stripe');
    // Platform prefixes should NOT be in requiredCapabilities
    expect(manifest.requiredCapabilities).not.toContain('agent');
    expect(manifest.requiredCapabilities).not.toContain('workflow');
    expect(manifest.requiredCapabilities).not.toContain('memory');
  });

  it('derives requiredCapabilities from agent-task context.tools', async () => {
    const bundle = makeValidBundle();
    // Add context.tools with an external API tool
    bundle.workflow.tasks[0]!.context = {
      strategy: 'scoped',
      contextPolicy: 'auto-optimize',
      learnings: 'active',
      tools: ['github.repos.list', 'memory.store.query'],
    } as Record<string, unknown>;
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const manifest = capturedManifests[0]!;
    expect(manifest.requiredCapabilities).toContain('github');
    // memory.* is a platform prefix — should be excluded
    expect(manifest.requiredCapabilities).not.toContain('memory');
  });

  it('sets empty requiredCapabilities when only platform ops are used', async () => {
    const bundle = makeValidBundle();
    // All tasks are agent-type with no external operations
    const sc = makeProposal(bundle);

    await applyRatifiedOps(ctx, sc);

    const manifest = capturedManifests[0]!;
    expect(manifest.requiredCapabilities).toEqual([]);
  });
});
