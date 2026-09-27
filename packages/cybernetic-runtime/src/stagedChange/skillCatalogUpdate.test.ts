/**
 * updateSkillCatalogEntry tests — the productized resync semantics: the
 * definition (workflow + activation) is replaced from the registry payload
 * while identity (id / createdAt / origin / status) is preserved and the
 * revision bumps; the space's eval suite is never clobbered; the content hash
 * of the written doc equals the registry-side stamp (the divergence
 * "pristine" invariant). The doc pipeline (materialize + build + parse) runs
 * for real against an in-memory doc repository.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import type { SkillManifest, TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

interface FakeDoc {
  inlineContent: string;
  deletedAt: Date | null;
}

const docs = vi.hoisted(() => new Map<string, FakeDoc>());

function docKey(path: string, spaceId: string): string {
  return `${spaceId}:${path}`;
}

const fakeRepo = vi.hoisted(() => ({
  getByPath: async (
    path: string,
    spaceId: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<FakeDoc | null> => {
    const key = `${spaceId}:${path}`;
    const doc = docs.get(key);
    if (!doc) return null;
    if (doc.deletedAt !== null && opts?.includeDeleted !== true) return null;
    return doc;
  },
  put: async (input: {
    path: string;
    inlineContent: string | null;
    scope: { spaceId: string };
  }) => {
    docs.set(`${input.scope.spaceId}:${input.path}`, {
      inlineContent: input.inlineContent ?? '',
      deletedAt: null,
    });
  },
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => fakeRepo,
  };
});

const manifests = vi.hoisted(() => [] as SkillManifest[]);
vi.mock('../skill.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    upsertSkillManifest: vi.fn(async (_ctx: unknown, manifest: SkillManifest) => {
      manifests.push(manifest);
      docs.set(`${SPACE_ID}:/skills/${manifest.skillId}/manifest.json`, {
        inlineContent: JSON.stringify(manifest),
        deletedAt: null,
      });
    }),
  };
});

const rebuildSkillProjection = vi.hoisted(() =>
  vi.fn(async () => ({
    projection: { activationStatus: 'active', missingCapabilities: [] as string[] },
  })),
);
vi.mock('../skillProjectionReconciler.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, rebuildSkillProjection };
});

const { updateSkillCatalogEntry } = await import('./skillCatalogUpdate.js');
const { skillBundleContentHash, skillDocContentHash } = await import('../store/artifactContent.js');

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const TENANT_ID = 'tenant-1' as TenantId;
const WF_PATH = `/workflows/test-skill-a/workflow.json`;

function fixtureBundle(): unknown {
  const entry = getSkillCatalogEntry('_test-skill-a');
  if (!entry) throw new Error('fixture skill missing');
  return entry.bundle;
}

function ctx() {
  return { tenantId: TENANT_ID as string, spaceId: SPACE_ID, db: {} as never, inTransaction: true };
}

function readDoc(path: string): Record<string, unknown> {
  const doc = docs.get(docKey(path, SPACE_ID));
  if (!doc) throw new Error(`doc ${path} missing`);
  return JSON.parse(doc.inlineContent) as Record<string, unknown>;
}

beforeEach(() => {
  docs.clear();
  manifests.length = 0;
  vi.clearAllMocks();
});

describe('updateSkillCatalogEntry', () => {
  it('falls back to a fresh install when the skill is absent, at revision 1', async () => {
    const result = await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 1,
    });
    expect(result).toMatchObject({ outcome: 'installed', skillId: 'test-skill-a', revision: 1 });
    expect(readDoc(WF_PATH)['revision']).toBe(1);
  });

  it('the installed doc hashes identically to the registry-side stamp (pristine invariant)', async () => {
    await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 1,
    });
    expect(skillDocContentHash(readDoc(WF_PATH))).toBe(skillBundleContentHash(fixtureBundle()));
  });

  it('replaces the definition, preserves identity, bumps the revision', async () => {
    await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 1,
    });
    const installed = readDoc(WF_PATH);
    const pinnedIdentity = {
      ...installed,
      id: '11111111-1111-4111-8111-111111111111',
      origin: 'operator',
      status: 'approved',
      revision: 4,
      createdAt: '2020-06-01T00:00:00.000Z',
    };
    docs.set(docKey(WF_PATH, SPACE_ID), {
      inlineContent: JSON.stringify(pinnedIdentity),
      deletedAt: null,
    });

    const changed = JSON.parse(JSON.stringify(fixtureBundle())) as {
      workflow: { description: string };
    };
    changed.workflow.description = 'Updated fixture definition.';

    const result = await updateSkillCatalogEntry(ctx(), {
      bundle: changed,
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 2,
    });
    expect(result).toMatchObject({ outcome: 'updated', skillId: 'test-skill-a', revision: 5 });

    const updated = readDoc(WF_PATH);
    expect(updated['id']).toBe('11111111-1111-4111-8111-111111111111');
    expect(updated['origin']).toBe('operator');
    expect(updated['status']).toBe('approved');
    expect(updated['createdAt']).toBe('2020-06-01T00:00:00.000Z');
    expect(updated['revision']).toBe(5);
    expect(updated['description']).toBe('Updated fixture definition.');
    expect(skillDocContentHash(updated)).toBe(skillBundleContentHash(changed));
    expect(rebuildSkillProjection).toHaveBeenCalledWith(expect.anything(), 'test-skill-a');
  });

  it('never clobbers an existing eval suite; refreshes the manifest with preserved createdAt', async () => {
    await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 1,
    });
    const suitePath = '/evals/test-skill-a/suite.json';
    docs.set(docKey(suitePath, SPACE_ID), {
      inlineContent: '{"coachAuthored":true}',
      deletedAt: null,
    });
    const firstManifest = manifests[0];
    if (!firstManifest) throw new Error('install wrote no manifest');
    docs.set(docKey(`/skills/test-skill-a/manifest.json`, SPACE_ID), {
      inlineContent: JSON.stringify({ ...firstManifest, createdAt: '2020-06-01T00:00:00.000Z' }),
      deletedAt: null,
    });

    const result = await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 2,
    });
    expect(result.outcome).toBe('updated');
    expect(docs.get(docKey(suitePath, SPACE_ID))?.inlineContent).toBe('{"coachAuthored":true}');

    const updatedManifest = manifests.at(-1);
    expect(updatedManifest).toMatchObject({
      skillId: 'test-skill-a',
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 2,
      createdAt: '2020-06-01T00:00:00.000Z',
    });
  });

  it('rejects an update over an archived skill', async () => {
    docs.set(docKey(WF_PATH, SPACE_ID), {
      inlineContent: '{}',
      deletedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const result = await updateSkillCatalogEntry(ctx(), {
      bundle: fixtureBundle(),
      sourceCatalogId: '_test-skill-a',
      sourceVersion: 2,
    });
    expect(result.outcome).toBe('invalid_bundle');
    if (result.outcome === 'invalid_bundle') {
      expect(result.error).toContain('archived');
    }
  });
});
