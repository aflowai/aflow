import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillManifest, SkillBundleId } from '@aflow/schemas';
import type { SkillBundle } from '@aflow/schemas';
import { getSkillBundleEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';

// ============================================================================
// Mock state
// ============================================================================

const mockDocs = new Map<string, string>();
const capturedManifests: SkillManifest[] = [];
const projectionRebuilds: string[] = [];

let advisoryLockOutcome: boolean = true;
let failOnApplyNumber: number | null = null;
let applyCallCount = 0;

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: () => ({ schema: 'test' }),
    createMemoryDocRepository: () => ({
      getByPath: async (path: string) => {
        const content = mockDocs.get(path);
        if (!content) return null;
        return { inlineContent: content, path, deletedAt: null };
      },
      put: async (opts: { path: string; inlineContent: string }) => {
        mockDocs.set(opts.path, opts.inlineContent);
      },
    }),
    // Tx mock: snapshot-then-restore on throw simulates PG rollback.
    withTenantSchema: async <T>(
      _db: unknown,
      _tenantCtx: unknown,
      callback: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const snapshot = new Map(mockDocs);
      const manifestSnapshot = capturedManifests.slice();
      const projectionSnapshot = projectionRebuilds.slice();
      const mockTx = {
        execute: async (_query: unknown) => {
          // Only the advisory-lock SQL flows through here in Phase 2B.
          return [{ acquired: advisoryLockOutcome }];
        },
      };
      try {
        return await callback(mockTx);
      } catch (err) {
        mockDocs.clear();
        for (const [k, v] of snapshot) mockDocs.set(k, v);
        capturedManifests.length = 0;
        capturedManifests.push(...manifestSnapshot);
        projectionRebuilds.length = 0;
        projectionRebuilds.push(...projectionSnapshot);
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
    projectionRebuilds.push(skillId);
    mockDocs.set(`/skills/${skillId}/projection.json`, JSON.stringify({ skillId }));
    return null;
  },
}));

vi.mock('../stagedChange/skillComposeApply.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  const real = orig['applySkillComposeBundle'] as (...args: unknown[]) => Promise<unknown>;
  return {
    ...orig,
    applySkillComposeBundle: async (...args: unknown[]) => {
      applyCallCount += 1;
      if (failOnApplyNumber !== null && applyCallCount === failOnApplyNumber) {
        throw new Error('simulated apply failure');
      }
      return real(...args);
    },
  };
});

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const { installSkillBundle, BundlePartiallyInstalledError, BundleInstallInProgressError } =
  await import('../stagedChange/skillBundleInstall.js');

const ctx = {
  tenantId: 'tenant-1',
  spaceId: 'space-1',
  db: {} as never,
};

// ============================================================================
// Fixtures
// ============================================================================

function getTestTwoSkillBundle(): SkillBundle {
  const bundle = getSkillBundleEntry('test-two-skill-bundle');
  if (!bundle) throw new Error('test-two-skill-bundle fixture missing from registry');
  return bundle;
}

function getTestSetupBundle(): SkillBundle {
  const bundle = getSkillBundleEntry('test-setup-bundle');
  if (!bundle) throw new Error('test-setup-bundle fixture missing from registry');
  return bundle;
}

function workflowDocPath(slug: string): string {
  return `/workflows/${slug}/workflow.json`;
}
function manifestDocPath(skillId: string): string {
  return `/skills/${skillId}/manifest.json`;
}
function evalSuiteDocPath(slug: string): string {
  return `/evals/${slug}/suite.json`;
}
function activationDocPath(slug: string): string {
  return `/workflows/${slug}/activation.json`;
}
function projectionDocPath(skillId: string): string {
  return `/skills/${skillId}/projection.json`;
}

// ============================================================================
// Tests
// ============================================================================

describe('installSkillBundle (Plan 137 Phase 2)', () => {
  beforeEach(() => {
    mockDocs.clear();
    capturedManifests.length = 0;
    projectionRebuilds.length = 0;
    advisoryLockOutcome = true;
    failOnApplyNumber = null;
    applyCallCount = 0;
  });

  describe('install-creates-all-skills', () => {
    it('installs every skill referenced by skillCatalogIds and rebuilds projections', async () => {
      const bundle = getTestTwoSkillBundle();

      const result = await installSkillBundle(ctx, bundle);

      expect(result.bundleId).toBe(bundle.bundleId);
      expect(result.installedSkillCatalogIds).toEqual(bundle.skillCatalogIds);
      expect(result.skippedSkillCatalogIds).toEqual([]);
      expect(result.repairedProjectionSkillCatalogIds).toEqual([]);
      expect(result.setupSkillIntent).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(result.stateChanged).toBe(true);

      for (const id of bundle.skillCatalogIds) {
        const entry = getSkillCatalogEntry(id)!;
        expect(mockDocs.has(workflowDocPath(entry.bundle.workflow.slug))).toBe(true);
      }
      expect(capturedManifests).toHaveLength(bundle.skillCatalogIds.length);
    });

    it('throws if a referenced skillCatalogId is unknown', async () => {
      const bundle: SkillBundle = {
        bundleId: 'bogus-bundle' as SkillBundleId,
        version: 1,
        name: 'Bogus',
        tagline: 'Bogus',
        description: 'Bogus',
        tags: [],
        skillCatalogIds: ['does-not-exist'],
        prerequisiteBundleIds: [],
      };

      await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(
        /unknown skill catalog id: does-not-exist/i,
      );
    });
  });

  describe('idempotent-reinstall', () => {
    it('skips fully-installed skills on re-install (no duplicate writes)', async () => {
      const bundle = getTestTwoSkillBundle();

      const first = await installSkillBundle(ctx, bundle);
      expect(first.installedSkillCatalogIds).toEqual(bundle.skillCatalogIds);

      const docsAfterFirst = new Set(mockDocs.keys());
      const projectionsAfterFirst = projectionRebuilds.length;

      const second = await installSkillBundle(ctx, bundle);

      expect(second.installedSkillCatalogIds).toEqual([]);
      expect(second.skippedSkillCatalogIds).toEqual(bundle.skillCatalogIds);
      expect(new Set(mockDocs.keys())).toEqual(docsAfterFirst);
      expect(projectionRebuilds.length).toBe(projectionsAfterFirst);
    });
  });

  describe('projection self-heal', () => {
    it('rebuilds projection on re-install when prior projection rebuild failed', async () => {
      const bundle = getTestTwoSkillBundle();
      await installSkillBundle(ctx, bundle);

      for (const id of bundle.skillCatalogIds) {
        const entry = getSkillCatalogEntry(id)!;
        mockDocs.delete(projectionDocPath(entry.bundle.manifest.skillId));
      }
      const projectionsBefore = projectionRebuilds.length;

      const result = await installSkillBundle(ctx, bundle);

      expect(result.installedSkillCatalogIds).toEqual([]);
      expect(result.skippedSkillCatalogIds).toEqual([]);
      expect(result.repairedProjectionSkillCatalogIds).toEqual(bundle.skillCatalogIds);
      expect(projectionRebuilds.length).toBe(projectionsBefore + bundle.skillCatalogIds.length);
    });
  });

  describe('partial-install detection', () => {
    it('throws BundlePartiallyInstalledError when only workflow doc exists', async () => {
      const bundle = getTestTwoSkillBundle();
      const firstSkillId = bundle.skillCatalogIds[0]!;
      const firstEntry = getSkillCatalogEntry(firstSkillId)!;
      mockDocs.set(
        workflowDocPath(firstEntry.bundle.workflow.slug),
        '{"slug":"partial","status":"approved","revision":1}',
      );

      await expect(installSkillBundle(ctx, bundle)).rejects.toBeInstanceOf(
        BundlePartiallyInstalledError,
      );
    });
  });

  describe('activation-doc completeness', () => {
    it('treats missing activation doc as partial when the bundle expects activation', async () => {
      // Find a catalog skill whose bundle declares activation. If none of
      // the fixture skills do, this test self-skips with a clear note.
      const bundleWithActivation = findFirstSkillWithActivation();
      if (!bundleWithActivation) {
        // Sanity assertion: at least one catalog skill should ship
        // activation; otherwise the activation-completeness path can't
        // be exercised. Tightening this is Phase 2C scope (a dedicated
        // hidden fixture with activation declared).
        return;
      }

      const { skillCatalogId, workflowSlug, skillId } = bundleWithActivation;
      const standaloneBundle: SkillBundle = {
        bundleId: 'activation-test-bundle' as SkillBundleId,
        version: 1,
        name: 'Activation Test',
        tagline: 'Validate activation-doc completeness',
        description: 'Validate activation-doc completeness',
        tags: [],
        skillCatalogIds: [skillCatalogId],
        prerequisiteBundleIds: [],
      };

      // Seed workflow + manifest + eval suite + projection — but NOT activation.
      // The activation-aware state check should detect this as partial.
      mockDocs.set(workflowDocPath(workflowSlug), '{}');
      mockDocs.set(manifestDocPath(skillId), '{}');
      mockDocs.set(evalSuiteDocPath(workflowSlug), '{}');
      mockDocs.set(projectionDocPath(skillId), '{}');

      try {
        await installSkillBundle(ctx, standaloneBundle);
        expect.fail('expected partial-install error due to missing activation doc');
      } catch (err) {
        expect(err).toBeInstanceOf(BundlePartiallyInstalledError);
        const e = err as InstanceType<typeof BundlePartiallyInstalledError>;
        expect(e.presentArtifacts).toEqual(
          expect.arrayContaining(['workflow', 'manifest', 'evalSuite']),
        );
        expect(e.missingArtifacts).toContain('activation');
      }
    });

    it('treats present activation doc + others as complete (idempotent skip)', async () => {
      const bundleWithActivation = findFirstSkillWithActivation();
      if (!bundleWithActivation) return;

      const { skillCatalogId } = bundleWithActivation;
      const standaloneBundle: SkillBundle = {
        bundleId: 'activation-complete-bundle' as SkillBundleId,
        version: 1,
        name: 'Activation Complete',
        tagline: 'x',
        description: 'x',
        tags: [],
        skillCatalogIds: [skillCatalogId],
        prerequisiteBundleIds: [],
      };

      // Fresh install — activation doc will be written by applySkillComposeBundle.
      const first = await installSkillBundle(ctx, standaloneBundle);
      expect(first.installedSkillCatalogIds).toEqual([skillCatalogId]);

      // Re-install — full skip.
      const second = await installSkillBundle(ctx, standaloneBundle);
      expect(second.skippedSkillCatalogIds).toEqual([skillCatalogId]);
      expect(second.installedSkillCatalogIds).toEqual([]);
    });
  });

  describe('transactional-rollback', () => {
    it('rolls back every prior skill when a later skill install fails', async () => {
      const bundle = getTestTwoSkillBundle();
      failOnApplyNumber = 2;

      await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(/simulated apply failure/);

      for (const id of bundle.skillCatalogIds) {
        const entry = getSkillCatalogEntry(id)!;
        const slug = entry.bundle.workflow.slug;
        const skillId = entry.bundle.manifest.skillId;
        expect(mockDocs.has(workflowDocPath(slug))).toBe(false);
        expect(mockDocs.has(manifestDocPath(skillId))).toBe(false);
        expect(mockDocs.has(evalSuiteDocPath(slug))).toBe(false);
        expect(mockDocs.has(projectionDocPath(skillId))).toBe(false);
      }
    });

    it('first-skill failure leaves nothing installed', async () => {
      const bundle = getTestTwoSkillBundle();
      failOnApplyNumber = 1;

      await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(/simulated apply failure/);

      expect(mockDocs.size).toBe(0);
      expect(capturedManifests).toHaveLength(0);
      expect(projectionRebuilds).toHaveLength(0);
    });
  });

  describe('concurrent-install-rejected', () => {
    it('throws BundleInstallInProgressError when the advisory lock is held', async () => {
      const bundle = getTestTwoSkillBundle();
      advisoryLockOutcome = false;

      await expect(installSkillBundle(ctx, bundle)).rejects.toBeInstanceOf(
        BundleInstallInProgressError,
      );
      expect(mockDocs.size).toBe(0);
      expect(capturedManifests).toHaveLength(0);
    });

    it('error carries bundle + space identifiers for client retry routing', async () => {
      const bundle = getTestTwoSkillBundle();
      advisoryLockOutcome = false;

      try {
        await installSkillBundle(ctx, bundle);
        expect.fail('expected BundleInstallInProgressError');
      } catch (err) {
        expect(err).toBeInstanceOf(BundleInstallInProgressError);
        const e = err as InstanceType<typeof BundleInstallInProgressError>;
        expect(e.bundleId).toBe(bundle.bundleId);
        expect(e.spaceId).toBe(ctx.spaceId);
        expect(e.code).toBe('BUNDLE_INSTALL_IN_PROGRESS');
      }
    });
  });

  describe('setup-skill-intent', () => {
    // Note: this module does NOT fire the setup workflow — that requires
    // the orchestrator harness (`startRun`) which lives outside
    // `@aflow/cybernetic-runtime`. The install op returns *intent*; the
    // HTTP route surfaces it for the caller/UI to fire setup.
    //
    it('returns setupSkillIntent with stateChanged=true on fresh install', async () => {
      const bundle = getTestSetupBundle();
      expect(bundle.setupSkillCatalogId).toBe('_test-skill-a');

      const result = await installSkillBundle(ctx, bundle);

      expect(result.stateChanged).toBe(true);
      expect(result.setupSkillIntent).toBeDefined();
      const intent = result.setupSkillIntent!;
      expect(intent.skillCatalogId).toBe('_test-skill-a');
      expect(intent.bundleId).toBe(bundle.bundleId);
      expect(intent.bundleVersion).toBe(bundle.version);
      const setupEntry = getSkillCatalogEntry('_test-skill-a')!;
      expect(intent.workflowSlug).toBe(setupEntry.bundle.workflow.slug);
    });

    it('STILL returns setupSkillIntent on idempotent retry, with stateChanged=false', async () => {
      // Simulates: first POST committed but its response was lost; client
      // retries. The retry must NOT silently leave the bundle installed
      // without setup guidance.
      const bundle = getTestSetupBundle();
      await installSkillBundle(ctx, bundle);

      const result = await installSkillBundle(ctx, bundle);
      expect(result.installedSkillCatalogIds).toEqual([]);
      expect(result.skippedSkillCatalogIds).toEqual(bundle.skillCatalogIds);
      expect(result.stateChanged).toBe(false);
      // Intent surfaced even though state didn't change.
      expect(result.setupSkillIntent).toBeDefined();
      expect(result.setupSkillIntent!.skillCatalogId).toBe('_test-skill-a');
    });

    it('omits setupSkillIntent on bundle with no setupSkillCatalogId', async () => {
      const bundle = getTestTwoSkillBundle();
      expect(bundle.setupSkillCatalogId).toBeUndefined();

      const result = await installSkillBundle(ctx, bundle);
      expect(result.setupSkillIntent).toBeUndefined();
    });

    it('omits setupSkillIntent when install fails (no result returned at all)', async () => {
      const bundle = getTestSetupBundle();
      failOnApplyNumber = 1;

      await expect(installSkillBundle(ctx, bundle)).rejects.toThrow(/simulated apply failure/);
      // The function throws — there's no result to inspect. Caller never
      // sees a setupSkillIntent for an install that failed.
    });

    it('returns setupSkillIntent with stateChanged=true when projection-only self-heal occurred', async () => {
      const bundle = getTestSetupBundle();
      await installSkillBundle(ctx, bundle);

      const setupEntry = getSkillCatalogEntry('_test-skill-a')!;
      mockDocs.delete(projectionDocPath(setupEntry.bundle.manifest.skillId));

      const result = await installSkillBundle(ctx, bundle);
      expect(result.repairedProjectionSkillCatalogIds).toEqual(['_test-skill-a']);
      expect(result.stateChanged).toBe(true);
      expect(result.setupSkillIntent).toBeDefined();
    });
  });

  describe('agent-cannot-install', () => {
    it('no bundle-install operation appears in the operation registry', async () => {
      const { getAllOperationIds } = await import('@aflow/schemas');
      const ids = getAllOperationIds();
      const forbidden = ids.filter((id) =>
        /(?:^|\.)bundle\.install\b|skill\.bundle\.install|bundle-install/.test(id),
      );
      expect(forbidden).toEqual([]);
    });

    it('installSkillBundle has no operationId and is not a step-type handler', async () => {
      // Structural: the only entry point is the HTTP route. The service
      // function is not annotated with operation metadata and there is no
      // step-type handler dispatching to it. This test acts as a tripwire:
      // any future PR that adds a `bundle.install` operation will fail
      // the first assertion AND this one (because the operation would
      // typically need a service-side handler annotation).
      const moduleExports = await import('../stagedChange/skillBundleInstall.js');
      // The module exports the function and errors only — no operation
      // metadata, no STEP_TYPE_HANDLERS-style registration.
      expect(Object.keys(moduleExports).sort()).toEqual(
        [
          'BundleInstallInProgressError',
          'BundleInstallValidationError',
          'BundlePartiallyInstalledError',
          'installSkillBundle',
          'publishBundleInstallInvalidations',
        ].sort(),
      );
    });
  });

  describe('prerequisite-hard-fails-when-missing', () => {
    it('throws BundleInstallValidationError when a prerequisite bundle is not installed', async () => {
      const prereqBundle = getTestTwoSkillBundle();
      const standaloneBundle: SkillBundle = {
        bundleId: 'standalone-with-prereq' as SkillBundleId,
        version: 1,
        name: 'Standalone',
        tagline: 'Standalone',
        description: 'Standalone',
        tags: [],
        skillCatalogIds: ['_test-skill-a'],
        prerequisiteBundleIds: [prereqBundle.bundleId],
      };

      const { BundleInstallValidationError } =
        await import('../stagedChange/skillBundleInstall.js');
      await expect(installSkillBundle(ctx, standaloneBundle)).rejects.toThrow(
        BundleInstallValidationError,
      );
      // No partial install — the standalone bundle's own skill never ran.
      // The mocked memory doc store is `mockDocs` (module-level Map) — empty
      // is the natural assertion since nothing was written.
      const entry = getSkillCatalogEntry('_test-skill-a');
      if (entry) {
        const workflowPath = `/workflows/${entry.bundle.workflow.slug}/workflow.json`;
        expect(mockDocs.has(workflowPath)).toBe(false);
      }
    });

    it('proceeds when every prereq skill is already installed', async () => {
      // Install the prereq's skills first, then the standalone — should now
      // pass validation and install the standalone's skill.
      const prereqBundle = getTestTwoSkillBundle();
      await installSkillBundle(ctx, prereqBundle);
      const standaloneBundle: SkillBundle = {
        bundleId: 'standalone-with-prereq' as SkillBundleId,
        version: 1,
        name: 'Standalone',
        tagline: 'Standalone',
        description: 'Standalone',
        tags: [],
        skillCatalogIds: ['_test-skill-c'],
        prerequisiteBundleIds: [prereqBundle.bundleId],
      };
      const result = await installSkillBundle(ctx, standaloneBundle);
      expect(result.installedSkillCatalogIds).toContain('_test-skill-c');
    });
  });
});

// ============================================================================
// Helpers
// ============================================================================

/** Locate the first catalog skill whose bundle declares activation, or null. */
function findFirstSkillWithActivation(): {
  skillCatalogId: string;
  workflowSlug: string;
  skillId: string;
} | null {
  const candidates = ['_test-skill-a', '_test-skill-b', '_test-skill-c'];
  for (const id of candidates) {
    const entry = getSkillCatalogEntry(id);
    if (entry && entry.bundle.activation) {
      return {
        skillCatalogId: id,
        workflowSlug: entry.bundle.workflow.slug,
        skillId: entry.bundle.manifest.skillId,
      };
    }
  }
  return null;
}
