import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema, getOAuthIssuer } from '@aflow/schemas';
import { GMAIL_CONNECTOR } from './gmail.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Gmail connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(GMAIL_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(GMAIL_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('is an OAuth connector bound to the registered google issuer', () => {
    expect(GMAIL_CONNECTOR.authKind).toBe('oauth2_authorization_code');
    expect(GMAIL_CONNECTOR.oauthIssuerKey).toBe('google');
    expect(getOAuthIssuer('google')).toBeDefined();
  });

  it('declares the Gmail endpoint scopes the token needs', () => {
    // Gmail scopes are restricted and not part of the google issuer defaults
    // (openid/email/profile), so the listing MUST declare its own or the
    // granted token could not reach any Gmail endpoint.
    expect(GMAIL_CONNECTOR.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
  });

  it('pastes no credentials — OAuth consent, not a token field', () => {
    expect(GMAIL_CONNECTOR.credentialPrompts).toBeUndefined();
    expect(GMAIL_CONNECTOR.apiKeyHeaderName).toBeUndefined();
    expect(GMAIL_CONNECTOR.apiKeyQueryParamName).toBeUndefined();
  });

  it('uses the fixed Gmail API v1 base URL', () => {
    expect(GMAIL_CONNECTOR.definition.baseUrl).toBe('https://gmail.googleapis.com/gmail/v1');
    expect(GMAIL_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(GMAIL_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('confines egress to GET and POST', () => {
    expect(GMAIL_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
      'POST',
    ]);
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of GMAIL_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
          expect(
            param.schema?.['additionalProperties'],
            `endpoint ${ep.endpointId} body must be closed`,
          ).toBe(false);
        }
      }
    }
  });

  it('tiers the external send as medium and the draft as low', () => {
    const byId = (id: string) =>
      GMAIL_CONNECTOR.definition.endpoints.find((e) => e.endpointId === id);
    expect(byId('sendMessage')?.method).toBe('POST');
    expect(byId('sendMessage')?.writeRiskTier).toBe('medium');
    expect(byId('createDraft')?.writeRiskTier).toBe('low');
    expect(byId('modifyMessage')?.writeRiskTier).toBe('low');
    expect(byId('trashMessage')?.writeRiskTier).toBe('medium');
  });

  it('carries an explicit write tier on every non-GET endpoint and none on GETs', () => {
    for (const ep of GMAIL_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') {
        expect(ep.writeRiskTier, `GET ${ep.endpointId} must omit writeRiskTier`).toBeUndefined();
      } else {
        expect(ep.writeRiskTier, `${ep.method} ${ep.endpointId} needs a tier`).toBeDefined();
      }
    }
  });

  it('declares the read-and-write endpoint set', () => {
    const endpointIds = GMAIL_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listMessages',
      'getMessage',
      'sendMessage',
      'createDraft',
      'listLabels',
      'modifyMessage',
      'trashMessage',
    ]);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('gmail')).toEqual(GMAIL_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('gmail');
  });
});
