import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema, getOAuthIssuer } from '@aflow/schemas';
import { GOOGLE_CALENDAR_CONNECTOR } from './googlecalendar.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Google Calendar connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(GOOGLE_CALENDAR_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(GOOGLE_CALENDAR_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('is an OAuth connector bound to the registered google issuer', () => {
    expect(GOOGLE_CALENDAR_CONNECTOR.authKind).toBe('oauth2_authorization_code');
    expect(GOOGLE_CALENDAR_CONNECTOR.oauthIssuerKey).toBe('google');
    expect(getOAuthIssuer('google')).toBeDefined();
  });

  it('declares the calendar scope the issuer defaults do not carry', () => {
    // The google issuer ships with only identity scopes (openid/email/profile),
    // so the listing MUST declare the calendar scope or the granted token could
    // not reach any endpoint.
    const calendarScope = 'https://www.googleapis.com/auth/calendar';
    expect(getOAuthIssuer('google')?.defaultScopes).not.toContain(calendarScope);
    expect(GOOGLE_CALENDAR_CONNECTOR.oauthScopes).toEqual([calendarScope]);
  });

  it('pastes no credentials — OAuth consent, not a token field', () => {
    expect(GOOGLE_CALENDAR_CONNECTOR.credentialPrompts).toBeUndefined();
    expect(GOOGLE_CALENDAR_CONNECTOR.apiKeyHeaderName).toBeUndefined();
    expect(GOOGLE_CALENDAR_CONNECTOR.apiKeyQueryParamName).toBeUndefined();
  });

  it('uses the fixed Google Calendar API v3 base URL', () => {
    expect(GOOGLE_CALENDAR_CONNECTOR.definition.baseUrl).toBe(
      'https://www.googleapis.com/calendar/v3',
    );
    expect(GOOGLE_CALENDAR_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(GOOGLE_CALENDAR_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('confines egress to GET, POST, PUT, and DELETE', () => {
    expect(GOOGLE_CALENDAR_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
    ]);
  });

  it('declares a closed body schema for every body-bearing endpoint', () => {
    for (const ep of GOOGLE_CALENDAR_CONNECTOR.definition.endpoints) {
      for (const param of ep.params ?? []) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
          expect(
            (param.schema as Record<string, unknown>)['additionalProperties'],
            `endpoint ${ep.endpointId} body schema is closed`,
          ).toBe(false);
        }
      }
    }
  });

  it('tiers every non-GET endpoint explicitly', () => {
    for (const ep of GOOGLE_CALENDAR_CONNECTOR.definition.endpoints) {
      if (ep.method === 'GET') {
        expect(ep.writeRiskTier, `${ep.endpointId} is a read`).toBeUndefined();
      } else {
        expect(ep.writeRiskTier, `${ep.endpointId} tier`).toBeDefined();
      }
    }
    const byId = new Map(
      GOOGLE_CALENDAR_CONNECTOR.definition.endpoints.map((e) => [e.endpointId, e.writeRiskTier]),
    );
    expect(byId.get('createEvent')).toBe('low');
    expect(byId.get('updateEvent')).toBe('low');
    expect(byId.get('deleteEvent')).toBe('medium');
  });

  it('declares the calendars-and-events endpoint set', () => {
    const endpointIds = GOOGLE_CALENDAR_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual([
      'listCalendars',
      'listEvents',
      'getEvent',
      'createEvent',
      'updateEvent',
      'deleteEvent',
    ]);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('google-calendar')).toEqual(GOOGLE_CALENDAR_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('google-calendar');
  });
});
