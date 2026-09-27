/**
 * Connector teardown cores against an in-memory SQL dispatcher: deleting an
 * integration tears down its space-owned OAuth tokens/state (API and MCP
 * alike), cascades bindings, removes only credentials no surviving binding
 * references, and drops the definition last.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deleteApiIntegration, deleteMcpIntegration } from './connectorUninstall.js';

interface ApiBindingRow {
  api_id: string;
  binding_id: string;
  auth_json: Record<string, unknown>;
}

interface McpBindingRow {
  server_id: string;
  binding_id: string;
  auth_json: Record<string, unknown>;
}

const store = {
  apiBindings: [] as ApiBindingRow[],
  mcpBindings: [] as McpBindingRow[],
  apiDefinitionDeletes: [] as string[],
  mcpDefinitionDeletes: [] as string[],
  credentialDeletes: [] as string[],
  oauthTokenDeletes: [] as Array<{ integrationKind: string; resourceKey: string; ownerId: string }>,
  oauthStateDeletes: [] as Array<{ integrationKind: string; resourceKey: string; spaceId: string }>,
};

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('DELETE FROM oauth_tokens')) {
    const [resourceKey, ownerId] = params as [string, string];
    store.oauthTokenDeletes.push({
      integrationKind: text.includes("integration_kind = 'api'") ? 'api' : 'mcp',
      resourceKey,
      ownerId,
    });
    return [];
  }
  if (text.includes('DELETE FROM oauth_state')) {
    const [resourceKey, spaceId] = params as [string, string];
    store.oauthStateDeletes.push({
      integrationKind: text.includes("integration_kind = 'api'") ? 'api' : 'mcp',
      resourceKey,
      spaceId,
    });
    return [];
  }
  if (text.includes('DELETE FROM api_bindings')) {
    const [apiId] = params as [string];
    store.apiBindings = store.apiBindings.filter((row) => row.api_id !== apiId);
    return [];
  }
  if (text.includes('DELETE FROM mcp_server_bindings')) {
    const [serverId] = params as [string];
    store.mcpBindings = store.mcpBindings.filter((row) => row.server_id !== serverId);
    return [];
  }
  if (text.includes('DELETE FROM api_credentials')) {
    const [credentialKey] = params as [string];
    store.credentialDeletes.push(credentialKey);
    return [];
  }
  if (text.includes('DELETE FROM api_definitions')) {
    const [apiId] = params as [string];
    store.apiDefinitionDeletes.push(apiId);
    return [];
  }
  if (text.includes('DELETE FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    store.mcpDefinitionDeletes.push(serverId);
    return [];
  }
  if (text.includes('SELECT auth_json FROM api_bindings')) {
    if (text.includes('api_id =')) {
      const [apiId] = params as [string];
      return store.apiBindings.filter((row) => row.api_id === apiId);
    }
    return store.apiBindings;
  }
  if (text.includes('SELECT auth_json FROM mcp_server_bindings')) {
    if (text.includes('server_id =')) {
      const [serverId] = params as [string];
      return store.mcpBindings.filter((row) => row.server_id === serverId);
    }
    return store.mcpBindings;
  }
  throw new Error(`connectorUninstall.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) } as never;

const SPACE_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  store.apiBindings = [];
  store.mcpBindings = [];
  store.apiDefinitionDeletes = [];
  store.mcpDefinitionDeletes = [];
  store.credentialDeletes = [];
  store.oauthTokenDeletes = [];
  store.oauthStateDeletes = [];
});

describe('deleteApiIntegration', () => {
  it('tears down space-owned OAuth tokens/state, bindings, unreferenced credentials, then the definition', async () => {
    store.apiBindings.push({
      api_id: 'github',
      binding_id: 'github-default',
      auth_json: { type: 'bearer', credentialKey: 'github-default-token' },
    });

    await deleteApiIntegration(fakeTx, SPACE_ID, 'github');

    expect(store.oauthTokenDeletes).toEqual([
      { integrationKind: 'api', resourceKey: 'github', ownerId: SPACE_ID },
    ]);
    expect(store.oauthStateDeletes).toEqual([
      { integrationKind: 'api', resourceKey: 'github', spaceId: SPACE_ID },
    ]);
    expect(store.apiBindings).toEqual([]);
    expect(store.credentialDeletes).toEqual(['github-default-token']);
    expect(store.apiDefinitionDeletes).toEqual(['github']);
  });

  it('keeps a credential another surviving binding still references', async () => {
    store.apiBindings.push(
      {
        api_id: 'github',
        binding_id: 'github-default',
        auth_json: { type: 'bearer', credentialKey: 'shared-token' },
      },
      {
        api_id: 'other-api',
        binding_id: 'other-default',
        auth_json: { type: 'bearer', credentialKey: 'shared-token' },
      },
    );

    await deleteApiIntegration(fakeTx, SPACE_ID, 'github');
    expect(store.credentialDeletes).toEqual([]);
  });
});

describe('deleteMcpIntegration', () => {
  it('mirrors the API teardown for the MCP substrate', async () => {
    store.mcpBindings.push({
      server_id: 'kaggle',
      binding_id: 'kaggle-default',
      auth_json: { type: 'bearer', credentialKey: 'kaggle-default-token' },
    });

    await deleteMcpIntegration(fakeTx, SPACE_ID, 'kaggle');

    expect(store.oauthTokenDeletes).toEqual([
      { integrationKind: 'mcp', resourceKey: 'kaggle', ownerId: SPACE_ID },
    ]);
    expect(store.oauthStateDeletes).toEqual([
      { integrationKind: 'mcp', resourceKey: 'kaggle', spaceId: SPACE_ID },
    ]);
    expect(store.mcpBindings).toEqual([]);
    expect(store.credentialDeletes).toEqual(['kaggle-default-token']);
    expect(store.mcpDefinitionDeletes).toEqual(['kaggle']);
  });
});
