import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { LINEAR_CONNECTOR } from './linear.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Linear connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(LINEAR_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(LINEAR_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(LINEAR_CONNECTOR.definition.baseUrl).toBe('https://api.linear.app');
    expect(LINEAR_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(LINEAR_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('pins the raw API key to the Authorization header', () => {
    expect(LINEAR_CONNECTOR.authKind).toBe('api_key');
    expect(LINEAR_CONNECTOR.apiKeyHeaderName).toBe('Authorization');
  });

  it('models every operation as a POST to /graphql with a pinned query const', () => {
    for (const ep of LINEAR_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId} method`).toBe('POST');
      expect(ep.pathTemplate, `endpoint ${ep.endpointId} path`).toBe('/graphql');
      const bodyParam = ep.params.find((p) => p.location === 'body');
      expect(bodyParam?.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
      const body = bodyParam?.schema as {
        required?: string[];
        additionalProperties?: boolean;
        properties?: { query?: { const?: unknown } };
      };
      expect(body.required, `endpoint ${ep.endpointId} requires query`).toContain('query');
      expect(body.additionalProperties, `endpoint ${ep.endpointId} closed body`).toBe(false);
      expect(
        typeof body.properties?.query?.const,
        `endpoint ${ep.endpointId} pinned document`,
      ).toBe('string');
    }
  });

  it('pins distinct GraphQL documents per operation', () => {
    const documents = LINEAR_CONNECTOR.definition.endpoints.map(
      (ep) =>
        (
          ep.params.find((p) => p.location === 'body')?.schema as {
            properties?: { query?: { const?: string } };
          }
        ).properties?.query?.const,
    );
    expect(new Set(documents).size).toBe(LINEAR_CONNECTOR.definition.endpoints.length);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('linear')).toEqual(LINEAR_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('linear');
  });

  it('declares the issue-lifecycle and id-source endpoints', () => {
    const endpointIds = LINEAR_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('listIssues');
    expect(endpointIds).toContain('getIssue');
    expect(endpointIds).toContain('createIssue');
    expect(endpointIds).toContain('updateIssue');
    expect(endpointIds).toContain('addComment');
    expect(endpointIds).toContain('listTeams');
    expect(endpointIds).toContain('listProjects');
    expect(endpointIds).toContain('listUsers');
  });
});
