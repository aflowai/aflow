import { describe, expect, it } from 'vitest';
import { SimulationSchema } from './simulation.js';

function artifact(collections: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    simulationId: 'billing-sim',
    name: 'Billing',
    targets: { sourceKind: 'api', integrationId: 'billing' },
    collections,
  };
}

const customers = {
  collection: 'customers',
  identityField: 'customerId',
  ownership: 'shared',
  schema: { type: 'object', required: ['customerId'] },
};

describe('SimulationSchema — a collection name declares one collection', () => {
  it('accepts distinct collection names', () => {
    const parsed = SimulationSchema.safeParse(
      artifact([
        customers,
        { ...customers, collection: 'orders', identityField: 'orderId', ownership: 'shared' },
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects two declarations of one collection name', () => {
    const parsed = SimulationSchema.safeParse(
      artifact([
        customers,
        // Same name, a different identity field and a different schema: the
        // readers key declarations by name, so one of these two silently wins.
        {
          collection: 'customers',
          identityField: 'accountId',
          ownership: 'shared',
          schema: { type: 'object', required: ['accountId'] },
        },
      ]),
    );

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find(
      (candidate) => candidate.path.join('.') === 'collections',
    );
    expect(issue?.message).toContain('collections[].collection must be unique');
  });
});
