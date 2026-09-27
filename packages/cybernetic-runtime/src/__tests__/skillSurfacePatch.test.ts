import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetByPath = vi.fn();
const mockPut = vi.fn();
const mockEnsureSnapshot = vi.fn();
const mockResolveSkill = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  const txRepo = { getByPath: mockGetByPath, put: mockPut };
  return {
    ...actual,
    createMemoryDocRepository: () => ({
      withTransaction: (fn: (r: unknown) => unknown) => fn(txRepo),
    }),
    ensureWorkflowRevisionSnapshot: (...a: unknown[]) => mockEnsureSnapshot(...a),
  };
});
vi.mock('../skill.js', async () => {
  const actual = await vi.importActual<typeof import('../skill.js')>('../skill.js');
  return { ...actual, resolveSkillForWorkflow: (...a: unknown[]) => mockResolveSkill(...a) };
});

const { applySkillSurfacePatch } = await import('../skillSurfacePatch.js');
const { manifestAuthoringToken } = await import('../skillAuthoringSnapshot.js');

const CTX = {
  db: {} as never,
  tenantId: '00000000-0000-4000-8000-000000000001',
  spaceId: 'space-1',
};

function baseWorkflow(revision: number): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-0000000000ff',
    slug: 'my-skill',
    name: 'My Skill',
    outcomes: [{ id: 'o', name: 'O', evaluator: { type: 'manual', instruction: 'done' } }],
    mode: 'process',
    tasks: [{ taskId: 'step-1', name: 'Step 1', goal: 'do it', type: 'agent' }],
    iteration: {},
    revision,
    status: 'approved',
    origin: 'operator',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A workflow whose outcome carries a `$campaign` ref — invalid unless the
 *  skill's campaign contract (in the manifest) is loaded for validation. */
function campaignWorkflow(revision: number): Record<string, unknown> {
  return {
    ...baseWorkflow(revision),
    outcomes: [
      {
        id: 'o',
        name: 'O',
        evaluator: {
          type: 'threshold',
          metric: 'score',
          operator: 'gte',
          target: { $campaign: 'targetScore' },
        },
      },
    ],
  };
}

function manifestObj(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skillId: 'my-skill',
    name: 'My Skill',
    goal: { type: 'subjective', rubric: ['be good'] },
    origin: 'operator',
    workflowSlug: 'my-skill',
    campaign: { fields: { targetScore: { schema: { type: 'number' }, label: 'Target' } } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const doc = (content: Record<string, unknown>) => ({ inlineContent: JSON.stringify(content) });

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSkill.mockResolvedValue(null);
});

describe('applySkillSurfacePatch — guards', () => {
  it('422s an empty patch before opening a transaction', async () => {
    const r = await applySkillSurfacePatch(CTX, { slug: 'my-skill', tokens: {} });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'empty_patch' });
    expect(mockGetByPath).not.toHaveBeenCalled();
  });

  it('rejects a platform-owned slug', async () => {
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'compose-skill',
      tokens: {},
      workflow: baseWorkflow(1),
    });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'platform_artifact_read_only' });
    expect(mockGetByPath).not.toHaveBeenCalled();
  });

  it('404s when the workflow doc is absent', async () => {
    mockGetByPath.mockResolvedValue(null);
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { workflowRevision: 1 },
      workflow: baseWorkflow(1),
    });
    expect(r).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });
});

describe('applySkillSurfacePatch — workflow edit', () => {
  it('409s (stale) when the workflow revision moved', async () => {
    mockGetByPath.mockResolvedValue(doc(baseWorkflow(5)));
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { workflowRevision: 3 },
      workflow: baseWorkflow(3),
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'stale' });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('saves a graph edit: bumps revision, preserves identity', async () => {
    mockGetByPath.mockResolvedValue(doc(baseWorkflow(5)));
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { workflowRevision: 5 },
      workflow: { ...baseWorkflow(5), name: 'Renamed', id: 'client-id-ignored' },
    });
    expect(r).toMatchObject({ ok: true, newRevision: 6 });
    const written = JSON.parse(mockPut.mock.calls[0]![0].inlineContent);
    expect(written.revision).toBe(6);
    expect(written.name).toBe('Renamed');
    expect(written.id).toBe('00000000-0000-4000-8000-0000000000ff');
  });

  it('validates a workflow-only edit against the EXISTING campaign contract (regression)', async () => {
    // A campaign skill: contract lives in the manifest, a $campaign ref in the
    // workflow. A workflow-only save must load the manifest for validation, or
    // every ref is spuriously flagged unknown.
    mockResolveSkill.mockResolvedValue({
      manifest: { skillId: 'my-skill', workflowSlug: 'my-skill' },
    });
    mockGetByPath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('/skills/') ? doc(manifestObj()) : doc(campaignWorkflow(5))),
    );
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { workflowRevision: 5 },
      workflow: { ...campaignWorkflow(5), name: 'Tweaked' },
    });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('applySkillSurfacePatch — manifest edit', () => {
  beforeEach(() => {
    mockResolveSkill.mockResolvedValue({
      manifest: { skillId: 'my-skill', workflowSlug: 'my-skill' },
    });
    mockGetByPath.mockImplementation((path: string) =>
      Promise.resolve(path.includes('/skills/') ? doc(manifestObj()) : doc(baseWorkflow(5))),
    );
  });

  it('409s (stale) when the manifest hash moved', async () => {
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { manifestHash: 'stale-hash' },
      manifest: { goal: { type: 'subjective', rubric: ['new'] } },
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'stale' });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('saves a goal edit and writes the manifest doc', async () => {
    const currentToken = manifestAuthoringToken(manifestObj() as never);
    const r = await applySkillSurfacePatch(CTX, {
      slug: 'my-skill',
      tokens: { manifestHash: currentToken },
      manifest: { goal: { type: 'subjective', rubric: ['sharper goal'] } },
    });
    expect(r).toMatchObject({ ok: true });
    const manifestPut = mockPut.mock.calls.find((c) => c[0].path.includes('/skills/'));
    expect(manifestPut).toBeDefined();
    const written = JSON.parse(manifestPut![0].inlineContent);
    expect(written.goal.rubric).toEqual(['sharper goal']);
    expect(written.skillId).toBe('my-skill'); // server field preserved
  });
});
