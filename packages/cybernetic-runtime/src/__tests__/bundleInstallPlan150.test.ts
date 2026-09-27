import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillBundle, SkillBundleId, SkillManifest } from '@aflow/schemas';

// ============================================================================
// Mock state
// ============================================================================

const mockDocs = new Map<string, string>();
const txQueue: Array<unknown[]> = [];
const capturedManifests: SkillManifest[] = [];

function pushTxResults(...rowSets: unknown[][]): void {
  for (const set of rowSets) txQueue.push(set);
}

// ============================================================================
// Mocks (mirror the ones in skillBundleInstall.test.ts; tx.execute is

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: () => ({ schema: 'test' }),
    createMemoryDocRepository: () => {
      const repo = {
        getByPath: async (path: string) => {
          const content = mockDocs.get(path);
          if (content === undefined) return null;
          return { inlineContent: content, path, deletedAt: null };
        },
        put: async (opts: { path: string; inlineContent: string; docType?: string }) => {
          mockDocs.set(opts.path, opts.inlineContent);
          // Minimal MemoryDoc shape for commitDerivedIndexes. indexingMode
          // 'disabled' short-circuits chunk/embedding derivation so the mock
          // needs only the link/property stubs below.
          return {
            id: `doc:${opts.path}`,
            path: opts.path,
            spaceId: SPACE,
            docType: opts.docType ?? 'markdown',
            currentVersion: 1,
            indexingMode: 'disabled' as const,
            contentHash: null,
          };
        },
        updateDerivedFields: async () => {},
        withTransaction: async <T>(
          fn: (txRepo: unknown, txLinkRepo: unknown) => Promise<T>,
        ): Promise<T> => fn(repo, linkRepo),
      };
      const linkRepo = {
        replaceLinksForDoc: async () => {},
        getOutgoingLinks: async () => [] as Array<{ targetPath: string; resolved: boolean }>,
        countBacklinks: async () => 0,
      };
      return repo;
    },
    withTenantSchema: async <T>(
      _db: unknown,
      _tenantCtx: unknown,
      callback: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const snapshot = new Map(mockDocs);
      const queueSnapshot = txQueue.slice();
      const manifestSnapshot = capturedManifests.slice();
      const mockTx = {
        execute: async () => {
          const next = txQueue.shift();
          return (next ?? []) as never[];
        },
      };
      try {
        return await callback(mockTx);
      } catch (err) {
        // Simulate PG rollback: restore the pre-tx snapshots.
        mockDocs.clear();
        for (const [k, v] of snapshot) mockDocs.set(k, v);
        txQueue.length = 0;
        for (const q of queueSnapshot) txQueue.push(q);
        capturedManifests.length = 0;
        capturedManifests.push(...manifestSnapshot);
        throw err;
      }
    },
  };
});

vi.mock('../skill.js', () => ({
  upsertSkillManifest: async (_ctx: unknown, manifest: SkillManifest) => {
    capturedManifests.push(manifest);
    mockDocs.set(`/skills/${manifest.skillId}/manifest.json`, JSON.stringify(manifest));
  },
}));

vi.mock('../skillProjectionReconciler.js', () => ({
  rebuildSkillProjection: async (_ctx: unknown, skillId: string) => {
    mockDocs.set(`/skills/${skillId}/projection.json`, JSON.stringify({ skillId }));
    return null;
  },
  checkMissingCapabilities: async () => [],
}));

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { installSkillBundle, BundleInstallValidationError } =
  await import('../stagedChange/skillBundleInstall.js');

// ============================================================================
// Test helpers
// ============================================================================

const SPACE = '00000000-0000-0000-0000-000000000001';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ctx = { db: {}, tenantId: TENANT, spaceId: SPACE };

beforeEach(() => {
  mockDocs.clear();
  txQueue.length = 0;
  capturedManifests.length = 0;
});

function mkBundle(overrides: Partial<SkillBundle> = {}): SkillBundle {
  return {
    bundleId: 'p150-bundle' as SkillBundleId,
    version: 1,
    name: 'P150 Bundle',
    tagline: 'P150',
    description: 'P150',
    tags: [],
    skillCatalogIds: [],
    prerequisiteBundleIds: [],
    apiDefinitions: [],
    apiBindingTemplates: [],
    memorySeed: [],
    helmsmanHints: [],
    ...overrides,
  } as SkillBundle;
}

function mkApiDef(apiId = 'p150-api', authKind: 'bearer' | 'basic' | 'none' = 'bearer') {
  return {
    apiId,
    definition: {
      name: apiId,
      baseUrl: 'https://api.example.com',
      authKind,
      endpoints: [{ path: '/v1/x', method: 'GET' as const, summary: 'X' }],
    },
    conflictPolicy: 'skip' as const,
  };
}

function mkBearerTpl(bindingId = 'p150-binding', apiId = 'p150-api') {
  return {
    bindingId,
    apiId,
    name: bindingId,
    authShape: { type: 'bearer' as const },
    credentialSlots: [
      {
        authField: 'credentialKey',
        credentialKey: `${bindingId}-token`,
        role: 'token' as const,
        label: 'Token',
      },
    ],
    egressPolicy: { allowedHosts: ['api.example.com'] },
    conflictPolicy: 'skip' as const,
  };
}

// ============================================================================
// Tests — installable-unit content fan-out
// ============================================================================

describe('Plan 150 Phase 2 — installable-unit content fan-out', () => {
  it('writes api definition + placeholder binding and emits installed* ids', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('alpaca-account-read')],
      apiBindingTemplates: [mkBearerTpl('alpaca-account-read-default', 'alpaca-account-read')],
    });
    // SQL trace:
    //  1) advisory lock                                            -> acquired
    //  2) apiDef INSERT … RETURNING api_id (skip → inserted)       -> [{api_id}]
    //  3) binding INSERT … RETURNING binding_id (skip → inserted)  -> [{binding_id}]
    //  4) manifest SELECT api_bindings                             -> the new row's auth_json
    //  5) manifest SELECT api_credentials                          -> empty (credentials unfilled)
    pushTxResults(
      [{ acquired: true }],
      [{ api_id: 'alpaca-account-read' }],
      [{ binding_id: 'alpaca-account-read-default' }],
      [
        {
          binding_id: 'alpaca-account-read-default',
          auth_json: { type: 'bearer', credentialKey: 'alpaca-account-read-default-token' },
        },
      ],
      [],
    );

    const result = await installSkillBundle(ctx, bundle);

    expect(result.installedApiDefinitionIds).toEqual(['alpaca-account-read']);
    expect(result.skippedApiDefinitionIds).toEqual([]);
    expect(result.installedBindingIds).toEqual(['alpaca-account-read-default']);
    expect(result.skippedBindingIds).toEqual([]);
    expect(result.stateChanged).toBe(true);
  });

  it('reports skipped when the helper returns no RETURNING rows (already-exists)', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('alpaca-account-read')],
      apiBindingTemplates: [mkBearerTpl('alpaca-account-read-default', 'alpaca-account-read')],
    });
    // Empty RETURNING → ON CONFLICT DO NOTHING fired.
    pushTxResults(
      [{ acquired: true }],
      [], // apiDef INSERT skipped
      [], // binding INSERT skipped
      [], // manifest SELECT bindings: nothing to manifest
      [], // manifest SELECT credentials
    );

    const result = await installSkillBundle(ctx, bundle);

    expect(result.installedApiDefinitionIds).toEqual([]);
    expect(result.skippedApiDefinitionIds).toEqual(['alpaca-account-read']);
    expect(result.installedBindingIds).toEqual([]);
    expect(result.skippedBindingIds).toEqual(['alpaca-account-read-default']);
    expect(result.stateChanged).toBe(false);
  });
});

// ============================================================================
// Tests — postInstallManifest
// ============================================================================

describe('Plan 150 Phase 2 — postInstallManifest generation', () => {
  it('emits fill_credentials when binding has unfilled credentialKey slots', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('p150-api')],
      apiBindingTemplates: [mkBearerTpl('p150-default', 'p150-api')],
    });
    pushTxResults(
      [{ acquired: true }],
      [{ api_id: 'p150-api' }],
      [{ binding_id: 'p150-default' }],
      [
        {
          binding_id: 'p150-default',
          auth_json: { type: 'bearer', credentialKey: 'p150-default-token' },
        },
      ],
      [], // credentials lookup empty → token slot unfilled
    );

    const result = await installSkillBundle(ctx, bundle);

    expect(result.postInstallManifest).toHaveLength(1);
    const entry = result.postInstallManifest[0];
    expect(entry?.kind).toBe('fill_credentials');
    if (entry?.kind === 'fill_credentials') {
      expect(entry.bindingId).toBe('p150-default');
      expect(entry.slots).toHaveLength(1);
      expect(entry.slots[0]?.role).toBe('token');
      expect(entry.required).toBe(true);
    }
  });

  it('omits fill_credentials when all credentialKeys are present', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('p150-api')],
      apiBindingTemplates: [mkBearerTpl('p150-default', 'p150-api')],
    });
    pushTxResults(
      [{ acquired: true }],
      [{ api_id: 'p150-api' }],
      [{ binding_id: 'p150-default' }],
      [
        {
          binding_id: 'p150-default',
          auth_json: { type: 'bearer', credentialKey: 'p150-default-token' },
        },
      ],
      [{ credential_key: 'p150-default-token' }], // credential present → no slot unfilled
    );

    const result = await installSkillBundle(ctx, bundle);
    expect(result.postInstallManifest).toEqual([]);
  });

  it('idempotent re-install regenerates manifest from current state (UI refresh survives)', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('p150-api')],
      apiBindingTemplates: [mkBearerTpl('p150-default', 'p150-api')],
    });

    // First install — rows freshly inserted; manifest carries fill_credentials.
    pushTxResults(
      [{ acquired: true }],
      [{ api_id: 'p150-api' }],
      [{ binding_id: 'p150-default' }],
      [
        {
          binding_id: 'p150-default',
          auth_json: { type: 'bearer', credentialKey: 'p150-default-token' },
        },
      ],
      [],
    );
    const first = await installSkillBundle(ctx, bundle);
    expect(first.installedBindingIds).toEqual(['p150-default']);
    expect(first.postInstallManifest).toHaveLength(1);

    // Second install — rows already present (RETURNING empty); BUT manifest
    // generation still queries current state and still surfaces the
    // outstanding credential slot. stateChanged=false signals "no writes
    // happened" while manifest signals "work still outstanding".
    pushTxResults(
      [{ acquired: true }],
      [], // apiDef skipped
      [], // binding skipped
      [
        {
          binding_id: 'p150-default',
          auth_json: { type: 'bearer', credentialKey: 'p150-default-token' },
        },
      ],
      [],
    );
    const second = await installSkillBundle(ctx, bundle);
    expect(second.installedBindingIds).toEqual([]);
    expect(second.skippedBindingIds).toEqual(['p150-default']);
    expect(second.stateChanged).toBe(false);
    expect(second.postInstallManifest).toHaveLength(1);
    expect(second.postInstallManifest[0]?.kind).toBe('fill_credentials');
  });
});

// ============================================================================
// Tests — helmsmanHints passthrough
// ============================================================================

describe('Plan 150 Phase 2 — helmsmanHints', () => {
  it('passes helmsmanHints[] through to the install result verbatim', async () => {
    const bundle = mkBundle({
      helmsmanHints: [
        'Set your actual exposure limits in `policy/portfolio.md`.',
        'Run `manage-portfolio` once to bootstrap holdings.',
      ],
    });
    pushTxResults([{ acquired: true }]);

    const result = await installSkillBundle(ctx, bundle);

    expect(result.helmsmanHints).toEqual([
      'Set your actual exposure limits in `policy/portfolio.md`.',
      'Run `manage-portfolio` once to bootstrap holdings.',
    ]);
  });

  it('defaults to empty array when bundle does not declare hints', async () => {
    const bundle = mkBundle();
    pushTxResults([{ acquired: true }]);

    const result = await installSkillBundle(ctx, bundle);
    expect(result.helmsmanHints).toEqual([]);
  });
});

// ============================================================================
// Tests — memorySeed seedPolicy
// ============================================================================

describe('Plan 150 Phase 2 — memorySeed seedPolicy', () => {
  it('skip: existing doc untouched; seed counted as skipped', async () => {
    mockDocs.set('docs/existing.md', '# Pre-existing content');
    const bundle = mkBundle({
      memorySeed: [
        {
          path: 'docs/existing.md',
          content: '# Seeded content',
          docType: 'markdown',
          seedPolicy: 'skip' as const,
        },
      ],
    });
    pushTxResults([{ acquired: true }]);

    const result = await installSkillBundle(ctx, bundle);

    expect(result.skippedMemoryDocPaths).toEqual(['docs/existing.md']);
    expect(result.installedMemoryDocPaths).toEqual([]);
    expect(mockDocs.get('docs/existing.md')).toBe('# Pre-existing content');
  });

  it('overwrite: existing doc replaced; seed counted as installed', async () => {
    mockDocs.set('docs/existing.md', '# Pre-existing content');
    const bundle = mkBundle({
      memorySeed: [
        {
          path: 'docs/existing.md',
          content: '# Seeded content',
          docType: 'markdown',
          seedPolicy: 'overwrite' as const,
        },
      ],
    });
    pushTxResults([{ acquired: true }]);

    const result = await installSkillBundle(ctx, bundle);

    expect(result.installedMemoryDocPaths).toEqual(['docs/existing.md']);
    expect(mockDocs.get('docs/existing.md')).toBe('# Seeded content');
  });

  it('merge_frontmatter: warns + skips while the policy has no implementation', async () => {
    mockDocs.set('docs/existing.md', '# Pre-existing');
    const bundle = mkBundle({
      memorySeed: [
        {
          path: 'docs/existing.md',
          content: '# Seeded',
          docType: 'markdown',
          seedPolicy: 'merge_frontmatter' as const,
        },
      ],
    });
    pushTxResults([{ acquired: true }]);

    const result = await installSkillBundle(ctx, bundle);

    expect(result.skippedMemoryDocPaths).toEqual(['docs/existing.md']);
    expect(result.warnings.some((w) => /merge_frontmatter/.test(w))).toBe(true);
  });
});

// ============================================================================
// Tests — validation error surfaces (integration with the validator)
// ============================================================================

describe('Plan 150 Phase 2 — install-time validation error surfaces', () => {
  it('throws BundleInstallValidationError when a binding references an unresolved apiId', async () => {
    const bundle = mkBundle({
      // Binding template points at api that the bundle does not declare and
      // is not in any prereq → validator's (d) check rejects.
      apiBindingTemplates: [mkBearerTpl('orphan-default', 'orphan-api')],
    });
    pushTxResults([{ acquired: true }]);

    await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(BundleInstallValidationError);
  });

  it('throws BundleInstallValidationError when authShape does not match authKind', async () => {
    const bundle = mkBundle({
      apiDefinitions: [mkApiDef('mismatch-api', 'basic')],
      apiBindingTemplates: [mkBearerTpl('mismatch-default', 'mismatch-api')],
    });
    pushTxResults([{ acquired: true }]);

    await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(BundleInstallValidationError);
  });
});
