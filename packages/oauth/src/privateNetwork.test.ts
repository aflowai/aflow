/**
 * Plan 336 D3: an MCP binding's discovery and token exchanges run under its
 * definition's private network policy, carried on `McpDiscovery`. An API
 * binding carries no discovery descriptor and keeps the default.
 *
 * The private host is the canonical quad 10.1.2.3, so no case resolves a name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRIVATE_NETWORK_POLICY,
  privateNetworkPolicyFor,
  type PrivateNetworkPolicy,
} from '@aflow/network-safety';
import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';

const state = vi.hoisted(() => ({
  edition: 'community-local' as 'community-local' | 'enterprise',
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

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ insert: () => ({ values: async () => undefined }) }),
}));

const { discoverPRM, discoverPRMReactive, clearPrmCacheForTests } =
  await import('./prmDiscovery.js');
const { discoverAsMetadata, clearAsCacheForTests } = await import('./asMetadata.js');
const { postToTokenEndpoint, startConsent } = await import('./tokenManager.js');
const { buildMcpOAuthDescriptor, mcpPrivateNetworkPolicy } = await import('./mcpBinding.js');

const SERVER = 'https://10.1.2.3/mcp';
const ISSUER = 'https://10.1.2.3';

const listed = privateNetworkPolicyFor({
  acknowledgment: { hosts: ['10.1.2.3'] },
  edition: 'community-local',
  deploymentHosts: [],
});

const documents: Record<string, unknown> = {
  'https://10.1.2.3/.well-known/oauth-protected-resource/mcp': {
    resource: SERVER,
    authorization_servers: [ISSUER],
  },
  'https://10.1.2.3/.well-known/oauth-authorization-server': {
    issuer: ISSUER,
    authorization_endpoint: 'https://10.1.2.3/authorize',
    token_endpoint: 'https://10.1.2.3/token',
  },
  'https://10.1.2.3/token': { access_token: 'tok', token_type: 'Bearer' },
};

let dialled: string[];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      dialled.push(url);
      const body = documents[url];
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }),
  );
}

beforeEach(() => {
  dialled = [];
  state.edition = 'community-local';
  clearPrmCacheForTests();
  clearAsCacheForTests();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discovery through the default transport', () => {
  it('discoverPRM reaches a listed private server and refuses it under the default', async () => {
    await expect(discoverPRM(SERVER, { privateNetwork: listed })).resolves.toMatchObject({
      prm: { authorization_servers: [ISSUER] },
    });
    clearPrmCacheForTests();
    await expect(discoverPRM(SERVER)).rejects.toMatchObject({ rangeLabel: 'private-rfc1918' });
  });

  it('discoverPRMReactive follows a listed resource_metadata URL and drops it under the default', async () => {
    const header = `Bearer resource_metadata="https://10.1.2.3/.well-known/oauth-protected-resource/mcp"`;
    await expect(
      discoverPRMReactive(SERVER, header, { privateNetwork: listed }),
    ).resolves.toMatchObject({ source: 'www-authenticate' });
    await expect(discoverPRMReactive(SERVER, header)).resolves.toBeNull();
  });

  it('discoverAsMetadata reaches a listed private issuer and refuses it under the default', async () => {
    await expect(discoverAsMetadata(ISSUER, { privateNetwork: listed })).resolves.toMatchObject({
      token_endpoint: 'https://10.1.2.3/token',
    });
    clearAsCacheForTests();
    await expect(discoverAsMetadata(ISSUER)).rejects.toMatchObject({
      rangeLabel: 'private-rfc1918',
    });
  });
});

/**
 * A cached document carries the reach of the policy it was fetched under. It
 * is served only to a caller whose own policy admits the host that produced
 * it, so the cache never lends one definition's acknowledgment to another.
 */
describe('the discovery caches', () => {
  it('refuse a cached PRM document to a caller whose policy refuses its host', async () => {
    await discoverPRM(SERVER, { privateNetwork: listed });
    await expect(discoverPRM(SERVER)).rejects.toMatchObject({ rangeLabel: 'private-rfc1918' });
    await expect(discoverPRM(SERVER, { privateNetwork: listed })).resolves.toMatchObject({
      prm: { authorization_servers: [ISSUER] },
    });
    expect(dialled).toHaveLength(1);
  });

  it('refuse a cached AS document to a caller whose policy refuses the issuer', async () => {
    await discoverAsMetadata(ISSUER, { privateNetwork: listed });
    await expect(discoverAsMetadata(ISSUER)).rejects.toMatchObject({
      rangeLabel: 'private-rfc1918',
    });
    await expect(discoverAsMetadata(ISSUER, { privateNetwork: listed })).resolves.toMatchObject({
      token_endpoint: 'https://10.1.2.3/token',
    });
    expect(dialled).toHaveLength(1);
  });

  it('check the host that served a cached PRM document, not only the server', async () => {
    const publicServer = 'https://198.51.100.7/mcp';
    const metadataUrl = 'https://10.1.2.3/prm-for-public';
    documents[metadataUrl] = { resource: publicServer, authorization_servers: [ISSUER] };
    try {
      await expect(
        discoverPRMReactive(publicServer, `Bearer resource_metadata="${metadataUrl}"`, {
          privateNetwork: listed,
        }),
      ).resolves.toMatchObject({ metadataUrl });
      await expect(discoverPRM(publicServer)).rejects.toMatchObject({
        rangeLabel: 'private-rfc1918',
      });
      await expect(discoverPRM(publicServer, { privateNetwork: listed })).resolves.toMatchObject({
        metadataUrl,
      });
    } finally {
      delete documents[metadataUrl];
    }
  });
});

describe('postToTokenEndpoint', () => {
  const post = (tokenEndpoint: string, privateNetwork?: PrivateNetworkPolicy) =>
    postToTokenEndpoint({
      tokenEndpoint,
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c' }),
      clientId: 'client-1',
      failureCode: 'oauth_token_exchange_failed',
      missingTokenCode: 'oauth_token_response_missing_access_token',
      ...(privateNetwork ? { privateNetwork } : {}),
    });

  it('exchanges with a listed private endpoint over https', async () => {
    await expect(post('https://10.1.2.3/token', listed)).resolves.toMatchObject({
      access_token: 'tok',
    });
  });

  it('refuses http to a listed endpoint, and the private endpoint under the default', async () => {
    await expect(post('http://10.1.2.3/token', listed)).rejects.toMatchObject({
      kind: 'invalid-protocol',
    });
    await expect(post('https://10.1.2.3/token')).rejects.toMatchObject({
      rangeLabel: 'private-rfc1918',
    });
    expect(dialled).toEqual([]);
  });
});

describe('the policy carried on McpDiscovery', () => {
  const binding = {
    bindingId: 'corp-default',
    serverId: 'corp',
    auth: { type: 'oauth2_pkce' },
    clientScope: 'platform',
    ownerScope: 'space',
  } as unknown as McpServerBinding;
  const definition = { serverId: 'corp', serverUrl: SERVER } as McpServerDefinition;

  function consent(privateNetwork: PrivateNetworkPolicy) {
    const descriptor = buildMcpOAuthDescriptor(binding, definition, privateNetwork);
    return startConsent({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '3c950000-0000-4000-8000-0000000000f1',
      target: {
        integrationKind: 'mcp',
        resourceKey: 'corp',
        bindingId: 'corp-default',
        ownerScope: 'space',
        ownerId: '3c950000-0000-4000-8000-0000000000f1',
        clientScope: 'platform',
        issuerKey: descriptor.issuerKey,
        platformClientId: 'https://aflow.example/cimd',
      },
      discovery: descriptor.discovery,
      redirectUri: 'http://127.0.0.1:3000/v1/oauth/callback',
      db: {},
    });
  }

  it('builds the descriptor with the policy it was given', () => {
    expect(buildMcpOAuthDescriptor(binding, definition, listed).discovery.privateNetwork).toBe(
      listed,
    );
  });

  it('lets consent discover a listed private server and its authorization server', async () => {
    const result = await consent(listed);
    expect(new URL(result.authorizationUrl).origin).toBe(ISSUER);
    expect(dialled).toContain('https://10.1.2.3/.well-known/oauth-authorization-server');
  });

  it('refuses consent discovery under the default policy', async () => {
    await expect(consent(DEFAULT_PRIVATE_NETWORK_POLICY)).rejects.toMatchObject({
      rangeLabel: 'private-rfc1918',
    });
    expect(dialled).toEqual([]);
  });
});

describe('mcpPrivateNetworkPolicy', () => {
  const record = {
    hosts: ['10.1.2.3'],
    setBy: '00000000-0000-4000-8000-0000000000aa',
    setAt: '2026-10-30T12:00:00.000Z',
  };

  it('takes a stored record as set in the local edition', () => {
    expect(mcpPrivateNetworkPolicy(record, {})).toMatchObject({ hosts: ['10.1.2.3'] });
  });

  it('withholds a host the hosted deployment does not list, and honours one it does', () => {
    state.edition = 'enterprise';
    expect(mcpPrivateNetworkPolicy(record, {})).toMatchObject({
      hosts: [],
      withheld: ['10.1.2.3'],
    });
    expect(
      mcpPrivateNetworkPolicy(record, { MCP_PRIVATE_NETWORK_HOSTS: '10.1.2.3' }),
    ).toMatchObject({ hosts: ['10.1.2.3'], withheld: [] });
  });

  it('reads no record, or one that does not parse, as the default', () => {
    expect(mcpPrivateNetworkPolicy(null, {})).toBe(DEFAULT_PRIVATE_NETWORK_POLICY);
    expect(mcpPrivateNetworkPolicy({ hosts: 'x' }, {})).toBe(DEFAULT_PRIVATE_NETWORK_POLICY);
  });
});
