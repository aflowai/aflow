import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { WORLD_BANK_CONNECTOR } from './worldbank.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('World Bank connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(WORLD_BANK_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(WORLD_BANK_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(WORLD_BANK_CONNECTOR.definition.baseUrl).toBe('https://api.worldbank.org');
    expect(WORLD_BANK_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(WORLD_BANK_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('is keyless: authKind none with no credential prompts', () => {
    expect(WORLD_BANK_CONNECTOR.authKind).toBe('none');
    expect(WORLD_BANK_CONNECTOR.credentialPrompts).toBeUndefined();
    expect(WORLD_BANK_CONNECTOR.apiKeyHeaderName).toBeUndefined();
  });

  it('is read-only: every endpoint is a GET with no body param', () => {
    for (const ep of WORLD_BANK_CONNECTOR.definition.endpoints) {
      expect(ep.method, `endpoint ${ep.endpointId}`).toBe('GET');
      expect(
        ep.params.some((p) => p.location === 'body'),
        `endpoint ${ep.endpointId} body param`,
      ).toBe(false);
    }
    expect(WORLD_BANK_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual(['GET']);
  });

  it('pins format=json on every endpoint and tells the agent the API defaults to XML', () => {
    for (const ep of WORLD_BANK_CONNECTOR.definition.endpoints) {
      const format = ep.params.find((p) => p.name === 'format');
      expect(format, `endpoint ${ep.endpointId} format param`).toBeDefined();
      expect(format?.required).toBe(true);
      expect((format?.schema as { enum?: string[] }).enum).toEqual(['json']);
      expect(format?.description).toMatch(/XML/);
    }
  });

  it('describes the country and indicator path params by code', () => {
    const getIndicator = WORLD_BANK_CONNECTOR.definition.endpoints.find(
      (e) => e.endpointId === 'getIndicator',
    );
    const country = getIndicator?.params.find((p) => p.name === 'country');
    const indicator = getIndicator?.params.find((p) => p.name === 'indicator');
    expect(country?.location).toBe('path');
    expect(indicator?.location).toBe('path');
    expect(country?.description).toMatch(/ISO/);
    expect(indicator?.description).toMatch(/NY\.GDP\.MKTP\.CD/);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('world-bank')).toEqual(WORLD_BANK_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('world-bank');
  });

  it('declares the indicator, catalog, and country endpoints', () => {
    const endpointIds = WORLD_BANK_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toEqual(['getIndicator', 'listIndicators', 'listCountries']);
  });
});
