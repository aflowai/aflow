import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { CLOUDFLARE_CONNECTOR } from './cloudflare.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Cloudflare connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(CLOUDFLARE_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(CLOUDFLARE_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(CLOUDFLARE_CONNECTOR.definition.baseUrl).toBe('https://api.cloudflare.com/client/v4');
    expect(CLOUDFLARE_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(CLOUDFLARE_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of CLOUDFLARE_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          const schema = param.schema as { additionalProperties?: unknown } | undefined;
          expect(schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
          expect(
            schema?.additionalProperties,
            `endpoint ${ep.endpointId} additionalProperties`,
          ).toBe(false);
        }
      }
    }
  });

  it('puts an explicit write-risk tier on every non-GET endpoint and none on GETs', () => {
    for (const ep of CLOUDFLARE_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') {
        expect(ep.writeRiskTier, `GET ${ep.endpointId} must omit writeRiskTier`).toBeUndefined();
      } else {
        expect(ep.writeRiskTier, `${ep.method} ${ep.endpointId} needs a writeRiskTier`).toBe(
          'medium',
        );
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('cloudflare')).toEqual(CLOUDFLARE_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('cloudflare');
  });

  it('declares the expected zone / DNS / cache endpoints', () => {
    const endpointIds = CLOUDFLARE_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listZones',
      'getZone',
      'listDnsRecords',
      'getDnsRecord',
      'createDnsRecord',
      'updateDnsRecord',
      'deleteDnsRecord',
      'purgeCache',
    ]);
  });
});
