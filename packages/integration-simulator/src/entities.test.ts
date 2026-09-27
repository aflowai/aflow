import { describe, expect, it } from 'vitest';
import type { SimulationCollection } from '@aflow/schemas';
import { validateSeedEntities } from './entities.js';

const customers: SimulationCollection = {
  collection: 'customers',
  identityField: 'customerId',
  schema: {
    type: 'object',
    required: ['customerId', 'balanceCents'],
    properties: {
      customerId: { type: 'string' },
      balanceCents: { type: 'integer' },
    },
  },
};

describe('validateSeedEntities', () => {
  it('accepts entities that carry their identity and satisfy the collection schema', () => {
    const result = validateSeedEntities({
      collections: [customers],
      entities: { customers: [{ customerId: 'cus_1', balanceCents: 400 }] },
    });

    expect(result.violations).toEqual([]);
    expect(result.entities).toEqual([
      {
        collection: 'customers',
        entityId: 'cus_1',
        body: { customerId: 'cus_1', balanceCents: 400 },
      },
    ]);
  });

  it('stores nothing when one entity fails, so a partial world never lands', () => {
    const result = validateSeedEntities({
      collections: [customers],
      entities: {
        customers: [
          { customerId: 'cus_1', balanceCents: 400 },
          { customerId: 'cus_2', balanceCents: 'four hundred' },
        ],
      },
    });

    expect(result.entities).toEqual([]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.index).toBe(1);
  });

  it('rejects a collection the simulation does not declare', () => {
    const result = validateSeedEntities({
      collections: [customers],
      entities: { refunds: [{ refundId: 'ref_1' }] },
    });

    expect(result.violations[0]?.collection).toBe('refunds');
    expect(result.violations[0]?.detail).toContain('not declared');
  });

  it('rejects an entity with no identity, which nothing could address', () => {
    const result = validateSeedEntities({
      collections: [customers],
      entities: { customers: [{ balanceCents: 400 }] },
    });

    expect(result.violations[0]?.detail).toContain('customerId');
  });

  it('rejects two entities sharing an identity rather than letting one overwrite the other', () => {
    const result = validateSeedEntities({
      collections: [customers],
      entities: {
        customers: [
          { customerId: 'cus_1', balanceCents: 1 },
          { customerId: 'cus_1', balanceCents: 2 },
        ],
      },
    });

    expect(result.violations[0]?.detail).toContain('share the identity');
  });
});
