/**
 * The private network acknowledgment's writer against an in-memory SQL
 * dispatcher (Plan 336 D2, D5, D7): the edition rule, the host refusals, and
 * one `tenant_audit_log` row for every set, change and clear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const SPACE = '3c920000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000aa';
const HOST = 'mcp.corp.example';

const state = vi.hoisted(() => ({
  definitions: new Map<string, unknown>(),
  updates: [] as Array<{ serverId: string; record: unknown }>,
  audit: [] as Array<{ text: string; params: unknown[] }>,
}));

const dialect = new PgDialect();

function execute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('SELECT private_network_json FROM mcp_server_definitions')) {
    const [serverId] = params as [string];
    return state.definitions.has(serverId)
      ? [{ private_network_json: state.definitions.get(serverId) ?? null }]
      : [];
  }
  if (text.includes('UPDATE mcp_server_definitions')) {
    const [record, serverId] = params as [string | null, string];
    const parsed = record === null ? null : (JSON.parse(record) as unknown);
    state.definitions.set(serverId, parsed);
    state.updates.push({ serverId, record: parsed });
    return [];
  }
  if (text.includes('INSERT INTO tenant_audit_log')) {
    state.audit.push({ text, params });
    return [];
  }
  throw new Error(`mcpPrivateNetwork.test: unhandled SQL: ${text}`);
}

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: async (query: SQL) => execute(query) }),
}));

const publish = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  publishMcpCatalogInvalidation: publish,
}));

const { setMcpPrivateNetwork, privateNetworkHostsForWrite, McpPrivateNetworkWriteError } =
  await import('../mcpPrivateNetwork.js');

type SetOptions = Parameters<typeof setMcpPrivateNetwork>[0];

function set(hosts: string[], overrides: Partial<SetOptions> = {}) {
  return setMcpPrivateNetwork({
    db: {} as SetOptions['db'],
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    spaceId: SPACE,
    redis: {} as SetOptions['redis'],
    serverId: 'corp',
    hosts,
    actor: { actorId: USER, actorKind: 'human' },
    edition: 'community-local',
    deploymentHosts: [],
    now: new Date('2026-10-30T12:00:00.000Z'),
    ...overrides,
  });
}

function auditRow(index: number) {
  const row = state.audit[index]!;
  const [actorId, actorKind, action, resourceId, spaceId, details] = row.params as [
    string | null,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    category: row.text.includes(`'security'`) ? 'security' : 'other',
    resourceType: row.text.includes(`'mcp_server_definition'`) ? 'mcp_server_definition' : 'other',
    actorId,
    actorKind,
    action,
    resourceId,
    spaceId,
    details: JSON.parse(details) as Record<string, unknown>,
  };
}

beforeEach(() => {
  state.definitions = new Map([['corp', null]]);
  state.updates = [];
  state.audit = [];
  publish.mockClear();
});

describe('setMcpPrivateNetwork', () => {
  it('sets the record with who and when, and audits the set', async () => {
    const result = await set([HOST, 'MCP.corp.example.']);

    expect(result).toEqual({
      serverId: 'corp',
      action: 'set',
      privateNetwork: { hosts: [HOST], setBy: USER, setAt: '2026-10-30T12:00:00.000Z' },
    });
    expect(state.updates).toEqual([{ serverId: 'corp', record: result.privateNetwork }]);
    expect(state.audit).toHaveLength(1);
    expect(auditRow(0)).toEqual({
      category: 'security',
      resourceType: 'mcp_server_definition',
      actorId: USER,
      actorKind: 'human',
      action: 'mcp.private_network.set',
      resourceId: 'corp',
      spaceId: SPACE,
      details: {
        serverId: 'corp',
        hostsBefore: [],
        hostsAfter: [HOST],
        edition: 'community-local',
        cause: 'route',
      },
    });
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.any(String), SPACE, {
      kind: 'definition',
      serverId: 'corp',
    });
  });

  it('audits a change with the hosts before and after', async () => {
    await set([HOST]);
    await set([HOST, 'auth.corp.example']);
    expect(state.audit).toHaveLength(2);
    expect(auditRow(1)).toMatchObject({
      action: 'mcp.private_network.set',
      details: { hostsBefore: [HOST], hostsAfter: [HOST, 'auth.corp.example'] },
    });
  });

  it('clears the record with an empty list and audits the clear', async () => {
    await set([HOST]);
    const result = await set([]);
    expect(result).toEqual({ serverId: 'corp', action: 'cleared', privateNetwork: null });
    expect(state.definitions.get('corp')).toBeNull();
    expect(auditRow(1)).toMatchObject({
      action: 'mcp.private_network.cleared',
      details: { hostsBefore: [HOST], hostsAfter: [] },
    });
  });

  it('writes nothing and audits nothing when the hosts are unchanged', async () => {
    await set([HOST]);
    const result = await set([HOST]);
    expect(result.action).toBe('unchanged');
    expect(result.privateNetwork?.hosts).toEqual([HOST]);
    expect(state.updates).toHaveLength(1);
    expect(state.audit).toHaveLength(1);

    state.definitions.set('corp', null);
    expect((await set([])).action).toBe('unchanged');
    expect(state.audit).toHaveLength(1);
  });

  it('refuses a definition the space does not hold', async () => {
    await expect(set([HOST], { serverId: 'missing' })).rejects.toMatchObject({
      code: 'MCP_SERVER_NOT_FOUND',
    });
    expect(state.audit).toHaveLength(0);
  });
});

describe('the edition rule', () => {
  it('accepts the hosts as set in the local edition', async () => {
    expect((await set([HOST], { edition: 'community-local', deploymentHosts: [] })).action).toBe(
      'set',
    );
  });

  it('refuses a host the hosted deployment does not list, naming the variable', async () => {
    const outcome = await set([HOST, 'auth.corp.example'], {
      edition: 'enterprise',
      deploymentHosts: ['auth.corp.example'],
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(McpPrivateNetworkWriteError);
    expect(outcome).toMatchObject({ code: 'PRIVATE_NETWORK_HOST_NOT_LISTED' });
    expect((outcome as Error).message).toContain('MCP_PRIVATE_NETWORK_HOSTS');
    expect((outcome as Error).message).toContain(HOST);
    expect((outcome as Error).message).not.toContain('"auth.corp.example"');
    expect(state.updates).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });

  it('accepts a host the hosted deployment lists, and audits the edition', async () => {
    await set([HOST], { edition: 'enterprise', deploymentHosts: ['MCP.Corp.Example'] });
    expect(auditRow(0).details['edition']).toBe('enterprise');
  });

  it('lets the hosted edition clear without any listing', async () => {
    await set([HOST], { edition: 'community-local' });
    expect((await set([], { edition: 'enterprise', deploymentHosts: [] })).action).toBe('cleared');
  });
});

describe('privateNetworkHostsForWrite', () => {
  const write = (hosts: string[]) =>
    privateNetworkHostsForWrite({ hosts, edition: 'community-local', deploymentHosts: [] });

  it('refuses every metadata name, in any case', () => {
    for (const host of ['metadata.google.internal', 'METADATA.goog', 'metadata']) {
      expect(() => write([host]), host).toThrow(McpPrivateNetworkWriteError);
    }
  });

  it('keeps a corporate .internal name', () => {
    expect(write(['mcp.corp.internal'])).toEqual(['mcp.corp.internal']);
  });

  it('refuses a wildcard, loopback and an IPv6 literal', () => {
    for (const host of ['*.corp.example', 'localhost', '127.0.0.1', 'fe80::1']) {
      expect(() => write([host]), host).toThrow(/PRIVATE|no setting|wildcard|"/);
    }
  });
});
