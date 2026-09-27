/**
 * executeStoreUninstall / executeStoreUninstallPreview tests: the claims
 * matrix (direct-only, bundle-claimed, bundle uninstall with staying vs
 * falling members), the connector arm (delete when unreferenced, disable
 * with the dependents named when installed skills still reference the
 * integration), archive-not-purge, user-data keep semantics (default keep,
 * explicit removal of pristine rows only, modified never deleted),
 * provenance cleanup with the last claim, the idempotency replay, and the
 * preview==execution invariant (one shared plan builder).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantId } from '@aflow/schemas';
import { jsonContentHash } from './artifactContent.js';

interface InstallRow {
  catalog_id: string;
  space_id: string;
  kind: string;
  installed_version: number;
  installed_content_hash: string;
  skipped_version: number | null;
  state: string;
  host_manifest_json?: unknown;
  installed_at: string;
  installed_by: string;
  updated_at: string;
  updated_by: string;
}

interface ArtifactRow {
  catalog_id: string;
  space_id: string;
  artifact_type: string;
  artifact_key: string;
  artifact_id: string;
  installed_content_hash: string;
  preservation: string;
}

interface ClaimRow {
  catalog_id: string;
  space_id: string;
  claimed_by: string;
}

const store = vi.hoisted(() => ({
  installs: [] as InstallRow[],
  artifacts: [] as ArtifactRow[],
  claims: [] as ClaimRow[],
  lockAcquired: true,
  workflowDocs: [] as Array<{ path: string; inline_content: string }>,
  activeRunsBySlug: new Map<string, string[]>(),
  apiDefinitionIds: new Set<string>(),
  mcpDefinitionIds: new Set<string>(),
  apiBindingToApi: new Map<string, string>(),
  mcpBindingToServer: new Map<string, string>(),
  memoryDocByPath: new Map<string, { id: string; inline_content: string }>(),
  uiArtifactByKey: new Map<string, { id: string; content_hash: string }>(),
  uiArtifactSoftDeletes: [] as string[],
  artifactBindingDeletes: [] as string[],
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('pg_try_advisory_xact_lock')) {
    return [{ acquired: store.lockAcquired }];
  }
  if (text.includes('DELETE FROM store_install_claims')) {
    if (text.includes('claimed_by =')) {
      const [catalogId, spaceId, claimedBy] = params as [string, string, string];
      store.claims = store.claims.filter(
        (row) =>
          !(
            row.catalog_id === catalogId &&
            row.space_id === spaceId &&
            row.claimed_by === claimedBy
          ),
      );
      return [];
    }
    const [catalogId, spaceId] = params as [string, string];
    store.claims = store.claims.filter(
      (row) => !(row.catalog_id === catalogId && row.space_id === spaceId),
    );
    return [];
  }
  if (text.includes('DELETE FROM store_install_artifacts')) {
    const [catalogId, spaceId] = params as [string, string];
    store.artifacts = store.artifacts.filter(
      (row) => !(row.catalog_id === catalogId && row.space_id === spaceId),
    );
    return [];
  }
  if (text.includes('DELETE FROM store_installs')) {
    const [catalogId, spaceId] = params as [string, string];
    store.installs = store.installs.filter(
      (row) => !(row.catalog_id === catalogId && row.space_id === spaceId),
    );
    return [];
  }
  if (text.includes('FROM store_installs')) {
    const [catalogId, spaceId] = params as [string, string];
    return store.installs.filter((row) => row.catalog_id === catalogId && row.space_id === spaceId);
  }
  if (text.includes('FROM store_install_artifacts')) {
    if (text.includes('catalog_id =')) {
      const [catalogId, spaceId] = params as [string, string];
      return store.artifacts.filter(
        (row) => row.catalog_id === catalogId && row.space_id === spaceId,
      );
    }
    const [spaceId] = params as [string];
    return store.artifacts.filter((row) => row.space_id === spaceId);
  }
  if (text.includes('FROM store_install_claims')) {
    if (text.includes('WHERE claimed_by =')) {
      const [claimedBy, spaceId] = params as [string, string];
      return store.claims.filter((row) => row.claimed_by === claimedBy && row.space_id === spaceId);
    }
    const [catalogId, spaceId] = params as [string, string];
    return store.claims.filter((row) => row.catalog_id === catalogId && row.space_id === spaceId);
  }
  if (text.includes("path LIKE '/workflows/%/workflow.json'")) {
    return store.workflowDocs;
  }
  if (text.includes('SELECT run_id FROM workflow_runs')) {
    const [, workflowSlug] = params as [string, string];
    return (store.activeRunsBySlug.get(workflowSlug) ?? []).map((runId) => ({ run_id: runId }));
  }
  if (text.includes('SELECT api_id FROM api_definitions')) {
    const [apiId] = params as [string];
    return store.apiDefinitionIds.has(apiId) ? [{ api_id: apiId }] : [];
  }
  if (text.includes('SELECT server_id FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    return store.mcpDefinitionIds.has(serverId) ? [{ server_id: serverId }] : [];
  }
  if (text.includes('SELECT api_id FROM api_bindings')) {
    const [bindingId] = params as [string];
    const apiId = store.apiBindingToApi.get(bindingId);
    return apiId === undefined ? [] : [{ api_id: apiId }];
  }
  if (text.includes('SELECT server_id FROM mcp_server_bindings')) {
    const [bindingId] = params as [string];
    const serverId = store.mcpBindingToServer.get(bindingId);
    return serverId === undefined ? [] : [{ server_id: serverId }];
  }
  if (text.includes('SELECT id, inline_content FROM memory_docs')) {
    const [path] = params as [string];
    const doc = store.memoryDocByPath.get(path);
    return doc === undefined ? [] : [doc];
  }
  if (text.includes('FROM ui_artifacts a')) {
    const [, bundleArtifactKey] = params as [string, string];
    const head = store.uiArtifactByKey.get(bundleArtifactKey);
    return head === undefined ? [] : [head];
  }
  if (text.includes('UPDATE ui_artifacts SET deleted_at')) {
    const [artifactRowId] = params as [string];
    store.uiArtifactSoftDeletes.push(artifactRowId);
    return [];
  }
  if (text.includes('DELETE FROM artifact_bindings')) {
    const [bindingId] = params as [string];
    store.artifactBindingDeletes.push(bindingId);
    return [];
  }
  throw new Error(`storeUninstallExecution.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) };

const hardDelete = vi.hoisted(() => vi.fn(async () => true));
const withTenantSchemaSpy = vi.hoisted(() => vi.fn());

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => ({ hardDelete }),
    withTenantSchema: async (
      _db: unknown,
      _ctx: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      withTenantSchemaSpy();
      return fn(fakeTx);
    },
  };
});

const archiveSkill = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, skillId: string) => ({
    skillId,
    archivedAt: '2020-01-01T00:00:00.000Z',
    softDeletedDocPaths: [],
    closedProposalCount: 0,
    forceCancelledRunIds: [],
  })),
);
const purgeSkill = vi.hoisted(() => vi.fn());
vi.mock('../skillLifecycle.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, archiveSkill, purgeSkill };
});

const countActiveRepoDependents = vi.hoisted(() => vi.fn(async () => 0));
const deleteApiIntegration = vi.hoisted(() => vi.fn(async () => undefined));
const deleteMcpIntegration = vi.hoisted(() => vi.fn(async () => undefined));
const disableApiBinding = vi.hoisted(() => vi.fn(async () => undefined));
const disableMcpBinding = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./connectorUninstall.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    countActiveRepoDependents,
    deleteApiIntegration,
    deleteMcpIntegration,
    disableApiBinding,
    disableMcpBinding,
  };
});

const publishApiCatalogInvalidation = vi.hoisted(() => vi.fn());
const publishMcpCatalogInvalidation = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, publishApiCatalogInvalidation, publishMcpCatalogInvalidation };
});

const { executeStoreUninstall, executeStoreUninstallPreview } =
  await import('./storeUninstallExecution.js');

// ============================================================================
// Test harness
// ============================================================================

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TENANT_ID = 'tenant-1' as TenantId;
const IDEMPOTENCY_KEY_A = '10000000-0000-4000-8000-000000000001';
const IDEMPOTENCY_KEY_B = '10000000-0000-4000-8000-000000000002';

function createFakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
      if (args.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return data.delete(key) ? 1 : 0;
    },
  };
}
type FakeRedis = ReturnType<typeof createFakeRedis>;

function uninstall(
  over: Record<string, unknown> = {},
  redis: FakeRedis | null = createFakeRedis(),
) {
  return executeStoreUninstall({
    db: {} as never,
    redis: redis as never,
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    actorUserId: USER_ID,
    catalogId: 'skill-a',
    idempotencyKey: IDEMPOTENCY_KEY_A,
    ...over,
  });
}

function preview(catalogId: string) {
  return executeStoreUninstallPreview({
    db: {} as never,
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    catalogId,
  });
}

function installRow(catalogId: string, kind: string): InstallRow {
  return {
    catalog_id: catalogId,
    space_id: SPACE_ID,
    kind,
    installed_version: 1,
    installed_content_hash: 'hash',
    skipped_version: null,
    state: 'installed',
    installed_at: '2020-01-01T00:00:00.000Z',
    installed_by: USER_ID,
    updated_at: '2020-01-01T00:00:00.000Z',
    updated_by: USER_ID,
  };
}

function artifactRow(
  catalogId: string,
  artifactType: string,
  artifactKey: string,
  over: Partial<ArtifactRow> = {},
): ArtifactRow {
  return {
    catalog_id: catalogId,
    space_id: SPACE_ID,
    artifact_type: artifactType,
    artifact_key: artifactKey,
    artifact_id: artifactKey,
    installed_content_hash: 'artifact-hash',
    preservation: 'replace_on_update',
    ...over,
  };
}

function claimRow(catalogId: string, claimedBy: string): ClaimRow {
  return { catalog_id: catalogId, space_id: SPACE_ID, claimed_by: claimedBy };
}

function workflowDoc(slug: string, name: string, referencedApiIds: string[] = []): void {
  store.workflowDocs.push({
    path: `/workflows/${slug}/workflow.json`,
    inline_content: JSON.stringify({
      name,
      tasks: referencedApiIds.map((apiId, index) => ({
        taskId: `t${String(index)}`,
        context: {
          capabilities: {
            integrations: [{ sourceKind: 'api', integrationId: apiId, capabilityId: apiId }],
          },
        },
      })),
    }),
  });
}

function seedDirectSkill(catalogId = 'skill-a', slug = 'skill-a-wf'): void {
  store.installs.push(installRow(catalogId, 'skill'));
  store.artifacts.push(artifactRow(catalogId, 'skill', slug, { artifact_id: `${slug}-id` }));
  store.claims.push(claimRow(catalogId, 'direct'));
  workflowDoc(slug, 'Skill A');
}

beforeEach(() => {
  store.installs = [];
  store.artifacts = [];
  store.claims = [];
  store.lockAcquired = true;
  store.workflowDocs = [];
  store.activeRunsBySlug = new Map();
  store.apiDefinitionIds = new Set();
  store.mcpDefinitionIds = new Set();
  store.apiBindingToApi = new Map();
  store.mcpBindingToServer = new Map();
  store.memoryDocByPath = new Map();
  store.uiArtifactByKey = new Map();
  store.uiArtifactSoftDeletes = [];
  store.artifactBindingDeletes = [];
  vi.clearAllMocks();
  countActiveRepoDependents.mockResolvedValue(0);
});

// ============================================================================
// Guards
// ============================================================================

describe('executeStoreUninstall — guards', () => {
  it('fails NOT_INSTALLED when the space has no install row', async () => {
    const result = await uninstall();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({ code: 'NOT_INSTALLED', catalogId: 'skill-a' });
  });

  it('fails STORE_MUTATION_IN_PROGRESS when the advisory lock is held', async () => {
    seedDirectSkill();
    store.lockAcquired = false;
    const result = await uninstall();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('STORE_MUTATION_IN_PROGRESS');
    expect(archiveSkill).not.toHaveBeenCalled();
  });

  it('blocks with SKILL_HAS_ACTIVE_RUNS and performs nothing when a skill has active runs', async () => {
    seedDirectSkill();
    store.activeRunsBySlug.set('skill-a-wf', ['run-1', 'run-2']);
    const result = await uninstall();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      code: 'SKILL_HAS_ACTIVE_RUNS',
      skillId: 'skill-a-wf-id',
      runIds: ['run-1', 'run-2'],
    });
    expect(archiveSkill).not.toHaveBeenCalled();
    expect(store.installs).toHaveLength(1);
  });
});

// ============================================================================
// Claims matrix
// ============================================================================

describe('executeStoreUninstall — claims', () => {
  it('direct-only: archives the skill (never purges) and removes all provenance', async () => {
    seedDirectSkill();
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.action).toBe('remove');
    expect(result.response.artifacts).toEqual([
      { artifactType: 'skill', artifactKey: 'skill-a-wf', action: 'archive', activeRunCount: 0 },
    ]);
    expect(archiveSkill).toHaveBeenCalledWith(expect.anything(), 'skill-a-wf-id');
    expect(purgeSkill).not.toHaveBeenCalled();
    expect(store.installs).toHaveLength(0);
    expect(store.artifacts).toHaveLength(0);
    expect(store.claims).toHaveLength(0);
  });

  it('bundle-claimed: a direct uninstall only releases the direct claim', async () => {
    seedDirectSkill();
    store.claims.push(claimRow('skill-a', 'bundle:bundle-b'));
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.action).toBe('release_claim');
    expect(result.response.remainingClaims).toEqual(['bundle:bundle-b']);
    expect(result.response.artifacts).toEqual([]);
    expect(archiveSkill).not.toHaveBeenCalled();
    expect(store.installs).toHaveLength(1);
    expect(store.artifacts).toHaveLength(1);
    expect(store.claims).toEqual([claimRow('skill-a', 'bundle:bundle-b')]);
  });

  it('bundle uninstall: a directly-installed member survives, a bundle-only member falls with the last claim', async () => {
    store.installs.push(installRow('bundle-b', 'bundle'));
    store.claims.push(claimRow('bundle-b', 'direct'));
    store.artifacts.push(
      artifactRow('bundle-b', 'skill', 'member-direct-wf', { artifact_id: 'member-direct-id' }),
      artifactRow('bundle-b', 'skill', 'member-only-wf', { artifact_id: 'member-only-id' }),
    );

    store.installs.push(installRow('member-direct', 'skill'));
    store.claims.push(
      claimRow('member-direct', 'direct'),
      claimRow('member-direct', 'bundle:bundle-b'),
    );
    store.artifacts.push(
      artifactRow('member-direct', 'skill', 'member-direct-wf', {
        artifact_id: 'member-direct-id',
      }),
    );

    store.installs.push(installRow('member-only', 'skill'));
    store.claims.push(claimRow('member-only', 'bundle:bundle-b'));
    store.artifacts.push(
      artifactRow('member-only', 'skill', 'member-only-wf', { artifact_id: 'member-only-id' }),
    );

    workflowDoc('member-direct-wf', 'Member Direct');
    workflowDoc('member-only-wf', 'Member Only');

    const result = await uninstall({ catalogId: 'bundle-b' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.members).toEqual([
      { catalogId: 'member-direct', action: 'stays', remainingClaims: ['direct'] },
      { catalogId: 'member-only', action: 'remove', remainingClaims: [] },
    ]);
    expect(archiveSkill).toHaveBeenCalledTimes(1);
    expect(archiveSkill).toHaveBeenCalledWith(expect.anything(), 'member-only-id');

    // The surviving member keeps its install row, artifacts, and direct claim.
    expect(store.installs.map((row) => row.catalog_id)).toEqual(['member-direct']);
    expect(store.artifacts.map((row) => row.catalog_id)).toEqual(['member-direct']);
    expect(store.claims).toEqual([claimRow('member-direct', 'direct')]);
  });
});

// ============================================================================
// Connector arm
// ============================================================================

function seedApiConnector(catalogId = 'conn-a', apiId = 'github'): void {
  store.installs.push(installRow(catalogId, 'connector'));
  store.claims.push(claimRow(catalogId, 'direct'));
  store.artifacts.push(
    artifactRow(catalogId, 'api_definition', apiId),
    artifactRow(catalogId, 'api_binding', `${apiId}-default`, {
      preservation: 'user_data_keep',
    }),
  );
  store.apiDefinitionIds.add(apiId);
  store.apiBindingToApi.set(`${apiId}-default`, apiId);
}

describe('executeStoreUninstall — connector arm', () => {
  it('deletes an unreferenced integration and its connection', async () => {
    seedApiConnector();
    const result = await uninstall({ catalogId: 'conn-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      { artifactType: 'api_definition', artifactKey: 'github', action: 'delete' },
      { artifactType: 'api_binding', artifactKey: 'github-default', action: 'delete' },
    ]);
    expect(deleteApiIntegration).toHaveBeenCalledWith(expect.anything(), SPACE_ID, 'github');
    expect(disableApiBinding).not.toHaveBeenCalled();
    expect(store.installs).toHaveLength(0);
    expect(publishApiCatalogInvalidation).toHaveBeenCalled();
  });

  it('blocks deletion with the dependent skills named and disables the connection instead', async () => {
    seedApiConnector();
    workflowDoc('pr-shepherd', 'PR Shepherd', ['github']);
    workflowDoc('other-skill', 'Other Skill', []);
    const result = await uninstall({ catalogId: 'conn-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      {
        artifactType: 'api_definition',
        artifactKey: 'github',
        action: 'disable',
        dependentSkills: ['PR Shepherd'],
      },
      { artifactType: 'api_binding', artifactKey: 'github-default', action: 'disable' },
    ]);
    expect(deleteApiIntegration).not.toHaveBeenCalled();
    expect(disableApiBinding).toHaveBeenCalledWith(expect.anything(), SPACE_ID, 'github-default');
    // The claim is released regardless — the disabled artifacts are reported residue.
    expect(store.installs).toHaveLength(0);
  });

  it('a skill archived by this same uninstall does not block its bundled integration', async () => {
    store.installs.push(installRow('bundle-b', 'bundle'));
    store.claims.push(claimRow('bundle-b', 'direct'));
    store.artifacts.push(
      artifactRow('bundle-b', 'skill', 'user-wf', { artifact_id: 'user-wf-id' }),
      artifactRow('bundle-b', 'api_definition', 'github'),
    );
    store.apiDefinitionIds.add('github');
    workflowDoc('user-wf', 'User Skill', ['github']);
    const result = await uninstall({ catalogId: 'bundle-b' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toContainEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      action: 'delete',
    });
    expect(deleteApiIntegration).toHaveBeenCalled();
  });

  it('a coding-repo dependent blocks deletion', async () => {
    seedApiConnector();
    countActiveRepoDependents.mockResolvedValue(2);
    const result = await uninstall({ catalogId: 'conn-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      action: 'disable',
      dependentRepoCount: 2,
    });
    expect(deleteApiIntegration).not.toHaveBeenCalled();
  });

  it('a skill referencing the integration only via an op-task inputTemplate blocks deletion', async () => {
    seedApiConnector();
    store.workflowDocs.push({
      path: '/workflows/uploader-wf/workflow.json',
      inline_content: JSON.stringify({
        name: 'Uploader',
        tasks: [
          {
            taskId: 'upload',
            operation: 'api.http.call',
            inputTemplate: {
              apiId: 'github',
              bindingId: 'github-default',
              url: 'https://api.github.com/upload',
            },
          },
        ],
      }),
    });
    const result = await uninstall({ catalogId: 'conn-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      action: 'disable',
      dependentSkills: ['Uploader'],
    });
    expect(deleteApiIntegration).not.toHaveBeenCalled();
  });

  it('a skill referencing the integration only via an operations grant blocks deletion', async () => {
    seedApiConnector();
    store.workflowDocs.push({
      path: '/workflows/ops-wf/workflow.json',
      inline_content: JSON.stringify({
        name: 'Ops Skill',
        tasks: [
          { taskId: 't0', context: { capabilities: { operations: ['github.issues.create'] } } },
        ],
      }),
    });
    const result = await uninstall({ catalogId: 'conn-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      action: 'disable',
      dependentSkills: ['Ops Skill'],
    });
    expect(deleteApiIntegration).not.toHaveBeenCalled();
  });

  it('a definition shared with a standalone install survives a bundle uninstall', async () => {
    store.installs.push(installRow('bundle-b', 'bundle'));
    store.claims.push(claimRow('bundle-b', 'direct'));
    store.artifacts.push(
      artifactRow('bundle-b', 'api_definition', 'github'),
      artifactRow('bundle-b', 'api_binding', 'github-bundle', { preservation: 'user_data_keep' }),
    );
    store.installs.push(installRow('conn-a', 'connector'));
    store.claims.push(claimRow('conn-a', 'direct'));
    store.artifacts.push(
      artifactRow('conn-a', 'api_definition', 'github'),
      artifactRow('conn-a', 'api_binding', 'github-default', { preservation: 'user_data_keep' }),
    );
    store.apiDefinitionIds.add('github');
    store.apiBindingToApi.set('github-bundle', 'github');
    store.apiBindingToApi.set('github-default', 'github');

    const result = await uninstall({ catalogId: 'bundle-b' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      { artifactType: 'api_binding', artifactKey: 'github-bundle', action: 'disable' },
    ]);
    expect(deleteApiIntegration).not.toHaveBeenCalled();
    expect(disableApiBinding).toHaveBeenCalledWith(expect.anything(), SPACE_ID, 'github-bundle');
    expect(store.artifacts.filter((row) => row.catalog_id === 'conn-a')).toHaveLength(2);
    expect(store.installs.map((row) => row.catalog_id)).toEqual(['conn-a']);
  });
});

// ============================================================================
// User data
// ============================================================================

function seedBundleWithUserData(): { pristineContent: string } {
  const pristineContent = '# seeded notes';
  store.installs.push(installRow('bundle-b', 'bundle'));
  store.claims.push(claimRow('bundle-b', 'direct'));
  store.artifacts.push(
    artifactRow('bundle-b', 'memory_doc', '/notes/seeded.md', {
      preservation: 'user_data_keep',
      installed_content_hash: jsonContentHash(pristineContent),
    }),
    artifactRow('bundle-b', 'ui_artifact', 'bundle-b:card', {
      artifact_id: 'card-binding',
      preservation: 'user_data_keep',
      installed_content_hash: 'render-hash',
    }),
  );
  store.memoryDocByPath.set('/notes/seeded.md', {
    id: 'doc-1',
    inline_content: pristineContent,
  });
  store.uiArtifactByKey.set('bundle-b:card', { id: 'ui-row-1', content_hash: 'render-hash' });
  return { pristineContent };
}

describe('executeStoreUninstall — user data', () => {
  it('keeps every user-data artifact by default', async () => {
    seedBundleWithUserData();
    const result = await uninstall({ catalogId: 'bundle-b' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      {
        artifactType: 'memory_doc',
        artifactKey: '/notes/seeded.md',
        action: 'keep',
        userDataRemovable: true,
      },
      {
        artifactType: 'ui_artifact',
        artifactKey: 'bundle-b:card',
        action: 'keep',
        userDataRemovable: true,
      },
    ]);
    expect(hardDelete).not.toHaveBeenCalled();
    expect(store.uiArtifactSoftDeletes).toEqual([]);
    expect(store.installs).toHaveLength(0);
  });

  it('removes explicitly-unchecked pristine rows', async () => {
    seedBundleWithUserData();
    const result = await uninstall({ catalogId: 'bundle-b', keepUserData: ['/notes/seeded.md'] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      {
        artifactType: 'memory_doc',
        artifactKey: '/notes/seeded.md',
        action: 'keep',
        userDataRemovable: true,
      },
      {
        artifactType: 'ui_artifact',
        artifactKey: 'bundle-b:card',
        action: 'delete',
        userDataRemovable: true,
      },
    ]);
    expect(hardDelete).not.toHaveBeenCalled();
    expect(store.uiArtifactSoftDeletes).toEqual(['ui-row-1']);
    expect(store.artifactBindingDeletes).toEqual(['card-binding']);
  });

  it('never deletes a modified user-data artifact, even when explicitly unchecked', async () => {
    seedBundleWithUserData();
    store.memoryDocByPath.set('/notes/seeded.md', {
      id: 'doc-1',
      inline_content: '# the user edited this',
    });
    store.uiArtifactByKey.set('bundle-b:card', { id: 'ui-row-1', content_hash: 'other-hash' });
    const result = await uninstall({ catalogId: 'bundle-b', keepUserData: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts).toEqual([
      {
        artifactType: 'memory_doc',
        artifactKey: '/notes/seeded.md',
        action: 'keep',
        userDataRemovable: false,
      },
      {
        artifactType: 'ui_artifact',
        artifactKey: 'bundle-b:card',
        action: 'keep',
        userDataRemovable: false,
      },
    ]);
    expect(hardDelete).not.toHaveBeenCalled();
    expect(store.uiArtifactSoftDeletes).toEqual([]);
  });

  it('deletes an unchecked pristine memory doc via the repository hard delete', async () => {
    seedBundleWithUserData();
    const result = await uninstall({ catalogId: 'bundle-b', keepUserData: ['bundle-b:card'] });
    expect(result.ok).toBe(true);
    expect(hardDelete).toHaveBeenCalledWith('doc-1', SPACE_ID);
    expect(store.uiArtifactSoftDeletes).toEqual([]);
  });
});

// ============================================================================
// Idempotency + preview==execution
// ============================================================================

describe('executeStoreUninstall — idempotency', () => {
  it('replays the recorded response for the same idempotency key without re-running', async () => {
    seedDirectSkill();
    const redis = createFakeRedis();
    const first = await uninstall({}, redis);
    expect(first.ok).toBe(true);
    const txRuns = withTenantSchemaSpy.mock.calls.length;
    const replay = await uninstall({}, redis);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error('expected success');
    expect(replay.response).toEqual(first.response);
    expect(withTenantSchemaSpy.mock.calls.length).toBe(txRuns);
  });

  it('a fresh key after completion fails NOT_INSTALLED', async () => {
    seedDirectSkill();
    const redis = createFakeRedis();
    await uninstall({}, redis);
    const second = await uninstall({ idempotencyKey: IDEMPOTENCY_KEY_B }, redis);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.body.code).toBe('NOT_INSTALLED');
  });

  it('a failed attempt releases the idempotency claim for a retry', async () => {
    seedDirectSkill();
    store.lockAcquired = false;
    const redis = createFakeRedis();
    await uninstall({}, redis);
    store.lockAcquired = true;
    const retry = await uninstall({}, redis);
    expect(retry.ok).toBe(true);
  });
});

describe('executeStoreUninstallPreview', () => {
  it('404s when not installed', async () => {
    const result = await preview('skill-a');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.body.code).toBe('NOT_INSTALLED');
  });

  it('reports active-run blockers without mutating anything', async () => {
    seedDirectSkill();
    store.activeRunsBySlug.set('skill-a-wf', ['run-1']);
    const result = await preview('skill-a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.artifacts[0]).toMatchObject({ action: 'archive', activeRunCount: 1 });
    expect(archiveSkill).not.toHaveBeenCalled();
    expect(store.installs).toHaveLength(1);
  });

  it('matches execution exactly — one shared plan builder', async () => {
    seedApiConnector();
    workflowDoc('pr-shepherd', 'PR Shepherd', ['github']);
    const previewed = await preview('conn-a');
    expect(previewed.ok).toBe(true);
    const executed = await uninstall({ catalogId: 'conn-a' });
    expect(executed.ok).toBe(true);
    if (!previewed.ok || !executed.ok) throw new Error('expected success');
    expect(executed.response).toEqual(previewed.response);
  });
});
