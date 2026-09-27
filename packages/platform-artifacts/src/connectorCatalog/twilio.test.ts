import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { TWILIO_CONNECTOR } from './twilio.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Twilio connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(TWILIO_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(TWILIO_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('carries the accountSid in a baseUrlTemplate path variable, not a concrete baseUrl', () => {
    expect(TWILIO_CONNECTOR.definition.baseUrl).toBeUndefined();
    expect(TWILIO_CONNECTOR.definition.baseUrlTemplate).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/{accountSid}',
    );
    expect(TWILIO_CONNECTOR.definition.variables?.map((v) => v.name)).toContain('accountSid');
  });

  it('authenticates with basic auth (SID username + token password)', () => {
    expect(TWILIO_CONNECTOR.authKind).toBe('basic');
    const authFields = (TWILIO_CONNECTOR.credentialPrompts ?? []).map((p) => p.authField);
    expect(authFields).toContain('usernameCredentialKey');
    expect(authFields).toContain('passwordCredentialKey');
  });

  it('declares a body schema for every body-bearing endpoint and form-encodes writes', () => {
    for (const ep of TWILIO_CONNECTOR.definition.endpoints) {
      const bodyParam = ep.params.find((p) => p.location === 'body');
      if (bodyParam) {
        expect(bodyParam.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        expect(ep.method, `endpoint ${ep.endpointId} method`).toBe('POST');
        expect(ep.bodyEncoding, `endpoint ${ep.endpointId} bodyEncoding`).toBe('form-urlencoded');
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('twilio')).toEqual(TWILIO_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('twilio');
  });

  it('declares the messaging and voice endpoints', () => {
    const endpointIds = TWILIO_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['sendSms', 'listMessages', 'getMessage', 'makeCall', 'listCalls']);
  });
});
