import { describe, it, expect } from 'vitest';
import {
  CatalogEntrySchema,
  CatalogEntryEnvelopeSchema,
  CatalogListingStatusSchema,
  HostManifestSchema,
} from './catalogEntry.js';
import { IconRefSchema } from './iconRef.js';

function validBundleEntry() {
  return {
    catalogId: 'my-bundle',
    kind: 'bundle' as const,
    version: 1,
    name: 'My Bundle',
    tagline: 'A useful bundle.',
    description: 'Everything you need for the thing.',
    honestyLabel: 'curated' as const,
    payload: {
      bundleId: 'my-bundle',
      version: 1,
      name: 'My Bundle',
      tagline: 'A useful bundle.',
      description: 'A longer description.',
      skillCatalogIds: ['skill-a', 'skill-b'],
    },
  };
}

function validConnectorEntry() {
  return {
    catalogId: 'exampleapi',
    kind: 'connector' as const,
    version: 3,
    name: 'Example API',
    tagline: 'Talks to api.example.com.',
    description: 'A vetted Example API connector.',
    honestyLabel: 'curated' as const,
    sourceKind: 'api' as const,
    hostManifest: { apiHosts: ['api.example.com'] },
    payload: {
      catalogId: 'exampleapi',
      version: 3,
      name: 'Example API',
      tagline: 'Talks to api.example.com.',
      description: 'A vetted Example API connector.',
      honestyLabel: 'curated' as const,
      authKind: 'bearer' as const,
      definition: {
        apiId: 'exampleapi',
        name: 'Example API',
        baseUrl: 'https://api.example.com',
        endpoints: [
          {
            endpointId: 'things.list',
            name: 'List things',
            method: 'GET' as const,
            pathTemplate: '/v1/things',
          },
        ],
      },
    },
  };
}

function validMcpConnectorEntry() {
  return {
    catalogId: 'examplemcp',
    kind: 'connector' as const,
    version: 1,
    name: 'Example MCP',
    tagline: 'Talks to mcp.example.com.',
    description: 'A vetted Example MCP connector.',
    honestyLabel: 'curated' as const,
    sourceKind: 'mcp' as const,
    hostManifest: { mcpHosts: ['mcp.example.com'] },
    payload: {
      catalogId: 'examplemcp',
      version: 1,
      name: 'Example MCP',
      tagline: 'Talks to mcp.example.com.',
      description: 'A vetted Example MCP connector.',
      honestyLabel: 'curated' as const,
      authKind: 'bearer' as const,
      credentialPrompts: [{ authField: 'credentialKey', label: 'API token' }],
      definition: {
        serverId: 'examplemcp',
        name: 'Example MCP',
        serverUrl: 'https://mcp.example.com/mcp',
      },
    },
  };
}

// ============================================================================

describe('CatalogEntrySchema — variant round-trips', () => {
  it("rejects kind 'skill' — skills are not standalone listings", () => {
    const entry = { ...validBundleEntry(), kind: 'skill' };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('parses a bundle entry', () => {
    const parsed = CatalogEntrySchema.parse(validBundleEntry());
    expect(parsed.kind).toBe('bundle');
    if (parsed.kind === 'bundle') expect(parsed.payload.skillCatalogIds).toHaveLength(2);
  });

  it('parses an api connector entry', () => {
    const parsed = CatalogEntrySchema.parse(validConnectorEntry());
    if (parsed.kind !== 'connector' || parsed.sourceKind !== 'api') {
      throw new Error('expected an api connector entry');
    }
    expect(parsed.payload.definition.baseUrl).toBe('https://api.example.com');
  });

  it('parses an mcp connector entry', () => {
    const parsed = CatalogEntrySchema.parse(validMcpConnectorEntry());
    if (parsed.kind !== 'connector' || parsed.sourceKind !== 'mcp') {
      throw new Error('expected an mcp connector entry');
    }
    expect(parsed.payload.definition.serverUrl).toBe('https://mcp.example.com/mcp');
    expect(parsed.payload.definition.transport).toBe('streamable_http');
  });

  it('rejects an unknown kind', () => {
    const entry = { ...validBundleEntry(), kind: 'memory_pack' };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects a connector entry without sourceKind', () => {
    const { sourceKind: _sourceKind, ...entry } = validConnectorEntry();
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('CatalogEntrySchema — envelope defaults', () => {
  it('defaults status, tags, and hostManifest', () => {
    const parsed = CatalogEntrySchema.parse(validBundleEntry());
    expect(parsed.status).toBe('published');
    expect(parsed.tags).toEqual([]);
    expect(parsed.hostManifest).toEqual({
      apiHosts: [],
      oauthHosts: [],
      mcpHosts: [],
      redirectHosts: [],
    });
  });

  it('accepts every listing status', () => {
    for (const status of CatalogListingStatusSchema.options) {
      const entry = { ...validBundleEntry(), status };
      expect(CatalogEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('rejects a non-slug catalogId', () => {
    const entry = { ...validBundleEntry(), catalogId: 'My Bundle' };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('CatalogEntrySchema — envelope/payload coherence', () => {
  it('rejects a bundle entry whose payload bundleId differs', () => {
    const entry = validBundleEntry();
    entry.payload.bundleId = 'other-bundle';
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'bundleId']);
    }
  });

  it('rejects a payload version that differs from the envelope version', () => {
    const entry = validConnectorEntry();
    entry.payload.version = 2;
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'version']);
    }
  });

  it('rejects a connector whose payload honestyLabel differs', () => {
    const entry = { ...validConnectorEntry(), honestyLabel: 'generated-validated' as const };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'honestyLabel']);
    }
  });

  it('rejects a payload carrying its own hidden flag — visibility lives on the envelope status', () => {
    const base = validConnectorEntry();
    const entry = { ...base, payload: { ...base.payload, hidden: true } };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'hidden']);
    }
  });

  it('rejects an mcp payload whose catalogId differs from the envelope', () => {
    const base = validMcpConnectorEntry();
    const entry = { ...base, payload: { ...base.payload, catalogId: 'other-mcp' } };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'catalogId']);
    }
  });

  it('rejects an mcp connector whose payload honestyLabel differs', () => {
    const entry = { ...validMcpConnectorEntry(), honestyLabel: 'generated-validated' as const };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'honestyLabel']);
    }
  });

  it('rejects an mcp payload carrying its own hidden flag', () => {
    const base = validMcpConnectorEntry();
    const entry = { ...base, payload: { ...base.payload, hidden: true } };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['payload', 'hidden']);
    }
  });
});

describe('CatalogEntrySchema — connector sourceKind pairing', () => {
  it("rejects sourceKind 'mcp' over an API-shaped payload", () => {
    const entry = { ...validConnectorEntry(), sourceKind: 'mcp' as const };
    const result = CatalogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.slice(0, 2)).toEqual(['payload', 'definition']);
    }
  });

  it("rejects sourceKind 'api' over an MCP-shaped payload", () => {
    const entry = { ...validMcpConnectorEntry(), sourceKind: 'api' as const };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects an mcp connector whose definition lacks serverUrl', () => {
    const base = validMcpConnectorEntry();
    const { serverUrl: _serverUrl, ...definition } = base.payload.definition;
    const entry = { ...base, payload: { ...base.payload, definition } };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects an unknown sourceKind', () => {
    const entry = { ...validMcpConnectorEntry(), sourceKind: 'grpc' };
    expect(CatalogEntrySchema.safeParse(entry).success).toBe(false);
  });
});

// ============================================================================

describe('HostManifestSchema', () => {
  it('defaults all host arrays to empty', () => {
    expect(HostManifestSchema.parse({})).toEqual({
      apiHosts: [],
      oauthHosts: [],
      mcpHosts: [],
      redirectHosts: [],
    });
  });

  it('accepts bare hostnames and *. wildcards', () => {
    const result = HostManifestSchema.safeParse({
      apiHosts: ['api.example.com', '*.example.com'],
      oauthHosts: ['auth.example.com'],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['scheme', 'https://api.example.com'],
    ['userinfo', 'user@api.example.com'],
    ['port', 'api.example.com:8080'],
    ['path', 'api.example.com/v1'],
    ['localhost', 'localhost'],
    ['metadata IP', '169.254.169.254'],
    ['loopback IP', '127.0.0.1'],
    ['IPv6 literal', '::1'],
    ['top-level wildcard', '*.com'],
    ['top-level wildcard (io)', '*.io'],
  ])('rejects %s entries', (_label, host) => {
    expect(HostManifestSchema.safeParse({ apiHosts: [host] }).success).toBe(false);
  });
});

// ============================================================================

describe('IconRefSchema', () => {
  it('parses each variant', () => {
    expect(IconRefSchema.safeParse({ kind: 'brand', assetId: 'github' }).success).toBe(true);
    expect(IconRefSchema.safeParse({ kind: 'phosphor', name: 'storefront' }).success).toBe(true);
    expect(
      IconRefSchema.safeParse({ kind: 'phosphor', name: 'storefront', color: '#0a84ff' }).success,
    ).toBe(true);
    expect(IconRefSchema.safeParse({ kind: 'generated', svg: '<svg></svg>' }).success).toBe(true);
  });

  it('rejects a non-slug brand assetId', () => {
    expect(IconRefSchema.safeParse({ kind: 'brand', assetId: 'Git Hub' }).success).toBe(false);
  });

  it('rejects generated svg beyond the size cap', () => {
    const svg = `<svg>${'x'.repeat(70_000)}</svg>`;
    expect(IconRefSchema.safeParse({ kind: 'generated', svg }).success).toBe(false);
  });

  it('rides the envelope as an optional field', () => {
    const entry = { ...validBundleEntry(), icon: { kind: 'brand' as const, assetId: 'github' } };
    const parsed = CatalogEntryEnvelopeSchema.parse(entry);
    expect(parsed.icon).toEqual({ kind: 'brand', assetId: 'github' });
  });
});
