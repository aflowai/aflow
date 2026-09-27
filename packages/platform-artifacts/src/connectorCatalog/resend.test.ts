import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { RESEND_CONNECTOR } from './resend.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Resend connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(RESEND_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(RESEND_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(RESEND_CONNECTOR.definition.baseUrl).toBe('https://api.resend.com');
    expect(RESEND_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(RESEND_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of RESEND_CONNECTOR.definition.endpoints) {
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

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('resend')).toEqual(RESEND_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('resend');
  });

  it('declares the send/read/manage endpoints', () => {
    const endpointIds = RESEND_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'sendEmail',
      'getEmail',
      'listDomains',
      'listAudiences',
      'createContact',
    ]);
  });
});
