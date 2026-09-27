import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { SENTRY_CONNECTOR } from './sentry.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Sentry connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(SENTRY_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(SENTRY_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(SENTRY_CONNECTOR.definition.baseUrl).toBe('https://sentry.io/api/0');
    expect(SENTRY_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(SENTRY_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of SENTRY_CONNECTOR.definition.endpoints) {
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

  it('puts an explicit writeRiskTier on every non-GET endpoint and none on GETs', () => {
    for (const ep of SENTRY_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') {
        expect(ep.writeRiskTier, `GET endpoint ${ep.endpointId}`).toBeUndefined();
      } else {
        expect(ep.writeRiskTier, `non-GET endpoint ${ep.endpointId}`).toBeDefined();
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('sentry')).toEqual(SENTRY_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('sentry');
  });

  it('declares the expected endpoints', () => {
    const endpointIds = SENTRY_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listProjects',
      'listOrganizationIssues',
      'getIssue',
      'updateIssue',
      'deleteIssue',
      'listIssueEvents',
      'listReleases',
      'createRelease',
    ]);
  });
});
