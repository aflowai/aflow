import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { AIRTABLE_CONNECTOR } from './airtable.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Airtable connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(AIRTABLE_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(AIRTABLE_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(AIRTABLE_CONNECTOR.definition.baseUrl).toBe('https://api.airtable.com');
    expect(AIRTABLE_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(AIRTABLE_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('addresses records through {baseId}/{tableIdOrName} path templates', () => {
    const recordEndpoints = AIRTABLE_CONNECTOR.definition.endpoints.filter((e) =>
      e.tags.includes('records'),
    );
    expect(recordEndpoints.length).toBeGreaterThan(0);
    for (const ep of recordEndpoints) {
      expect(ep.pathTemplate, `endpoint ${ep.endpointId} path`).toMatch(
        /^\/v0\/\{baseId\}\/\{tableIdOrName\}/,
      );
    }
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of AIRTABLE_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('airtable')).toEqual(AIRTABLE_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('airtable');
  });

  it('declares the discover-read-write endpoints', () => {
    const endpointIds = AIRTABLE_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('listBases');
    expect(endpointIds).toContain('getBaseSchema');
    expect(endpointIds).toContain('listRecords');
    expect(endpointIds).toContain('getRecord');
    expect(endpointIds).toContain('createRecords');
    expect(endpointIds).toContain('updateRecords');
    expect(endpointIds).toContain('deleteRecord');
  });
});
