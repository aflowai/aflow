import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { GITHUB_CONNECTOR } from './github.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('GitHub connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(GITHUB_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(GITHUB_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(GITHUB_CONNECTOR.definition.baseUrl).toBe('https://api.github.com');
    expect(GITHUB_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(GITHUB_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of GITHUB_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('github')).toEqual(GITHUB_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('github');
  });

  it('declares the PR-lifecycle endpoints', () => {
    const endpointIds = GITHUB_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('createPullRequest');
    expect(endpointIds).toContain('listPullRequestFiles');
    expect(endpointIds).toContain('listCheckRuns');
    expect(endpointIds).toContain('mergePullRequest');
    expect(endpointIds).toContain('closePullRequest');
  });
});
