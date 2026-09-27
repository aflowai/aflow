import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema, getOAuthIssuer } from '@aflow/schemas';
import { GOOGLE_SHEETS_CONNECTOR } from './googlesheets.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Google Sheets connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(GOOGLE_SHEETS_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(GOOGLE_SHEETS_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('is an OAuth connector bound to the registered google issuer', () => {
    expect(GOOGLE_SHEETS_CONNECTOR.authKind).toBe('oauth2_authorization_code');
    expect(GOOGLE_SHEETS_CONNECTOR.oauthIssuerKey).toBe('google');
    expect(getOAuthIssuer('google')).toBeDefined();
  });

  it('declares the Sheets scope the issuer defaults do not carry', () => {
    // The google issuer ships with only identity scopes (openid/email/profile),
    // so the listing MUST declare the spreadsheets scope or the granted token
    // could not reach any endpoint.
    expect(getOAuthIssuer('google')?.defaultScopes).not.toContain(
      'https://www.googleapis.com/auth/spreadsheets',
    );
    expect(GOOGLE_SHEETS_CONNECTOR.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
  });

  it('pastes no credentials — OAuth consent, not a token field', () => {
    expect(GOOGLE_SHEETS_CONNECTOR.credentialPrompts).toBeUndefined();
    expect(GOOGLE_SHEETS_CONNECTOR.apiKeyHeaderName).toBeUndefined();
    expect(GOOGLE_SHEETS_CONNECTOR.apiKeyQueryParamName).toBeUndefined();
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(GOOGLE_SHEETS_CONNECTOR.definition.baseUrl).toBe('https://sheets.googleapis.com/v4');
    expect(GOOGLE_SHEETS_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(GOOGLE_SHEETS_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('confines egress to GET, POST, and PUT', () => {
    expect(GOOGLE_SHEETS_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
      'POST',
      'PUT',
    ]);
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of GOOGLE_SHEETS_CONNECTOR.definition.endpoints) {
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

  it('tiers every write endpoint and leaves reads untiered', () => {
    const byId = new Map(
      GOOGLE_SHEETS_CONNECTOR.definition.endpoints.map((e) => [e.endpointId, e]),
    );
    // Reads: GET, no explicit tier.
    for (const id of ['getSpreadsheet', 'getValues']) {
      const ep = byId.get(id);
      expect(ep?.method).toBe('GET');
      expect(ep?.writeRiskTier).toBeUndefined();
    }
    // Writes: explicit 'low' tier on every non-GET endpoint.
    for (const id of [
      'updateValues',
      'appendValues',
      'clearValues',
      'batchUpdate',
      'createSpreadsheet',
    ]) {
      const ep = byId.get(id);
      expect(ep?.method, `${id} method`).not.toBe('GET');
      expect(ep?.writeRiskTier, `${id} tier`).toBe('low');
    }
  });

  it('declares the read-and-write endpoint set', () => {
    const endpointIds = GOOGLE_SHEETS_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'getSpreadsheet',
      'getValues',
      'updateValues',
      'appendValues',
      'clearValues',
      'batchUpdate',
      'createSpreadsheet',
    ]);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('google-sheets')).toEqual(GOOGLE_SHEETS_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('google-sheets');
  });
});
