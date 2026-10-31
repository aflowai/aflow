/**
 * Plan 336 D1, D3 and D5 at the MCP executor. The space loader builds each
 * definition's policy from its stored acknowledgment, the edition and the
 * deployment list. The managed connect passes it. The raw `serverUrl` path,
 * which an agent chooses, keeps the default.
 *
 * Every address here is a canonical dotted quad, so no case resolves a name,
 * and a connect that would pass the guard is stopped by a stub before it dials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { DEFAULT_PRIVATE_NETWORK_POLICY, type PrivateNetworkPolicy } from '@aflow/network-safety';

const SPACE = '3c940000-0000-4000-8000-0000000000e1';
const TENANT = 'a0000000-0000-0000-0000-000000000001';

const state = vi.hoisted(() => ({
  edition: 'community-local' as 'community-local' | 'enterprise',
  serverUrl: 'https://10.1.2.3/mcp',
  privateNetworkJson: null as unknown,
}));

vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  return {
    ...actual,
    processEditionDescriptor: () => ({
      ...actual.processEditionDescriptor(),
      edition: state.edition,
    }),
  };
});

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === actual.mcpServerDefinitions) {
      return [
        {
          definitionJson: {
            serverId: 'corp',
            name: 'Corp',
            serverUrl: state.serverUrl,
            transport: 'streamable_http',
            tags: [],
            source: 'custom',
          },
          privateNetworkJson: state.privateNetworkJson,
        },
      ];
    }
    if (table === actual.mcpServerBindings) {
      return [
        {
          bindingId: 'corp-default',
          serverId: 'corp',
          name: 'Corp default',
          spaceId: SPACE,
          scopeJson: { tenantId: TENANT },
          authJson: { type: 'none' },
          connectionPolicyJson: {},
          subscribeListChanged: 0,
          samplingPolicy: 'off',
          ownerScope: 'space',
          clientScope: 'platform',
          enabled: 1,
        },
      ];
    }
    return [];
  };
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: async () => rowsFor(table) }) }),
  };
  const open = { mode: 'open', allowlist: [] };
  return {
    ...actual,
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (t: unknown) => unknown) => fn(tx),
    createTenantPolicyCache: () => ({ load: async () => open, peek: () => open }),
  };
});

const { McpHandler } = await import('./mcpHandler.js');

const RECORD = {
  hosts: ['10.1.2.3'],
  setBy: '00000000-0000-4000-8000-0000000000aa',
  setAt: '2026-10-30T12:00:00.000Z',
};

function context(operationId: string, input: unknown): ExecutorContext {
  return {
    operationId,
    stepExecutionId: 'se-1',
    job: { tenantId: TENANT, spaceId: SPACE, inputRef: 'inline:input' },
    readPayload: async () => input,
    writePayload: async () => 'inline:written',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ExecutorContext;
}

type Acquire = (
  key: string,
  serverUrl: string,
  headers: Record<string, string>,
  privateNetwork: PrivateNetworkPolicy,
) => Promise<unknown>;

let handler: InstanceType<typeof McpHandler>;
let acquire: ReturnType<typeof vi.fn<Acquire>>;

function failure(result: StepResult) {
  expect(result.status).toBe('FAILED');
  return (result as { error: { code: string; message: string; details?: Record<string, unknown> } })
    .error;
}

beforeEach(() => {
  state.edition = 'community-local';
  state.serverUrl = 'https://10.1.2.3/mcp';
  state.privateNetworkJson = RECORD;
  delete process.env['MCP_PRIVATE_NETWORK_HOSTS'];
  handler = new McpHandler({ db: {} });
  acquire = vi.fn<Acquire>(async () => {
    throw new Error('stub: the guard passed and the connect was reached');
  });
  (handler as unknown as { acquire: Acquire }).acquire = acquire;
});

afterEach(async () => {
  await handler.shutdown();
  delete process.env['MCP_PRIVATE_NETWORK_HOSTS'];
});

const test = () => handler.execute(context('mcp.binding.test', { bindingId: 'corp-default' }));

describe('the managed connect', () => {
  it('reaches a listed private host in the local edition, carrying the policy to the transport', async () => {
    const error = failure(await test());
    expect(error.message).toContain('stub: the guard passed');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]?.[3]?.hosts).toEqual(['10.1.2.3']);
  });

  it('refuses the host without an acknowledgment, naming the range and the remedy', async () => {
    state.privateNetworkJson = null;
    const error = failure(await test());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual({
      kind: 'private-ip',
      target: '10.1.2.3',
      rangeLabel: 'private-rfc1918',
      remedy: 'acknowledge_private_network',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses a serverUrl an agent rewrote to another private host', async () => {
    state.serverUrl = 'https://10.9.9.9/mcp';
    const error = failure(await test());
    expect(error.details).toMatchObject({ target: '10.9.9.9', rangeLabel: 'private-rfc1918' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('keeps every other range refused for a listed host', async () => {
    state.serverUrl = 'https://169.254.169.254/mcp';
    state.privateNetworkJson = { ...RECORD, hosts: ['169.254.169.254'] };
    const error = failure(await test());
    expect(error.details).toMatchObject({ rangeLabel: 'cloud-metadata', remedy: 'none' });
  });
});

describe('the hosted edition', () => {
  beforeEach(() => {
    state.edition = 'enterprise';
  });

  it('refuses a stored record the deployment does not list, with the deployment remedy', async () => {
    const error = failure(await test());
    expect(error.details).toMatchObject({
      rangeLabel: 'private-rfc1918',
      remedy: 'deployment_must_list_host',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('honours the record once the deployment lists the host', async () => {
    process.env['MCP_PRIVATE_NETWORK_HOSTS'] = '10.1.2.3';
    const error = failure(await test());
    expect(error.message).toContain('stub: the guard passed');
  });
});

describe('the raw serverUrl path', () => {
  it('keeps the default policy for the host a definition lists', async () => {
    await handler.execute(
      context('mcp.tool.call', { serverUrl: 'https://10.1.2.3/mcp', toolName: 'search' }),
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]?.[3]).toBe(DEFAULT_PRIVATE_NETWORK_POLICY);
  });

  it('is refused at the transport for that host', async () => {
    (handler as unknown as { acquire: unknown }).acquire = Object.getPrototypeOf(handler).acquire;
    const error = failure(
      await handler.execute(
        context('mcp.tool.call', { serverUrl: 'https://10.1.2.3/mcp', toolName: 'search' }),
      ),
    );
    expect(error.message).toContain('private-rfc1918');
  });
});
