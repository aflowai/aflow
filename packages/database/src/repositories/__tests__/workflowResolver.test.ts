import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetByPath = vi.fn();
const mockGetPlatformWorkflow = vi.fn();
const mockIsPlatformSlug = vi.fn(() => false);

vi.mock('../memoryDocs.js', () => ({
  createMemoryDocRepository: () => ({
    getByPath: (path: string) => mockGetByPath(path),
  }),
}));

vi.mock('../../tenant.js', () => ({
  createTenantContext: () => ({ schema: 'test' }),
}));

vi.mock('@aflow/platform-artifacts', () => ({
  getPlatformWorkflow: (slug: string) => mockGetPlatformWorkflow(slug),
  isPlatformWorkflowSlug: (slug: string) => mockIsPlatformSlug(slug),
}));

const { resolveWorkflowForRunRevision, MissingPinnedRevisionError } =
  await import('../workflowResolver.js');

describe('resolveWorkflowForRunRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformSlug.mockReturnValue(false);
  });

  it('returns the pinned revision snapshot when present', async () => {
    mockGetByPath.mockImplementation((path: string) => {
      if (path === '/workflows/wf/revisions/workflow-r3.json') {
        return { inlineContent: JSON.stringify({ id: 'pinned', revision: 3 }) };
      }
      return null;
    });

    const result = await resolveWorkflowForRunRevision(
      {} as never,
      'tenant-1' as never,
      'space-1',
      'wf',
      3,
    );

    expect(result.source).toBe('revision');
    expect((result.workflow as { id: string }).id).toBe('pinned');
  });

  it('throws MissingPinnedRevisionError when snapshot is absent and no platform fallback', async () => {
    mockGetByPath.mockReturnValue(null);
    mockGetPlatformWorkflow.mockReturnValue(undefined);

    await expect(
      resolveWorkflowForRunRevision({} as never, 'tenant-1' as never, 'space-1', 'wf', 3),
    ).rejects.toBeInstanceOf(MissingPinnedRevisionError);
  });

  it('throws MissingPinnedRevisionError if pinned snapshot is unparseable', async () => {
    mockGetByPath.mockReturnValue({ inlineContent: '{not valid json' });
    mockGetPlatformWorkflow.mockReturnValue(undefined);

    await expect(
      resolveWorkflowForRunRevision({} as never, 'tenant-1' as never, 'space-1', 'wf', 3),
    ).rejects.toBeInstanceOf(MissingPinnedRevisionError);
  });

  it('does NOT fall back to /workflows/<slug>/workflow.json when snapshot is missing', async () => {
    // Simulate a workflow.json that exists but is at a DIFFERENT revision —
    // exactly the scenario plan 113 protects against.
    mockGetByPath.mockImplementation((path: string) => {
      if (path === '/workflows/wf/revisions/workflow-r3.json') return null;
      if (path === '/workflows/wf/workflow.json') {
        return { inlineContent: JSON.stringify({ id: 'latest', revision: 9 }) };
      }
      return null;
    });
    mockGetPlatformWorkflow.mockReturnValue(undefined);

    await expect(
      resolveWorkflowForRunRevision({} as never, 'tenant-1' as never, 'space-1', 'wf', 3),
    ).rejects.toBeInstanceOf(MissingPinnedRevisionError);
  });

  it('returns the platform registry workflow only when its revision matches', async () => {
    mockGetByPath.mockReturnValue(null);
    mockGetPlatformWorkflow.mockReturnValue({ id: 'platform', revision: 5 });

    const result = await resolveWorkflowForRunRevision(
      {} as never,
      'tenant-1' as never,
      'space-1',
      'platform-wf',
      5,
    );

    expect(result.source).toBe('platform');
  });

  it('rejects when the platform registry has moved to a different revision', async () => {
    mockGetByPath.mockReturnValue(null);
    mockGetPlatformWorkflow.mockReturnValue({ id: 'platform', revision: 7 });

    await expect(
      resolveWorkflowForRunRevision({} as never, 'tenant-1' as never, 'space-1', 'platform-wf', 5),
    ).rejects.toBeInstanceOf(MissingPinnedRevisionError);
  });
});

// ============================================================================

import { ensureWorkflowRevisionSnapshot, WorkflowRevisionDriftError } from '../workflowPaths.js';

describe('ensureWorkflowRevisionSnapshot', () => {
  let mockPut: ReturnType<typeof vi.fn>;
  let mockGetByPath2: ReturnType<typeof vi.fn>;
  type DocRepo = Parameters<typeof ensureWorkflowRevisionSnapshot>[0]['docRepo'];

  function makeDocRepo(): DocRepo {
    return { getByPath: mockGetByPath2, put: mockPut } as unknown as DocRepo;
  }

  beforeEach(() => {
    mockPut = vi.fn().mockResolvedValue({ id: 'doc-1', path: 'p', currentVersion: 1 });
    mockGetByPath2 = vi.fn().mockResolvedValue(null);
  });

  it('writes the snapshot when no prior revision document exists', async () => {
    const wf = { revision: 3, slug: 'wf', tasks: [] };
    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: wf,
      actor: 'system:test',
    });
    expect(outcome).toBe('created');
    expect(mockPut).toHaveBeenCalledOnce();
    const args = mockPut.mock.calls[0]![0] as { writeMode: string; path: string };
    expect(args.writeMode).toBe('create');
    expect(args.path).toBe('/workflows/wf/revisions/workflow-r3.json');
  });

  it('is a no-op when the existing snapshot matches in-memory content', async () => {
    const wf = { revision: 3, slug: 'wf', tasks: [{ taskId: 't' }] };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(wf) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: wf,
      actor: 'system:test',
    });
    expect(outcome).toBe('matched');
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('treats whitespace-only differences as a match (deep-equal semantics)', async () => {
    const wf = { revision: 3, slug: 'wf', tasks: [{ taskId: 't' }] };
    // Pretty-printed prior document with extra whitespace
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(wf, null, 4) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: wf,
      actor: 'system:test',
    });
    expect(outcome).toBe('matched');
  });

  it('throws WorkflowRevisionDriftError when existing snapshot content differs', async () => {
    const wf = { revision: 3, slug: 'wf', tasks: [{ taskId: 'a' }] };
    const existingDifferent = { revision: 3, slug: 'wf', tasks: [{ taskId: 'b' }] };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(existingDifferent) });

    await expect(
      ensureWorkflowRevisionSnapshot({
        docRepo: makeDocRepo(),
        slug: 'wf',
        revision: 3,
        spaceId: 'space-1',
        workflow: wf,
        actor: 'system:test',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionDriftError);
  });

  it('throws WorkflowRevisionDriftError when existing snapshot is unparseable', async () => {
    mockGetByPath2.mockResolvedValue({ inlineContent: '{not valid json' });
    await expect(
      ensureWorkflowRevisionSnapshot({
        docRepo: makeDocRepo(),
        slug: 'wf',
        revision: 3,
        spaceId: 'space-1',
        workflow: { revision: 3 },
        actor: 'system:test',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionDriftError);
  });

  it('on TOCTOU collision, re-reads and returns matched if the racer wrote identical content', async () => {
    const wf = { revision: 3, tasks: [] };
    // First read: absent. put throws. Second read: identical content present.
    mockGetByPath2.mockResolvedValueOnce(null);
    mockPut.mockRejectedValueOnce(new Error('MEMORY_ALREADY_EXISTS'));
    mockGetByPath2.mockResolvedValueOnce({ inlineContent: JSON.stringify(wf) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: wf,
      actor: 'system:test',
    });
    expect(outcome).toBe('matched');
  });

  it('on TOCTOU collision with different content, raises drift', async () => {
    const wf = { revision: 3, tasks: [{ taskId: 'a' }] };
    const racer = { revision: 3, tasks: [{ taskId: 'b' }] };
    mockGetByPath2.mockResolvedValueOnce(null);
    mockPut.mockRejectedValueOnce(new Error('MEMORY_ALREADY_EXISTS'));
    mockGetByPath2.mockResolvedValueOnce({ inlineContent: JSON.stringify(racer) });

    await expect(
      ensureWorkflowRevisionSnapshot({
        docRepo: makeDocRepo(),
        slug: 'wf',
        revision: 3,
        spaceId: 'space-1',
        workflow: wf,
        actor: 'system:test',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionDriftError);
  });

  it('treats budget-only diff as a match (metadata is not part of drift)', async () => {
    const persisted = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      budget: { maxRuns: 30 },
    };
    const current = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      budget: { maxRuns: 35 },
    };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(persisted) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: current,
      actor: 'system:test',
    });
    expect(outcome).toBe('matched');
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('treats diffs across all metadata fields as a match', async () => {
    const persisted = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      name: 'Old Name',
      description: 'old',
      assignedAgent: 'agent-a',
      taskAssignments: { t: 'agent-a' },
      budget: { maxRuns: 30 },
      status: 'approved',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const current = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      name: 'New Name',
      description: 'new',
      assignedAgent: 'agent-b',
      taskAssignments: { t: 'agent-b' },
      budget: { maxRuns: 50 },
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(persisted) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: current,
      actor: 'system:test',
    });
    expect(outcome).toBe('matched');
  });

  it('still throws drift when definition differs even if metadata also differs', async () => {
    const persisted = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 'a' }],
      budget: { maxRuns: 30 },
    };
    const current = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 'b' }],
      budget: { maxRuns: 35 },
    };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(persisted) });

    await expect(
      ensureWorkflowRevisionSnapshot({
        docRepo: makeDocRepo(),
        slug: 'wf',
        revision: 3,
        spaceId: 'space-1',
        workflow: current,
        actor: 'system:test',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionDriftError);
  });

  it('throws drift when an identity field (slug) differs', async () => {
    const persisted = { revision: 3, slug: 'wf-old', tasks: [{ taskId: 't' }] };
    const current = { revision: 3, slug: 'wf-new', tasks: [{ taskId: 't' }] };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(persisted) });

    await expect(
      ensureWorkflowRevisionSnapshot({
        docRepo: makeDocRepo(),
        slug: 'wf-new',
        revision: 3,
        spaceId: 'space-1',
        workflow: current,
        actor: 'system:test',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionDriftError);
  });

  // onDrift: 'overwrite' — for platform-origin workflows where the in-code
  // registry is the source of truth and a stale on-disk snapshot from a prior
  // run must not block new runs.
  it('overwrites on definition drift when onDrift=overwrite', async () => {
    const stale = { revision: 3, slug: 'wf', tasks: [{ taskId: 'old' }] };
    const current = { revision: 3, slug: 'wf', tasks: [{ taskId: 'new' }] };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(stale) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: current,
      actor: 'system:run-start',
      onDrift: 'overwrite',
    });

    expect(outcome).toBe('overwritten');
    expect(mockPut).toHaveBeenCalledOnce();
    const args = mockPut.mock.calls[0]![0] as { writeMode: string; inlineContent: string };
    expect(args.writeMode).toBe('upsert');
    expect(args.inlineContent).toContain('"taskId": "new"');
  });

  it('overwrites on unparseable existing snapshot when onDrift=overwrite', async () => {
    mockGetByPath2.mockResolvedValue({ inlineContent: '{not valid json' });
    const current = { revision: 3, slug: 'wf', tasks: [{ taskId: 't' }] };

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: current,
      actor: 'system:run-start',
      onDrift: 'overwrite',
    });

    expect(outcome).toBe('overwritten');
    expect(mockPut).toHaveBeenCalledOnce();
  });

  it('still returns matched (not overwritten) when essence matches under onDrift=overwrite', async () => {
    const persisted = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      budget: { maxRuns: 30 },
    };
    const current = {
      revision: 3,
      slug: 'wf',
      tasks: [{ taskId: 't' }],
      budget: { maxRuns: 99 },
    };
    mockGetByPath2.mockResolvedValue({ inlineContent: JSON.stringify(persisted) });

    const outcome = await ensureWorkflowRevisionSnapshot({
      docRepo: makeDocRepo(),
      slug: 'wf',
      revision: 3,
      spaceId: 'space-1',
      workflow: current,
      actor: 'system:run-start',
      onDrift: 'overwrite',
    });

    expect(outcome).toBe('matched');
    expect(mockPut).not.toHaveBeenCalled();
  });
});
