/**
 * PUT /mcp/servers/:serverId/private-network (Plan 336 D2, D5, D7): the
 * acknowledgment's one write path. A service principal is refused, the hosted
 * edition refuses a host its deployment does not list, every set and clear
 * writes an audit row naming the actor, and deleting a definition that holds a
 * record writes the cleared row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const SPACE = '3c930000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-0000000000aa';
const HOST = 'mcp.corp.example';

const state = vi.hoisted(() => ({
  edition: 'community-local' as 'community-local' | 'enterprise',
  definitions: new Map<string, unknown>(),
  audit: [] as unknown[][],
  executed: [] as string[],
}));

const dialect = new PgDialect();

function execute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  state.executed.push(text);
  if (text.includes('SELECT private_network_json FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    return state.definitions.has(serverId)
      ? [{ private_network_json: state.definitions.get(serverId) ?? null }]
      : [];
  }
  if (text.includes('UPDATE mcp_server_definitions')) {
    const [record, serverId] = params as [string | null, string];
    state.definitions.set(serverId, record === null ? null : JSON.parse(record));
    return [];
  }
  if (text.includes('DELETE FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    const record = state.definitions.get(serverId);
    state.definitions.delete(serverId);
    return [{ private_network_json: record ?? null }];
  }
  if (text.includes('INSERT INTO tenant_audit_log')) {
    state.audit.push(params);
    return [];
  }
  return [];
}

const fakeTx = {
  execute: async (query: SQL) => execute(query),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [...state.definitions.keys()].map((serverId) => ({ serverId })),
      }),
    }),
  }),
};

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  publishMcpCatalogInvalidation: vi.fn(),
}));

vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  return {
    ...actual,
    processEditionDescriptor: () => ({
      ...actual.processEditionDescriptor(),
      edition: state.edition,
    }),
    isLocalEdition: () => state.edition === 'community-local',
  };
});

const { registerMcpServerRoutes } = await import('./mcp-servers.js');

let app: FastifyInstance;
let principal: FastifyRequest['authUser'];
const routeAuthz = new Map<string, unknown>();

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  (instance as unknown as { appContext: unknown }).appContext = { db: {}, redis: null };
  instance.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: 'a0000000-0000-0000-0000-000000000001' });
    (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
      async () => ({ spaceId: SPACE });
    request.authUser = principal;
  });
  instance.addHook('onRoute', (route) => {
    routeAuthz.set(
      `${String(route.method)} ${route.url}`,
      (route.config as { authz?: unknown })?.authz,
    );
  });
  registerMcpServerRoutes(instance);
  await instance.ready();
  return instance;
}

function put(hosts: string[], serverId = 'corp') {
  return app.inject({
    method: 'PUT',
    url: `/mcp/servers/${serverId}/private-network`,
    payload: { hosts },
  });
}

function auditRow(index: number) {
  const [actorId, actorKind, action, resourceId, spaceId, details] = state.audit[index] as [
    string | null,
    string,
    string,
    string,
    string,
    string,
  ];
  return { actorId, actorKind, action, resourceId, spaceId, details: JSON.parse(details) };
}

beforeEach(async () => {
  state.edition = 'community-local';
  state.definitions = new Map([['corp', null]]);
  state.audit = [];
  state.executed = [];
  delete process.env['MCP_PRIVATE_NETWORK_HOSTS'];
  principal = {
    userId: USER,
    roles: [],
    authMethod: 'session',
    isServicePrincipal: false,
  } as unknown as FastifyRequest['authUser'];
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  delete process.env['MCP_PRIVATE_NETWORK_HOSTS'];
});

describe('PUT /mcp/servers/:serverId/private-network', () => {
  it('requires api_config write, as a definition does', () => {
    expect(routeAuthz.get('PUT /mcp/servers/:serverId/private-network')).toEqual(
      routeAuthz.get('POST /mcp/servers'),
    );
    expect(routeAuthz.get('PUT /mcp/servers/:serverId/private-network')).toMatchObject({
      resource: 'api_config',
      action: 'write',
    });
    expect([...routeAuthz.keys()].filter((key) => key.includes('private-network'))).toEqual([
      'PUT /mcp/servers/:serverId/private-network',
    ]);
  });

  it('refuses a service principal and writes nothing', async () => {
    principal = { ...principal!, isServicePrincipal: true };
    const res = await put([HOST]);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'operator_only' });
    expect(state.executed).toEqual([]);
  });

  it('sets the hosts in the local edition and audits the set with the actor', async () => {
    const res = await put([HOST]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      serverId: 'corp',
      action: 'set',
      privateNetwork: { hosts: [HOST], setBy: USER },
    });
    expect(state.audit).toHaveLength(1);
    expect(auditRow(0)).toMatchObject({
      actorId: USER,
      actorKind: 'human',
      action: 'mcp.private_network.set',
      resourceId: 'corp',
      spaceId: SPACE,
      details: { hostsBefore: [], hostsAfter: [HOST], edition: 'community-local' },
    });
  });

  it('clears the hosts with an empty list and audits the clear', async () => {
    await put([HOST]);
    const res = await put([]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: 'corp', action: 'cleared', privateNetwork: null });
    expect(auditRow(1)).toMatchObject({
      actorId: USER,
      action: 'mcp.private_network.cleared',
      details: { hostsBefore: [HOST], hostsAfter: [] },
    });
  });

  it('refuses a metadata name as a listed host', async () => {
    const res = await put(['metadata.google.internal']);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PRIVATE_NETWORK_HOST_REFUSED' });
    expect(state.audit).toEqual([]);
  });

  it('refuses a literal address no policy lifts and stores nothing', async () => {
    const res = await put(['100.100.100.200']);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PRIVATE_NETWORK_HOST_REFUSED' });
    expect(res.json().error).toContain('a range the platform never admits (cloud-metadata)');
    expect(state.audit).toEqual([]);
  });

  it('answers 404 for a definition the space does not hold', async () => {
    const res = await put([HOST], 'missing');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'MCP_SERVER_NOT_FOUND' });
  });

  describe('in the hosted edition', () => {
    beforeEach(() => {
      state.edition = 'enterprise';
    });

    it('refuses a host missing from MCP_PRIVATE_NETWORK_HOSTS, naming the variable', async () => {
      const res = await put([HOST]);
      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string; error: string };
      expect(body.code).toBe('PRIVATE_NETWORK_HOST_NOT_LISTED');
      expect(body.error).toContain('MCP_PRIVATE_NETWORK_HOSTS');
      expect(state.definitions.get('corp')).toBeNull();
      expect(state.audit).toEqual([]);
    });

    it('accepts a host the deployment lists', async () => {
      process.env['MCP_PRIVATE_NETWORK_HOSTS'] = `other.corp.example, ${HOST}`;
      const res = await put([HOST]);
      expect(res.statusCode).toBe(200);
      expect(auditRow(0).details).toMatchObject({ edition: 'enterprise' });
    });
  });
});

describe('DELETE /mcp/servers/:serverId', () => {
  it('writes the cleared row, naming the actor, when the definition held hosts', async () => {
    await put([HOST]);
    const res = await app.inject({ method: 'DELETE', url: '/mcp/servers/corp' });
    expect(res.statusCode).toBe(200);
    expect(state.audit).toHaveLength(2);
    expect(auditRow(1)).toMatchObject({
      actorId: USER,
      actorKind: 'human',
      action: 'mcp.private_network.cleared',
      resourceId: 'corp',
      details: { hostsBefore: [HOST], hostsAfter: [], cause: 'definition_deleted' },
    });
  });

  it('writes no row when the definition held none', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/mcp/servers/corp' });
    expect(res.statusCode).toBe(200);
    expect(state.audit).toEqual([]);
  });
});
