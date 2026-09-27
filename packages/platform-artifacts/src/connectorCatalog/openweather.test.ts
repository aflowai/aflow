import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { OPENWEATHER_CONNECTOR } from './openweather.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('OpenWeather connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(OPENWEATHER_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(OPENWEATHER_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(OPENWEATHER_CONNECTOR.definition.baseUrl).toBe('https://api.openweathermap.org');
    expect(OPENWEATHER_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(OPENWEATHER_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('sends the key as the appid query parameter', () => {
    expect(OPENWEATHER_CONNECTOR.authKind).toBe('api_key');
    expect(OPENWEATHER_CONNECTOR.apiKeyQueryParamName).toBe('appid');
    expect(OPENWEATHER_CONNECTOR.apiKeyHeaderName).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of OPENWEATHER_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(OPENWEATHER_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('openweather')).toEqual(OPENWEATHER_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('openweather');
  });

  it('declares the weather + geocoding endpoints', () => {
    const endpointIds = OPENWEATHER_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['getCurrentWeather', 'getForecast', 'geocode']);
  });
});
