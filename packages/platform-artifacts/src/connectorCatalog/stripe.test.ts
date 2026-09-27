import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, ConnectorCatalogEntrySchema } from '@aflow/schemas';
import { STRIPE_CONNECTOR } from './stripe.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('Stripe connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(STRIPE_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(STRIPE_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(STRIPE_CONNECTOR.definition.baseUrl).toBe('https://api.stripe.com');
    expect(STRIPE_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(STRIPE_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('authenticates with a bearer secret key', () => {
    expect(STRIPE_CONNECTOR.authKind).toBe('bearer');
    expect(STRIPE_CONNECTOR.apiKeyHeaderName).toBeUndefined();
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of STRIPE_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('form-encodes every write endpoint', () => {
    for (const ep of STRIPE_CONNECTOR.definition.endpoints) {
      const hasBody = ep.params.some((p) => p.location === 'body');
      if (hasBody) {
        expect(ep.method, `endpoint ${ep.endpointId} method`).toBe('POST');
        expect(ep.bodyEncoding, `endpoint ${ep.endpointId} bodyEncoding`).toBe('form-urlencoded');
      }
    }
  });

  it('is read-heavy: only createCustomer and createPaymentLink write', () => {
    const writeIds = STRIPE_CONNECTOR.definition.endpoints
      .filter((ep) => ep.params.some((p) => p.location === 'body'))
      .map((ep) => ep.endpointId);
    expect(writeIds.sort()).toEqual(['createCustomer', 'createPaymentLink']);
    expect(STRIPE_CONNECTOR.definition.suggestedEgressPolicy?.allowedMethods).toEqual([
      'GET',
      'POST',
    ]);
  });

  it('declares the read endpoints and no dangerous writes', () => {
    const endpointIds = STRIPE_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('listCustomers');
    expect(endpointIds).toContain('getCustomer');
    expect(endpointIds).toContain('listCharges');
    expect(endpointIds).toContain('listPaymentIntents');
    expect(endpointIds).toContain('listInvoices');
    expect(endpointIds).toContain('listSubscriptions');
    expect(endpointIds).toContain('getBalance');
    expect(endpointIds).toContain('listProducts');
    expect(endpointIds).toContain('listPrices');
    expect(endpointIds).not.toContain('createCharge');
    expect(endpointIds).not.toContain('createRefund');
    expect(endpointIds).not.toContain('createPayout');
    expect(endpointIds.some((id) => id.startsWith('delete'))).toBe(false);
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('stripe')).toEqual(STRIPE_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('stripe');
  });
});
