/**
 * The MCP server and binding admin SQL against a real database.
 *
 * The orchestrator's handler tests run on a transaction double that ignores
 * every WHERE clause, so only Postgres can show that each read and write stays
 * inside its space, that an update keeps a stored flow narrowing unless told
 * otherwise, and what deleting a server actually takes with it. Gated on
 * DATABASE_URL like every pg test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { createDatabase, createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import {
  deleteMcpServerBinding,
  deleteMcpServerDefinition,
  getMcpServerDefinitionRow,
  listMcpServerDefinitionRows,
  McpBindingOriginNotPinnedError,
  mcpServerDefinitionFromRow,
  upsertMcpServerBinding,
  upsertMcpServerDefinition,
  type McpServerBindingWrite,
  type McpServerDefinitionWrite,
} from '../mcpIntegrationAdmin.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '3c900000-0000-4000-8000-0000000000a1';
const OTHER_SPACE = '3c900000-0000-4000-8000-0000000000a2';
const SPACES = [SPACE, OTHER_SPACE];

const describeDb = DATABASE_URL ? describe : describe.skip;

function definition(
  serverId: string,
  overrides: Partial<McpServerDefinitionWrite> = {},
): McpServerDefinitionWrite {
  return {
    serverId,
    name: `${serverId} server`,
    serverUrl: `https://${serverId}.example.com/mcp`,
    transport: 'streamable_http',
    tags: [],
    source: 'custom',
    ...overrides,
  };
}

function binding(
  bindingId: string,
  serverId: string,
  overrides: Partial<McpServerBindingWrite> = {},
): McpServerBindingWrite {
  return {
    bindingId,
    serverId,
    name: `${bindingId} binding`,
    auth: { type: 'none' },
    connectionPolicy: {},
    subscribeListChanged: true,
    samplingPolicy: 'off',
    ownerScope: 'space',
    clientScope: 'platform',
    enabled: false,
    ...overrides,
  } as McpServerBindingWrite;
}

describeDb('MCP integration admin SQL (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const inSpace = { db, tenantId: TENANT_ID, spaceId: SPACE };
  const inOtherSpace = { db, tenantId: TENANT_ID, spaceId: OTHER_SPACE };

  let schemaReady = false;

  async function query<T>(statement: SQL): Promise<T[]> {
    return (await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute(statement),
    )) as unknown as T[];
  }

  async function cleanup(): Promise<void> {
    for (const space of SPACES) {
      await query(drizzleSql`DELETE FROM mcp_server_bindings WHERE space_id = ${space}::uuid`);
      await query(drizzleSql`DELETE FROM mcp_server_definitions WHERE space_id = ${space}::uuid`);
      await query(drizzleSql`DELETE FROM api_credentials WHERE space_id = ${space}::uuid`);
      await query(drizzleSql`DELETE FROM oauth_state WHERE space_id = ${space}::uuid`);
      await query(drizzleSql`DELETE FROM oauth_tokens WHERE owner_id = ${space}`);
    }
    await query(drizzleSql`DELETE FROM oauth_tokens WHERE owner_id = 'mcp-admin-pg-user'`);
  }

  async function bindingScope(bindingId: string, spaceId: string): Promise<unknown> {
    const rows = await query<{ scope_json: unknown }>(drizzleSql`
      SELECT scope_json FROM mcp_server_bindings
      WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
    `);
    return rows[0]?.scope_json;
  }

  async function count(statement: SQL): Promise<number> {
    const rows = await query<{ n: number }>(statement);
    return rows[0]?.n ?? 0;
  }

  async function seedCredential(key: string, spaceId: string): Promise<void> {
    await query(drizzleSql`
      INSERT INTO api_credentials (credential_key, label, encrypted_value, space_id)
      VALUES (${key}, ${key}, 'not-a-real-ciphertext', ${spaceId}::uuid)
    `);
  }

  async function seedOauthToken(serverId: string, ownerScope: string, ownerId: string) {
    await query(drizzleSql`
      INSERT INTO oauth_tokens (
        integration_kind, resource_key, owner_scope, owner_id, access_token_enc, expires_at
      )
      VALUES ('mcp', ${serverId}, ${ownerScope}, ${ownerId}, 'enc', NOW() + INTERVAL '1 hour')
    `);
  }

  async function seedOauthState(state: string, serverId: string, spaceId: string) {
    await query(drizzleSql`
      INSERT INTO oauth_state (
        state, integration_kind, resource_key, binding_id, space_id,
        owner_scope, owner_id, client_scope, code_verifier, redirect_uri, expires_at
      )
      VALUES (
        ${state}, 'mcp', ${serverId}, 'any-binding', ${spaceId}::uuid,
        'space', ${spaceId}, 'platform', 'verifier', 'http://localhost/cb',
        NOW() + INTERVAL '10 minutes'
      )
    `);
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'mcp_server_bindings'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
  });

  beforeEach(async () => {
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
    return schemaReady;
  }

  it('reports a definition insert as created and a repeat as an update, per space', async (ctx) => {
    if (!requireSchema(ctx)) return;

    expect(await upsertMcpServerDefinition({ ...inSpace, definition: definition('docs') })).toEqual(
      { created: true },
    );
    expect(
      await upsertMcpServerDefinition({
        ...inSpace,
        definition: definition('docs', { name: 'Docs renamed' }),
      }),
    ).toEqual({ created: false });
    // The same serverId in another space is a different row.
    expect(
      await upsertMcpServerDefinition({ ...inOtherSpace, definition: definition('docs') }),
    ).toEqual({ created: true });

    const row = await getMcpServerDefinitionRow({ ...inSpace, serverId: 'docs' });
    expect(row?.name).toBe('Docs renamed');
    expect(row?.spaceId).toBe(SPACE);
    expect((await getMcpServerDefinitionRow({ ...inOtherSpace, serverId: 'docs' }))?.name).toBe(
      'docs server',
    );
  });

  it('gets and lists only the space it is asked about, honouring its filters', async (ctx) => {
    if (!requireSchema(ctx)) return;

    await upsertMcpServerDefinition({ ...inSpace, definition: definition('mine') });
    await upsertMcpServerDefinition({
      ...inSpace,
      definition: definition('bundled', { source: 'bundle' }),
    });
    await upsertMcpServerDefinition({ ...inOtherSpace, definition: definition('theirs') });
    await query(drizzleSql`
      UPDATE mcp_server_definitions SET enabled = 0
      WHERE server_id = 'bundled' AND space_id = ${SPACE}::uuid
    `);

    const ids = async (opts: Parameters<typeof listMcpServerDefinitionRows>[0]) =>
      (await listMcpServerDefinitionRows(opts)).map((row) => row.serverId).sort();

    expect(await ids(inSpace)).toEqual(['bundled', 'mine']);
    expect(await ids({ ...inSpace, source: 'bundle' })).toEqual(['bundled']);
    expect(await ids({ ...inSpace, enabled: true })).toEqual(['mine']);
    expect(await ids({ ...inSpace, enabled: false })).toEqual(['bundled']);
    expect(await ids(inOtherSpace)).toEqual(['theirs']);

    expect(await getMcpServerDefinitionRow({ ...inSpace, serverId: 'theirs' })).toBeNull();
  });

  it('keeps a stored flow narrowing when an update states no scope, and replaces it when one is stated', async (ctx) => {
    if (!requireSchema(ctx)) return;

    const identity = { tenantId: TENANT_ID, spaceId: SPACE };
    const narrowed = { flowId: 'flow-7', ...identity };

    const createdResult = await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs'),
      scope: narrowed,
      scopeOnUpdate: narrowed,
    });
    expect(createdResult).toEqual({ created: true, scope: narrowed, enabled: false });

    const kept = await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs', { name: 'Renamed' }),
      scope: identity,
      scopeOnUpdate: null,
    });
    expect(kept).toEqual({ created: false, scope: narrowed, enabled: false });
    expect(await bindingScope('docs-default', SPACE)).toEqual(narrowed);

    const widened = await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs'),
      scope: identity,
      scopeOnUpdate: identity,
    });
    expect(widened).toEqual({ created: false, scope: identity, enabled: false });
    expect(await bindingScope('docs-default', SPACE)).toEqual(identity);
  });

  it('updates only the stated binding fields, keeping the rest as stored', async (ctx) => {
    if (!requireSchema(ctx)) return;

    const identity = { tenantId: TENANT_ID, spaceId: SPACE };
    await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs', {
        ownerScope: 'user',
        samplingPolicy: 'no_tools',
        connectionPolicy: { timeoutMs: 9_000, maxSamplingTokens: 2_000 },
        enabled: false,
      } as Partial<McpServerBindingWrite>),
      scope: identity,
      scopeOnUpdate: null,
    });

    // What a parse fills in for an agent that sent only a name and a timeout.
    const result = await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs', {
        name: 'Renamed',
        connectionPolicy: { timeoutMs: 5_000, maxSamplingTokens: 4_096 },
        enabled: true,
      } as Partial<McpServerBindingWrite>),
      scope: identity,
      scopeOnUpdate: null,
      stated: {
        fields: new Set(['bindingId', 'serverId', 'name', 'auth', 'connectionPolicy']),
        connectionPolicy: { timeoutMs: 5_000 },
      },
    });
    expect(result).toEqual({ created: false, scope: identity, enabled: false });

    const rows = await query<Record<string, unknown>>(drizzleSql`
      SELECT name, owner_scope, sampling_policy, enabled, connection_policy_json
      FROM mcp_server_bindings
      WHERE binding_id = 'docs-default' AND space_id = ${SPACE}::uuid
    `);
    expect(rows[0]).toEqual({
      name: 'Renamed',
      owner_scope: 'user',
      sampling_policy: 'no_tools',
      enabled: 0,
      connection_policy_json: { timeoutMs: 5_000, maxSamplingTokens: 2_000 },
    });
  });

  it('updates only the stated definition fields, keeping the rest as stored', async (ctx) => {
    if (!requireSchema(ctx)) return;

    await upsertMcpServerDefinition({
      ...inSpace,
      definition: definition('docs', {
        tags: ['search'],
        source: 'bundle',
        toolFilter: { include: ['search'] },
      }),
    });
    await upsertMcpServerDefinition({
      ...inSpace,
      definition: definition('docs', { name: 'Docs renamed' }),
      statedFields: new Set(['serverId', 'name', 'serverUrl']),
    });

    const row = await getMcpServerDefinitionRow({ ...inSpace, serverId: 'docs' });
    expect(row?.name).toBe('Docs renamed');
    expect(row?.tags).toEqual(['search']);
    expect(row?.source).toBe('bundle');
    expect((row?.definitionJson as Record<string, unknown>)['toolFilter']).toEqual({
      include: ['search'],
    });
    expect((row?.definitionJson as Record<string, unknown>)['name']).toBe('Docs renamed');
  });

  it('clears the stated definition fields the update leaves out, keeping the unstated ones', async (ctx) => {
    if (!requireSchema(ctx)) return;

    await upsertMcpServerDefinition({
      ...inSpace,
      definition: definition('docs', {
        description: 'Docs search',
        toolFilter: { include: ['search'] },
        icon: { kind: 'phosphor', name: 'Books' },
        protectedResourceMetadataPath: '/.well-known/prm',
        tags: ['search'],
      }),
    });
    // What the handler writes for an agent that sent description, toolFilter and icon as null.
    await upsertMcpServerDefinition({
      ...inSpace,
      definition: definition('docs'),
      statedFields: new Set(['serverId', 'name', 'serverUrl', 'description', 'toolFilter', 'icon']),
    });

    const row = await getMcpServerDefinitionRow({ ...inSpace, serverId: 'docs' });
    expect(row?.description).toBeNull();
    expect(row?.tags).toEqual(['search']);
    const json = row?.definitionJson as Record<string, unknown>;
    expect(json).not.toHaveProperty('description');
    expect(json).not.toHaveProperty('toolFilter');
    expect(json).not.toHaveProperty('icon');
    expect(json['protectedResourceMetadataPath']).toBe('/.well-known/prm');
    expect(mcpServerDefinitionFromRow(row!)).not.toHaveProperty('toolFilter');
  });

  it('clears a stored binding description when the update states it and leaves it out', async (ctx) => {
    if (!requireSchema(ctx)) return;

    const identity = { tenantId: TENANT_ID, spaceId: SPACE };
    await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs', { description: 'Main docs binding' }),
      scope: identity,
      scopeOnUpdate: null,
    });
    const stated = (fields: Array<keyof McpServerBindingWrite>) => ({
      fields: new Set<keyof McpServerBindingWrite>([
        'bindingId',
        'serverId',
        'name',
        'auth',
        ...fields,
      ]),
      connectionPolicy: {},
    });
    const storedDescription = async () =>
      (
        await query<{ description: string | null }>(drizzleSql`
          SELECT description FROM mcp_server_bindings
          WHERE binding_id = 'docs-default' AND space_id = ${SPACE}::uuid
        `)
      )[0]?.description;

    // Left out: kept.
    await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs'),
      scope: identity,
      scopeOnUpdate: null,
      stated: stated([]),
    });
    expect(await storedDescription()).toBe('Main docs binding');

    // Stated and absent (sent as null): cleared.
    await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs'),
      scope: identity,
      scopeOnUpdate: null,
      stated: stated(['description']),
    });
    expect(await storedDescription()).toBeNull();
  });

  it('refuses to enable a credentialed binding until its origin is pinned in the same space', async (ctx) => {
    if (!requireSchema(ctx)) return;

    const identity = { tenantId: TENANT_ID, spaceId: SPACE };
    const credentialed = {
      auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
    } as Partial<McpServerBindingWrite>;
    await upsertMcpServerBinding({
      ...inSpace,
      binding: binding('docs-default', 'docs', credentialed),
      scope: identity,
      scopeOnUpdate: null,
    });
    // A pin on the same bindingId in another space must not count.
    await upsertMcpServerBinding({
      ...inOtherSpace,
      binding: binding('docs-default', 'docs', credentialed),
      scope: { tenantId: TENANT_ID, spaceId: OTHER_SPACE },
      scopeOnUpdate: null,
    });
    await query(drizzleSql`
      UPDATE mcp_server_bindings SET pinned_origin = 'https://docs.example.com'
      WHERE binding_id = 'docs-default' AND space_id = ${OTHER_SPACE}::uuid
    `);

    const enable = () =>
      upsertMcpServerBinding({
        ...inSpace,
        binding: binding('docs-default', 'docs', { ...credentialed, enabled: true }),
        scope: identity,
        scopeOnUpdate: null,
      });
    await expect(enable()).rejects.toBeInstanceOf(McpBindingOriginNotPinnedError);
    expect(
      await count(drizzleSql`
        SELECT COUNT(*)::int AS n FROM mcp_server_bindings
        WHERE binding_id = 'docs-default' AND space_id = ${SPACE}::uuid AND enabled = 1
      `),
    ).toBe(0);

    await query(drizzleSql`
      UPDATE mcp_server_bindings SET pinned_origin = 'https://docs.example.com'
      WHERE binding_id = 'docs-default' AND space_id = ${SPACE}::uuid
    `);
    await expect(enable()).resolves.toMatchObject({ created: false });
  });

  it('deletes one binding in its own space and reports a missing one as null', async (ctx) => {
    if (!requireSchema(ctx)) return;

    for (const scope of [inSpace, inOtherSpace]) {
      await upsertMcpServerBinding({
        ...scope,
        binding: binding('docs-default', 'docs'),
        scope: { tenantId: TENANT_ID, spaceId: scope.spaceId },
        scopeOnUpdate: null,
      });
    }

    expect(await deleteMcpServerBinding({ ...inSpace, bindingId: 'docs-default' })).toEqual({
      serverId: 'docs',
    });
    expect(await bindingScope('docs-default', SPACE)).toBeUndefined();
    expect(await bindingScope('docs-default', OTHER_SPACE)).toBeDefined();
    expect(await deleteMcpServerBinding({ ...inSpace, bindingId: 'docs-default' })).toBeNull();
  });

  it("deletes a server with its bindings, the space's tokens and state, and credentials nothing else uses", async (ctx) => {
    if (!requireSchema(ctx)) return;

    await upsertMcpServerDefinition({ ...inSpace, definition: definition('docs') });
    await upsertMcpServerDefinition({ ...inSpace, definition: definition('other') });
    await upsertMcpServerDefinition({ ...inOtherSpace, definition: definition('docs') });

    const bearer = (credentialKey: string) =>
      ({ auth: { type: 'bearer', credentialKey } }) as Partial<McpServerBindingWrite>;
    const write = (
      scope: typeof inSpace,
      bindingId: string,
      serverId: string,
      overrides: Partial<McpServerBindingWrite>,
    ) =>
      upsertMcpServerBinding({
        ...scope,
        binding: binding(bindingId, serverId, overrides),
        scope: { tenantId: TENANT_ID, spaceId: scope.spaceId },
        scopeOnUpdate: null,
      });
    await write(inSpace, 'docs-a', 'docs', bearer('DOCS_ONLY'));
    await write(inSpace, 'docs-b', 'docs', bearer('SHARED'));
    await write(inSpace, 'other-a', 'other', bearer('SHARED'));
    await write(inOtherSpace, 'docs-a', 'docs', bearer('DOCS_ONLY'));

    for (const key of ['DOCS_ONLY', 'SHARED']) await seedCredential(key, SPACE);
    await seedCredential('DOCS_ONLY', OTHER_SPACE);
    await seedOauthToken('docs', 'space', SPACE);
    await seedOauthToken('docs', 'space', OTHER_SPACE);
    await seedOauthToken('docs', 'user', 'mcp-admin-pg-user');
    await seedOauthState('mcp-admin-pg-state-a', 'docs', SPACE);
    await seedOauthState('mcp-admin-pg-state-b', 'docs', OTHER_SPACE);

    expect(await deleteMcpServerDefinition({ ...inSpace, serverId: 'docs' })).toEqual({
      deleted: true,
    });

    const bindingsLeft = await query<{ binding_id: string; space_id: string }>(drizzleSql`
      SELECT binding_id, space_id FROM mcp_server_bindings
      WHERE space_id IN (${SPACE}::uuid, ${OTHER_SPACE}::uuid)
      ORDER BY space_id, binding_id
    `);
    expect(bindingsLeft).toEqual([
      { binding_id: 'other-a', space_id: SPACE },
      { binding_id: 'docs-a', space_id: OTHER_SPACE },
    ]);
    expect(await getMcpServerDefinitionRow({ ...inSpace, serverId: 'docs' })).toBeNull();
    expect(await getMcpServerDefinitionRow({ ...inSpace, serverId: 'other' })).not.toBeNull();
    expect(await getMcpServerDefinitionRow({ ...inOtherSpace, serverId: 'docs' })).not.toBeNull();

    const credentials = await query<{ credential_key: string; space_id: string }>(drizzleSql`
      SELECT credential_key, space_id FROM api_credentials
      WHERE space_id IN (${SPACE}::uuid, ${OTHER_SPACE}::uuid)
      ORDER BY space_id, credential_key
    `);
    expect(credentials).toEqual([
      { credential_key: 'SHARED', space_id: SPACE },
      { credential_key: 'DOCS_ONLY', space_id: OTHER_SPACE },
    ]);

    const tokens = await query<{ owner_scope: string; owner_id: string }>(drizzleSql`
      SELECT owner_scope, owner_id FROM oauth_tokens
      WHERE integration_kind = 'mcp' AND resource_key = 'docs'
      ORDER BY owner_scope, owner_id
    `);
    expect(tokens).toEqual([
      { owner_scope: 'space', owner_id: OTHER_SPACE },
      { owner_scope: 'user', owner_id: 'mcp-admin-pg-user' },
    ]);

    const states = await query<{ state: string }>(drizzleSql`
      SELECT state FROM oauth_state WHERE state LIKE 'mcp-admin-pg-state-%' ORDER BY state
    `);
    expect(states).toEqual([{ state: 'mcp-admin-pg-state-b' }]);

    expect(await deleteMcpServerDefinition({ ...inSpace, serverId: 'docs' })).toEqual({
      deleted: false,
    });
  });
});
