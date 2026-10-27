/**
 * Plan 330 D5 — every space template, installed into a fresh space in-process.
 *
 * The Store's own install path runs for real: the version check, the shelf
 * gate, `runStoreInstall` for each bundle the template names and the
 * provenance rows it writes, against an in-memory SQL dispatcher. The bundle
 * backend (`installSkillBundle`) is the seam: it records each call and answers
 * with the post-install manifest the real generator derives for a fresh space
 * (nothing available in it). So the test fails if a template's install skips
 * the bundle path — no call recorded, or no install rows and claims for the
 * bundle and its skills — and it asserts the template's own writes and the
 * readiness list a fresh space reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  SPACE_TEMPLATE_CATALOG,
  getCatalogEntry,
  getSkillBundleEntry,
} from '@aflow/platform-artifacts';
import type {
  ComposedLanes,
  EntityDirectives,
  SkillBundle,
  SpaceReadinessEntry,
  SpaceTemplate,
  TenantId,
} from '@aflow/schemas';

interface Row {
  [column: string]: unknown;
}

const store = vi.hoisted(() => ({
  installs: [] as Row[],
  artifacts: [] as Row[],
  claims: [] as Row[],
  apiDefinitions: [] as Row[],
  spaces: [] as Array<{ id: string; slug: string; directives: EntityDirectives }>,
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
  if (text.includes('INSERT INTO store_installs')) {
    const [catalogId, spaceId, kind, version, hash, state] = params as [
      string,
      string,
      string,
      number,
      string,
      string,
    ];
    const existing = store.installs.find(
      (row) => row['catalog_id'] === catalogId && row['space_id'] === spaceId,
    );
    if (!existing) {
      store.installs.push({
        catalog_id: catalogId,
        space_id: spaceId,
        kind,
        installed_version: version,
        installed_content_hash: hash,
        skipped_version: null,
        state,
        installed_at: params[7],
        installed_by: params[8],
        updated_at: params[9],
        updated_by: params[10],
      });
    }
    return [];
  }
  if (text.includes('FROM store_installs')) {
    if (text.includes('catalog_id =')) {
      const [catalogId, spaceId] = params as [string, string];
      return store.installs.filter(
        (row) => row['catalog_id'] === catalogId && row['space_id'] === spaceId,
      );
    }
    const [spaceId] = params as [string];
    return store.installs.filter((row) => row['space_id'] === spaceId);
  }
  if (text.includes('INSERT INTO store_install_artifacts')) {
    const [catalogId, spaceId, artifactType, artifactKey, artifactId, hash, preservation] =
      params as string[];
    store.artifacts.push({
      catalog_id: catalogId,
      space_id: spaceId,
      artifact_type: artifactType,
      artifact_key: artifactKey,
      artifact_id: artifactId,
      installed_content_hash: hash,
      preservation,
    });
    return [];
  }
  if (text.includes('INSERT INTO store_install_claims')) {
    const [catalogId, spaceId, claimedBy] = params as [string, string, string];
    store.claims.push({ catalog_id: catalogId, space_id: spaceId, claimed_by: claimedBy });
    return [];
  }
  if (text.includes('INSERT INTO api_definitions')) {
    const apiId = params[0] as string;
    const spaceId = params[4] as string;
    if (
      store.apiDefinitions.some((row) => row['api_id'] === apiId && row['space_id'] === spaceId)
    ) {
      return [];
    }
    store.apiDefinitions.push({ api_id: apiId, space_id: spaceId });
    return [{ api_id: apiId }];
  }
  throw new Error(`spaceTemplateInstall.contract.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) };

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx),
  getTenantStoreShelfPolicy: async () => ({
    defaultAvailability: 'available',
    overrides: new Map(),
  }),
}));

// A fresh space: nothing bound, no repository, no machine, no key.
vi.mock('../skillProjectionReconciler.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAvailableCapabilities: async () => ({
    available: new Set<string>(),
    codeLane: 'absent',
    withheldByProfile: new Map(),
    withheldByCeiling: new Map(),
    withheldByProfileAlone: new Map(),
  }),
}));

const { generatePostInstallManifest } = await import('../stagedChange/bundleInstallManifest.js');

const installSkillBundle = vi.hoisted(() => vi.fn());
vi.mock('../stagedChange/skillBundleInstall.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installSkillBundle,
}));

const { executeSpaceTemplateInstall } = await import('./spaceTemplateInstall.js');
const { executeStoreInstall } = await import('./storeInstallExecution.js');

const TENANT_ID = 'tenant-1' as TenantId;
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const EXISTING_SPACE_ID = '00000000-0000-4000-8000-000000000001';
const LOCAL: ComposedLanes = {
  edition: 'community-local',
  codeLane: 'absent',
  hostLane: 'present',
  browserLane: 'present',
};

/**
 * What a fresh space reads for each template's readiness list. A template
 * added to the catalog without an entry here fails, so its readiness is
 * pinned the day it ships.
 */
const FRESH_SPACE_READINESS: Record<string, SpaceReadinessEntry[]> = {
  'local-review-quick-start': [
    {
      key: 'pair-machine',
      title: 'Pair this computer and connect the folder to review',
      required: true,
      state: 'needs_setup',
      page: '/computer',
    },
  ],
};

let spaceCounter = 0;

function freshSpaceId(): string {
  spaceCounter += 1;
  return `10000000-0000-4000-8000-${String(spaceCounter).padStart(12, '0')}`;
}

async function bundleBackend(
  ctx: { spaceId: string; db: unknown },
  bundle: SkillBundle,
): Promise<Record<string, unknown>> {
  const postInstallManifest = await generatePostInstallManifest({
    bundle,
    tenantId: TENANT_ID,
    spaceId: ctx.spaceId,
    tx: ctx.db as never,
    repo: {} as never,
  });
  return {
    bundleId: bundle.bundleId,
    installedSkillCatalogIds: [...bundle.skillCatalogIds],
    skippedSkillCatalogIds: [],
    repairedProjectionSkillCatalogIds: [],
    installedApiDefinitionIds: bundle.apiDefinitions.map((definition) => definition.apiId),
    skippedApiDefinitionIds: [],
    installedBindingIds: bundle.apiBindingTemplates.map((template) => template.bindingId),
    skippedBindingIds: [],
    installedMcpDefinitionIds: [],
    skippedMcpDefinitionIds: [],
    installedMcpBindingIds: [],
    skippedMcpBindingIds: [],
    installedMemoryDocPaths: [],
    skippedMemoryDocPaths: [],
    installedArtifactBindings: [],
    skippedArtifactBindings: [],
    installedAgentSlugs: [],
    skippedAgentSlugs: [],
    pendingEmbedJobs: [],
    postInstallManifest,
    helmsmanHints: [],
    warnings: [],
    stateChanged: true,
  };
}

function installTemplate(template: SpaceTemplate, spaceId: string) {
  return executeSpaceTemplateInstall({
    db: {} as never,
    redis: null,
    tenantId: TENANT_ID,
    actorUserId: USER_ID,
    catalogId: template.templateId,
    expectedVersion: template.version,
    idempotencyKey: '20000000-0000-4000-8000-000000000001',
    lanes: LOCAL,
    createSpace: async (_tx, directives) => {
      store.spaces.push({ id: spaceId, slug: `space-${spaceId.slice(-4)}`, directives });
      return { spaceId, spaceSlug: `space-${spaceId.slice(-4)}` };
    },
  });
}

beforeEach(() => {
  store.installs = [];
  store.artifacts = [];
  store.claims = [];
  store.apiDefinitions = [];
  store.spaces = [];
  installSkillBundle.mockReset();
  installSkillBundle.mockImplementation(bundleBackend);
});

describe('every space template installs into a fresh space', () => {
  it('ships at least one template', () => {
    expect(SPACE_TEMPLATE_CATALOG.length).toBeGreaterThan(0);
  });

  for (const { template } of SPACE_TEMPLATE_CATALOG) {
    describe(template.templateId, () => {
      it('installs every bundle it names through the bundle install path, with its rows and claims', async () => {
        const spaceId = freshSpaceId();
        const result = await installTemplate(template, spaceId);
        if (!result.ok) throw new Error(`install failed: ${JSON.stringify(result.body)}`);

        expect(installSkillBundle).toHaveBeenCalledTimes(template.bundleIds.length);
        for (const [index, bundleId] of template.bundleIds.entries()) {
          const [ctx, bundle] = installSkillBundle.mock.calls[index] as [
            { spaceId: string },
            SkillBundle,
          ];
          expect(ctx.spaceId).toBe(spaceId);
          expect(bundle.bundleId).toBe(bundleId);

          const catalogBundle = getCatalogEntry(bundleId);
          expect(store.installs).toContainEqual(
            expect.objectContaining({
              catalog_id: bundleId,
              space_id: spaceId,
              kind: 'bundle',
              installed_version: catalogBundle?.version,
            }),
          );
          expect(store.claims).toContainEqual({
            catalog_id: bundleId,
            space_id: spaceId,
            claimed_by: 'direct',
          });
          for (const skillCatalogId of getSkillBundleEntry(bundleId)?.skillCatalogIds ?? []) {
            expect(store.installs).toContainEqual(
              expect.objectContaining({
                catalog_id: skillCatalogId,
                space_id: spaceId,
                kind: 'skill',
              }),
            );
            expect(store.claims).toContainEqual({
              catalog_id: skillCatalogId,
              space_id: spaceId,
              claimed_by: `bundle:${bundleId}`,
            });
          }
        }
        expect(result.response.result).toMatchObject({
          kind: 'space',
          spaceId,
          templateVersion: template.version,
          bundles: template.bundleIds.map((catalogId) => ({ catalogId })),
        });
      });

      it('records the template version on the new space’s own install row', async () => {
        const spaceId = freshSpaceId();
        const result = await installTemplate(template, spaceId);
        expect(result.ok).toBe(true);
        expect(store.installs).toContainEqual(
          expect.objectContaining({
            catalog_id: template.templateId,
            space_id: spaceId,
            kind: 'space',
            installed_version: template.version,
          }),
        );
      });

      it('writes every directive, agent and api_definition it carries into the new space', async () => {
        const spaceId = freshSpaceId();
        const result = await installTemplate(template, spaceId);
        if (!result.ok) throw new Error(`install failed: ${JSON.stringify(result.body)}`);

        const space = store.spaces.find((candidate) => candidate.id === spaceId);
        expect(space?.directives.responsibility).toBe(template.directives.responsibility);
        expect(space?.directives.priorities).toEqual(template.directives.priorities);
        if (template.directives.style !== undefined) {
          expect(space?.directives.style).toBe(template.directives.style);
        }
        for (const definition of template.apiDefinitions) {
          expect(store.apiDefinitions).toContainEqual({
            api_id: definition.apiId,
            space_id: spaceId,
          });
        }
        if (result.response.result.kind !== 'space') throw new Error('expected a space result');
        expect(result.response.result.installedAgentSlugs).toHaveLength(template.agents.length);
      });

      it('reads the expected readiness list for a fresh space', async () => {
        const expected = FRESH_SPACE_READINESS[template.templateId];
        expect(
          expected,
          `no fresh-space readiness pinned for ${template.templateId}`,
        ).toBeDefined();
        const result = await installTemplate(template, freshSpaceId());
        if (!result.ok) throw new Error(`install failed: ${JSON.stringify(result.body)}`);
        if (result.response.result.kind !== 'space') throw new Error('expected a space result');
        expect(result.response.result.readiness).toEqual(expected);
      });
    });
  }
});

describe('a template is never applied to a space that exists', () => {
  it('refuses a space listing on the space-scoped install, before anything is written', async () => {
    const [listing] = SPACE_TEMPLATE_CATALOG;
    if (!listing) throw new Error('no template');
    const result = await executeStoreInstall({
      db: {} as never,
      redis: null,
      tenantId: TENANT_ID,
      spaceId: EXISTING_SPACE_ID,
      actorUserId: USER_ID,
      catalogId: listing.template.templateId,
      expectedVersion: listing.template.version,
      idempotencyKey: '20000000-0000-4000-8000-000000000002',
      lanes: LOCAL,
    });
    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      body: { code: 'SPACE_TEMPLATE_NEEDS_NEW_SPACE' },
    });
    expect(installSkillBundle).not.toHaveBeenCalled();
    expect(store.installs).toEqual([]);
  });

  it('refuses when the space handed back already holds installs', async () => {
    const [listing] = SPACE_TEMPLATE_CATALOG;
    if (!listing) throw new Error('no template');
    store.installs.push({
      catalog_id: 'github',
      space_id: EXISTING_SPACE_ID,
      kind: 'connector',
      installed_version: 1,
      installed_content_hash: 'hash',
      skipped_version: null,
      state: 'installed',
      installed_at: '2026-01-01T00:00:00.000Z',
      installed_by: USER_ID,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: USER_ID,
    });
    const result = await installTemplate(listing.template, EXISTING_SPACE_ID);
    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      body: { code: 'SPACE_TEMPLATE_NEEDS_NEW_SPACE' },
    });
    expect(installSkillBundle).not.toHaveBeenCalled();
  });
});
