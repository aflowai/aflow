/**
 * computeInstallDivergence tests — current space content vs the stamped
 * installedContentHash, per replace_on_update artifact: pristine when the
 * hashes agree, modified on any edit, missing when the artifact is gone;
 * user_data_keep artifacts never participate. Runs the real hashing authority
 * against an in-memory SQL dispatcher + doc repository.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantId } from '@aflow/schemas';

interface FakeDoc {
  inlineContent: string;
  deletedAt: Date | null;
}

const store = vi.hoisted(() => ({
  artifacts: [] as Array<Record<string, string>>,
  apiDefinitions: new Map<string, unknown>(),
  mcpDefinitions: new Map<string, Record<string, unknown>>(),
  docs: new Map<string, FakeDoc>(),
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('FROM store_install_artifacts')) {
    const [catalogId, spaceId] = params as [string, string];
    return store.artifacts.filter(
      (row) => row['catalog_id'] === catalogId && row['space_id'] === spaceId,
    );
  }
  if (text.includes('SELECT definition_json FROM api_definitions')) {
    const [apiId] = params as [string];
    const definition = store.apiDefinitions.get(apiId);
    return definition === undefined ? [] : [{ definition_json: definition }];
  }
  if (text.includes('SELECT definition_json FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    const definition = store.mcpDefinitions.get(serverId);
    return definition === undefined ? [] : [{ definition_json: definition }];
  }
  throw new Error(`storeDivergence.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) };

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => ({
      getByPath: async (path: string, spaceId: string): Promise<FakeDoc | null> => {
        const doc = store.docs.get(`${spaceId}:${path}`);
        return doc && doc.deletedAt === null ? doc : null;
      },
    }),
  };
});

const { computeInstallDivergence } = await import('./storeDivergence.js');
const { jsonContentHash, skillDocContentHash } = await import('./artifactContent.js');

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const TENANT_ID = 'tenant-1' as TenantId;
const CATALOG_ID = '_test-skill-a';
const CTX = { tenantId: TENANT_ID, spaceId: SPACE_ID };

function artifactRow(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    catalog_id: CATALOG_ID,
    space_id: SPACE_ID,
    artifact_type: 'skill',
    artifact_key: 'test-skill-a',
    artifact_id: 'test-skill-a',
    installed_content_hash: 'hash',
    preservation: 'replace_on_update',
    ...over,
  };
}

const WORKFLOW_DOC = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'test-skill-a',
  name: 'Test Skill A',
  tasks: [{ taskId: 'do-the-thing' }],
  revision: 3,
  status: 'approved',
  origin: 'cloned',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-02-01T00:00:00.000Z',
};

function seedWorkflowDoc(doc: Record<string, unknown>): void {
  store.docs.set(`${SPACE_ID}:/workflows/test-skill-a/workflow.json`, {
    inlineContent: JSON.stringify(doc),
    deletedAt: null,
  });
}

beforeEach(() => {
  store.artifacts = [];
  store.apiDefinitions = new Map();
  store.mcpDefinitions = new Map();
  store.docs = new Map();
});

describe('computeInstallDivergence — skill artifacts', () => {
  it('pristine when the doc content hash matches the stamp (lifecycle fields ignored)', async () => {
    seedWorkflowDoc(WORKFLOW_DOC);
    store.artifacts.push(
      artifactRow({ installed_content_hash: skillDocContentHash(WORKFLOW_DOC) }),
    );

    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result).toEqual({
      customized: false,
      artifacts: [{ artifactType: 'skill', artifactKey: 'test-skill-a', state: 'pristine' }],
    });
  });

  it('a revision bump alone (identity churn) stays pristine', async () => {
    store.artifacts.push(
      artifactRow({ installed_content_hash: skillDocContentHash(WORKFLOW_DOC) }),
    );
    seedWorkflowDoc({
      ...WORKFLOW_DOC,
      revision: 9,
      updatedAt: '2021-01-01T00:00:00.000Z',
      id: '22222222-2222-4222-8222-222222222222',
    });

    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result.customized).toBe(false);
  });

  it('modified when a definition field changed', async () => {
    store.artifacts.push(
      artifactRow({ installed_content_hash: skillDocContentHash(WORKFLOW_DOC) }),
    );
    seedWorkflowDoc({ ...WORKFLOW_DOC, name: 'Edited by hand' });

    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result).toMatchObject({
      customized: true,
      artifacts: [{ artifactKey: 'test-skill-a', state: 'modified' }],
    });
  });

  it('missing when the workflow doc is gone', async () => {
    store.artifacts.push(artifactRow());
    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result).toMatchObject({
      customized: true,
      artifacts: [{ artifactKey: 'test-skill-a', state: 'missing' }],
    });
  });

  it('unparseable doc content reads as modified, not a crash', async () => {
    store.artifacts.push(artifactRow());
    store.docs.set(`${SPACE_ID}:/workflows/test-skill-a/workflow.json`, {
      inlineContent: 'not json {',
      deletedAt: null,
    });
    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result.artifacts[0]?.state).toBe('modified');
  });
});

describe('computeInstallDivergence — definition rows', () => {
  it('api_definition compares the stored definition_json against the stamp', async () => {
    const definition = { apiId: 'github', name: 'GitHub', baseUrl: 'https://api.github.com' };
    store.apiDefinitions.set('github', definition);
    store.artifacts.push(
      artifactRow({
        artifact_type: 'api_definition',
        artifact_key: 'github',
        artifact_id: 'github',
        installed_content_hash: jsonContentHash(definition),
      }),
    );
    const pristine = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(pristine.artifacts[0]?.state).toBe('pristine');

    store.apiDefinitions.set('github', { ...definition, baseUrl: 'https://evil.example.com' });
    const modified = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(modified.artifacts[0]?.state).toBe('modified');
  });

  it('mcp_definition ignores the install-stamped source field', async () => {
    const registryContent = {
      serverId: 'kaggle',
      name: 'Kaggle',
      serverUrl: 'https://mcp.kaggle.com',
    };
    store.mcpDefinitions.set('kaggle', { ...registryContent, source: 'platform' });
    store.artifacts.push(
      artifactRow({
        artifact_type: 'mcp_definition',
        artifact_key: 'kaggle',
        artifact_id: 'kaggle',
        installed_content_hash: jsonContentHash(registryContent),
      }),
    );
    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result.artifacts[0]?.state).toBe('pristine');
  });

  it('a deleted definition row reads as missing', async () => {
    store.artifacts.push(
      artifactRow({
        artifact_type: 'api_definition',
        artifact_key: 'github',
        artifact_id: 'github',
      }),
    );
    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result.artifacts[0]?.state).toBe('missing');
  });
});

describe('computeInstallDivergence — Mine-vs-Store contents', () => {
  const installedDefinition = {
    apiId: 'github',
    name: 'GitHub',
    baseUrl: 'https://api.github.com',
  };
  const registryDefinition = { ...installedDefinition, baseUrl: 'https://api.github.com/v4' };

  function seedModifiedApiDefinition(): void {
    store.apiDefinitions.set('github', installedDefinition);
    store.artifacts.push(
      artifactRow({
        artifact_type: 'api_definition',
        artifact_key: 'github',
        artifact_id: 'github',
        installed_content_hash: jsonContentHash(registryDefinition),
      }),
    );
  }

  it('a modified artifact carries both sides as pretty-printed JSON', async () => {
    seedModifiedApiDefinition();
    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID, {
      registryContents: new Map([['api_definition:github', registryDefinition]]),
    });
    expect(result.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      state: 'modified',
      contents: {
        mine: JSON.stringify(installedDefinition, null, 2),
        store: JSON.stringify(registryDefinition, null, 2),
      },
    });
  });

  it('omits contents without the registry map, and flags truncation past the cap', async () => {
    seedModifiedApiDefinition();
    const bare = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(bare.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      state: 'modified',
    });

    const huge = { ...registryDefinition, blob: 'x'.repeat(300 * 1024) };
    const truncated = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID, {
      registryContents: new Map([['api_definition:github', huge]]),
    });
    expect(truncated.artifacts[0]).toEqual({
      artifactType: 'api_definition',
      artifactKey: 'github',
      state: 'modified',
      contentsTruncated: true,
    });
  });
});

describe('computeInstallDivergence — user_data_keep exclusion', () => {
  it('bindings and seeds never participate in the verdict', async () => {
    seedWorkflowDoc(WORKFLOW_DOC);
    store.artifacts.push(
      artifactRow({ installed_content_hash: skillDocContentHash(WORKFLOW_DOC) }),
      artifactRow({
        artifact_type: 'api_binding',
        artifact_key: 'github-default',
        artifact_id: 'github-default',
        installed_content_hash: 'stale-template-hash',
        preservation: 'user_data_keep',
      }),
      artifactRow({
        artifact_type: 'memory_doc',
        artifact_key: '/memory/seed.md',
        artifact_id: '/memory/seed.md',
        installed_content_hash: 'stale-seed-hash',
        preservation: 'user_data_keep',
      }),
    );

    const result = await computeInstallDivergence(fakeTx as never, CTX, CATALOG_ID);
    expect(result.customized).toBe(false);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.artifactType).toBe('skill');
  });
});
