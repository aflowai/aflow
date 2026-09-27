import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PostInstallTask, TenantId } from '@aflow/schemas';

const applyRatifiedOps = vi.hoisted(() => vi.fn());

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, applyRatifiedOps };
});

const docs = vi.hoisted(() => ({
  byPath: new Map<string, string>(),
  puts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => ({
      getByPath: async (path: string) => {
        const inlineContent = docs.byPath.get(path);
        return inlineContent ? { inlineContent } : null;
      },
      put: async (doc: Record<string, unknown>) => {
        docs.puts.push(doc);
      },
    }),
  };
});

const { PROPOSAL_DIRS } = await import('@aflow/cybernetic-runtime');
const { ratifyProposal } = await import('../proposalResolution.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-000000000010';
const PROPOSAL_ID = '00000000-0000-4000-8000-000000000aaa';

const STORE_INSTALL_PROPOSAL = {
  id: PROPOSAL_ID,
  kind: 'store_install',
  source: 'bind_capability',
  status: 'proposed',
  proposal: {
    summary: 'Install from Store: GitHub',
    rationale: 'unit test',
    confidence: 'high',
    ops: [
      {
        op: 'store_install',
        catalogId: 'github',
        expectedVersion: 1,
        listing: {
          name: 'GitHub',
          kind: 'connector',
          tagline: 'Repos, issues, and pull requests',
          requirements: {
            credentialKeys: ['github-default-token'],
            oauthIssuers: [],
            needsRepo: false,
            needsModelKey: false,
          },
        },
      },
    ],
  },
  evidence: { sourceSessionIds: ['00000000-0000-4000-8000-000000000ccc'] },
  authorityLevel: 'require_operator',
  resolutionRoute: 'tenant_ratification',
  proposedAt: '2026-05-13T00:00:00.000Z',
  expiresAt: '2026-05-20T00:00:00.000Z',
  coachSessionId: '00000000-0000-4000-8000-000000000bbb',
};

const CHECKLIST: PostInstallTask[] = [
  {
    kind: 'fill_credentials',
    bindingId: 'github-default',
    description: 'Paste your GitHub token',
    slots: [{ role: 'token', label: 'API token', credentialKey: 'github-default-token' }],
  } as PostInstallTask,
];

const deps = { db: {} as never, redis: null };
const ctx = { tenantId: TENANT_ID, spaceId: SPACE_ID, resolvedBy: 'operator' };

beforeEach(() => {
  vi.clearAllMocks();
  docs.byPath = new Map([
    [`${PROPOSAL_DIRS[0]}/${PROPOSAL_ID}.json`, JSON.stringify(STORE_INSTALL_PROPOSAL)],
  ]);
  docs.puts = [];
  applyRatifiedOps.mockResolvedValue({
    applied: true,
    appliedOps: ['store_install'],
    skippedOps: [],
  });
});

describe('ratifyProposal — setup checklist passthrough', () => {
  it("returns the apply result's setup checklist on the ratify success", async () => {
    applyRatifiedOps.mockResolvedValue({
      applied: true,
      appliedOps: ['store_install'],
      skippedOps: [],
      setupChecklist: CHECKLIST,
    });

    const result = await ratifyProposal(deps, ctx, PROPOSAL_ID);
    expect(result).toMatchObject({ ok: true, status: 'ratified', stagedChangeId: PROPOSAL_ID });
    if (!result.ok) throw new Error('expected success');
    expect(result.setupChecklist).toEqual(CHECKLIST);
    expect(docs.puts.at(-1)).toMatchObject({ inlineContent: expect.stringContaining('ratified') });
  });

  it('omits setupChecklist when the apply carries none', async () => {
    const result = await ratifyProposal(deps, ctx, PROPOSAL_ID);
    expect(result.ok).toBe(true);
    expect('setupChecklist' in result).toBe(false);
  });
});
