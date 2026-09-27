import { describe, it, expect } from 'vitest';
import {
  CatalogEntryEnvelopeSchema,
  CatalogEntrySchema,
  type CatalogEntry,
} from './catalogEntry.js';
import {
  CANONICAL_CONTENT_EXCLUDED_FIELDS,
  canonicalCatalogEntryContent,
} from './canonicalContent.js';

function connectorEntry() {
  const parsed = CatalogEntrySchema.parse({
    catalogId: 'exampleapi',
    kind: 'connector',
    version: 3,
    name: 'Example API',
    tagline: 'Talks to api.example.com.',
    description: 'A vetted Example API connector.',
    tags: ['dev'],
    category: 'dev',
    honestyLabel: 'curated',
    sourceKind: 'api',
    icon: { kind: 'brand', assetId: 'example' },
    hostManifest: { apiHosts: ['api.example.com'] },
    payload: {
      catalogId: 'exampleapi',
      version: 3,
      name: 'Example API',
      tagline: 'Talks to api.example.com.',
      description: 'A vetted Example API connector.',
      honestyLabel: 'curated',
      authKind: 'bearer',
      definition: {
        apiId: 'exampleapi',
        name: 'Example API',
        baseUrl: 'https://api.example.com',
        endpoints: [
          {
            endpointId: 'things.list',
            name: 'List things',
            method: 'GET',
            pathTemplate: '/v1/things',
          },
        ],
      },
    },
  });
  if (parsed.kind !== 'connector') throw new Error('fixture must parse as a connector');
  return parsed;
}

describe('canonicalCatalogEntryContent', () => {
  it('is independent of key insertion order at every depth', () => {
    const a = {
      catalogId: 'x',
      kind: 'connector',
      hostManifest: { apiHosts: ['api.example.com'], mcpHosts: [] },
      payload: { catalogId: 'x', version: 1, definition: { apiId: 'x', name: 'X' } },
    } as unknown as CatalogEntry;
    const b = {
      payload: { definition: { name: 'X', apiId: 'x' }, version: 1, catalogId: 'x' },
      hostManifest: { mcpHosts: [], apiHosts: ['api.example.com'] },
      kind: 'connector',
      catalogId: 'x',
    } as unknown as CatalogEntry;
    expect(canonicalCatalogEntryContent(a)).toBe(canonicalCatalogEntryContent(b));
  });

  it('is unchanged by presentation-only fields and version', () => {
    const base = canonicalCatalogEntryContent(connectorEntry());
    const varied = CatalogEntrySchema.parse({
      ...connectorEntry(),
      version: 9,
      status: 'deprecated',
      tagline: 'Different tagline.',
      description: 'Different description.',
      tags: ['other', 'tags'],
      category: 'other',
      icon: { kind: 'phosphor', name: 'plug' },
      payload: { ...connectorEntry().payload, version: 9 },
    });
    expect(canonicalCatalogEntryContent(varied)).toBe(base);
  });

  it('changes when the host manifest changes', () => {
    const base = canonicalCatalogEntryContent(connectorEntry());
    const widened = CatalogEntrySchema.parse({
      ...connectorEntry(),
      hostManifest: { apiHosts: ['api.example.com', 'evil.example.net'] },
    });
    expect(canonicalCatalogEntryContent(widened)).not.toBe(base);
  });

  it('changes when the payload changes', () => {
    const entry = connectorEntry();
    const base = canonicalCatalogEntryContent(entry);
    const changed = CatalogEntrySchema.parse({
      ...entry,
      payload: {
        ...entry.payload,
        definition: { ...entry.payload.definition, name: 'Renamed' },
      },
    });
    expect(canonicalCatalogEntryContent(changed)).not.toBe(base);
  });

  it('changes when identity or trust fields change', () => {
    const entry = connectorEntry();
    const base = canonicalCatalogEntryContent(entry);
    const relabeled = {
      ...entry,
      honestyLabel: 'generated-validated',
    } as unknown as CatalogEntry;
    expect(canonicalCatalogEntryContent(relabeled)).not.toBe(base);
  });

  it('drops undefined-valued fields like JSON.stringify does', () => {
    const withUndefined = { ...connectorEntry(), vendor: undefined } as unknown as CatalogEntry;
    expect(canonicalCatalogEntryContent(withUndefined)).toBe(
      canonicalCatalogEntryContent(connectorEntry()),
    );
  });

  it('excludes exactly the presentation fields plus version', () => {
    expect([...CANONICAL_CONTENT_EXCLUDED_FIELDS].sort()).toEqual(
      ['category', 'description', 'icon', 'status', 'tagline', 'tags', 'version'].sort(),
    );
  });

  it('every excluded field is a real envelope field (a rename must update the exclusion list)', () => {
    const envelopeKeys = Object.keys(CatalogEntryEnvelopeSchema.shape);
    for (const field of CANONICAL_CONTENT_EXCLUDED_FIELDS) {
      expect(envelopeKeys).toContain(field);
    }
  });
});
