import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema, getOAuthIssuer } from '@aflow/schemas';
import { SLACK_CONNECTOR } from './slack.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Slack connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(SLACK_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(SLACK_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('is an OAuth connector bound to the registered slack issuer', () => {
    expect(SLACK_CONNECTOR.authKind).toBe('oauth2_authorization_code');
    expect(SLACK_CONNECTOR.oauthIssuerKey).toBe('slack');
    expect(getOAuthIssuer('slack')).toBeDefined();
  });

  it('declares the endpoint scopes the issuer defaults do not carry', () => {
    // The slack issuer ships with empty defaultScopes, so the listing MUST
    // declare its own or the granted token could not reach any endpoint.
    expect(getOAuthIssuer('slack')?.defaultScopes).toEqual([]);
    expect(SLACK_CONNECTOR.oauthScopes).toEqual([
      'channels:read',
      'groups:read',
      'channels:history',
      'groups:history',
      'users:read',
      'chat:write',
    ]);
  });

  it('pastes no credentials — OAuth consent, not a token field', () => {
    expect(SLACK_CONNECTOR.credentialPrompts).toBeUndefined();
    expect(SLACK_CONNECTOR.apiKeyHeaderName).toBeUndefined();
    expect(SLACK_CONNECTOR.apiKeyQueryParamName).toBeUndefined();
  });

  it('uses the fixed method-based Slack Web API base URL', () => {
    expect(SLACK_CONNECTOR.definition.baseUrl).toBe('https://slack.com/api');
    expect(SLACK_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(SLACK_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('confines egress to GET and POST', () => {
    expect(SLACK_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
      'POST',
    ]);
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of SLACK_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('posts messages as a JSON body', () => {
    const postMessage = SLACK_CONNECTOR.definition.endpoints.find(
      (e) => e.endpointId === 'postMessage',
    );
    expect(postMessage?.method).toBe('POST');
    expect(postMessage?.bodyEncoding).toBe('json');
  });

  it('declares the read-and-post endpoint set', () => {
    const endpointIds = SLACK_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listConversations',
      'getConversationInfo',
      'getConversationHistory',
      'listUsers',
      'getUserInfo',
      'postMessage',
    ]);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('slack')).toEqual(SLACK_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('slack');
  });
});
