import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { JIRA_CONNECTOR } from './jira.js';

describe('JIRA connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(JIRA_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(JIRA_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a baseUrlTemplate with a declared domain variable and no concrete baseUrl', () => {
    expect(JIRA_CONNECTOR.definition.baseUrl).toBeUndefined();
    expect(JIRA_CONNECTOR.definition.baseUrlTemplate).toBe('https://{domain}.atlassian.net');
    expect(JIRA_CONNECTOR.definition.variables?.map((v) => v.name)).toContain('domain');
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of JIRA_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });
});
