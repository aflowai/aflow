import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { VERCEL_CONNECTOR } from './vercel.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Vercel connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(VERCEL_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(VERCEL_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(VERCEL_CONNECTOR.definition.baseUrl).toBe('https://api.vercel.com');
    expect(VERCEL_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(VERCEL_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of VERCEL_CONNECTOR.definition.endpoints) {
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

  it('sets an explicit writeRiskTier on every non-GET endpoint and none on GET endpoints', () => {
    for (const ep of VERCEL_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') {
        expect(ep.writeRiskTier, `GET ${ep.endpointId} must omit writeRiskTier`).toBeUndefined();
      } else {
        expect(ep.writeRiskTier, `non-GET ${ep.endpointId} must set writeRiskTier`).toBeDefined();
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('vercel')).toEqual(VERCEL_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('vercel');
  });

  it('declares the projects/deployments/env endpoints', () => {
    const endpointIds = VERCEL_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listProjects',
      'getProject',
      'listDeployments',
      'getDeployment',
      'createDeployment',
      'deleteDeployment',
      'listProjectEnv',
      'createProjectEnv',
      'deleteProjectEnv',
    ]);
  });
});
