import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StagedChange } from '@aflow/schemas';

const executeStoreInstall = vi.hoisted(() => vi.fn());

vi.mock('../store/storeInstallExecution.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, executeStoreInstall };
});

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const { applyStoreInstallOps } = await import('../stagedChange/storeInstallApply.js');
const { applyRatifiedOps, RatificationApplyError } =
  await import('../stagedChange/applyRatifiedOps.js');

// ============================================================================
// Fixtures
// ============================================================================

const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  spaceId: '00000000-0000-0000-0000-000000000010',
  db: {} as never,
  actorUserId: '00000000-0000-4000-8000-0000000000aa',
};

function makeProposal(over: Partial<StagedChange> = {}): StagedChange {
  return {
    id: '00000000-0000-0000-0000-000000000aaa',
    kind: 'store_install',
    source: 'bind_capability',
    status: 'proposed',
    proposal: {
      summary: 'Install the GitHub integration from the store',
      rationale: 'unit test',
      confidence: 'high',
      ops: [
        {
          op: 'store_install',
          catalogId: 'github',
          expectedVersion: 3,
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
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-05-13T00:00:00.000Z',
    expiresAt: '2026-05-20T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-000000000bbb',
    ...over,
  } as StagedChange;
}

function installedResponse() {
  return {
    ok: true as const,
    response: {
      result: {
        kind: 'connector',
        sourceKind: 'api',
        integrationId: 'github',
        bindingId: 'github-default',
        status: 'needs_credentials',
        missingVariables: [],
        missingCredentialKeys: ['github-default-token'],
      },
      setupChecklist: [],
      install: { catalogId: 'github' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeStoreInstall.mockResolvedValue(installedResponse());
});

// ============================================================================
// Tests
// ============================================================================

describe('applyStoreInstallOps', () => {
  it('ratify runs the shared install execution with the pinned version and the proposal id as idempotency key', async () => {
    const sc = makeProposal();
    const result = await applyStoreInstallOps(ctx, sc);

    expect(result).toEqual({ applied: true, appliedOps: ['store_install'], skippedOps: [] });
    expect(executeStoreInstall).toHaveBeenCalledTimes(1);
    expect(executeStoreInstall).toHaveBeenCalledWith({
      db: ctx.db,
      redis: null,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      actorUserId: ctx.actorUserId,
      catalogId: 'github',
      expectedVersion: 3,
      idempotencyKey: sc.id,
    });
  });

  it('passes the context redis through to the execution (invalidations + idempotency)', async () => {
    const redis = { set: vi.fn() } as never;
    await applyStoreInstallOps({ ...ctx, redis }, makeProposal());
    expect(executeStoreInstall.mock.calls[0]?.[0]).toMatchObject({ redis });
  });

  it("threads the install's setup checklist onto the apply result", async () => {
    const checklist = [
      {
        kind: 'fill_credentials',
        bindingId: 'github-default',
        description: 'Paste your GitHub token',
        slots: [{ role: 'token', label: 'API token', credentialKey: 'github-default-token' }],
      },
    ];
    const response = installedResponse();
    response.response.setupChecklist = checklist as never;
    executeStoreInstall.mockResolvedValue(response);

    const result = await applyStoreInstallOps(ctx, makeProposal());
    expect(result.setupChecklist).toEqual(checklist);
  });

  it('omits setupChecklist from the apply result when the install has no setup tasks', async () => {
    const result = await applyStoreInstallOps(ctx, makeProposal());
    expect('setupChecklist' in result).toBe(false);
  });

  it('a listing that changed since propose surfaces CATALOG_CHANGED as a ratify failure', async () => {
    executeStoreInstall.mockResolvedValue({
      ok: false,
      statusCode: 409,
      body: {
        error:
          "Listing 'github' changed since preview (expected version 3, current 4). Re-preview and retry.",
        code: 'CATALOG_CHANGED',
        catalogId: 'github',
        expectedVersion: 3,
        currentVersion: 4,
      },
    });

    const err = await applyStoreInstallOps(ctx, makeProposal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RatificationApplyError);
    const applyErr = err as InstanceType<typeof RatificationApplyError>;
    expect(applyErr.reason).toBe('target_skill_missing');
    expect(applyErr.detail).toContain('changed since preview');
  });

  it('a vanished listing surfaces as a permanent ratify failure', async () => {
    executeStoreInstall.mockResolvedValue({
      ok: false,
      statusCode: 404,
      body: { error: "Store listing 'github' not found" },
    });
    const err = await applyStoreInstallOps(ctx, makeProposal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RatificationApplyError);
    expect((err as InstanceType<typeof RatificationApplyError>).reason).toBe(
      'target_skill_missing',
    );
  });

  it('an in-progress store mutation surfaces as a transient (retryable) failure', async () => {
    executeStoreInstall.mockResolvedValue({
      ok: false,
      statusCode: 409,
      body: {
        error: 'Another store mutation is in progress for this space. Retry shortly.',
        code: 'STORE_MUTATION_IN_PROGRESS',
      },
    });
    const err = await applyStoreInstallOps(ctx, makeProposal()).catch((e: unknown) => e);
    expect((err as InstanceType<typeof RatificationApplyError>).reason).toBe('transient');
  });

  it('rejects a proposal that does not carry exactly one store_install op without installing', async () => {
    const sc = makeProposal();
    sc.proposal.ops = [
      ...sc.proposal.ops,
      { op: 'flag_pattern', patternDescription: 'extra' } as never,
    ];
    const err = await applyStoreInstallOps(ctx, sc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RatificationApplyError);
    expect((err as InstanceType<typeof RatificationApplyError>).reason).toBe('post_validation');
    expect(executeStoreInstall).not.toHaveBeenCalled();
  });
});

describe('applyRatifiedOps — store_install dispatch', () => {
  it("dispatches kind 'store_install' to the store-install handler", async () => {
    const result = await applyRatifiedOps(ctx, makeProposal());
    expect(result.applied).toBe(true);
    expect(result.appliedOps).toEqual(['store_install']);
    expect(executeStoreInstall).toHaveBeenCalledTimes(1);
  });
});
