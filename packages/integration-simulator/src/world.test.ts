import { describe, it, expect } from 'vitest';
import { foldWorld, queryWorld, type BaselineEntity, type JournalDelta } from './world.js';
import type { WorldMutation } from './types.js';

const baseline: BaselineEntity[] = [
  {
    collection: 'orders',
    entityId: 'ord_1',
    body: { orderId: 'ord_1', customerId: 'cus_1', status: 'open', total: 400 },
  },
  {
    collection: 'orders',
    entityId: 'ord_2',
    body: { orderId: 'ord_2', customerId: 'cus_2', status: 'open', total: 120 },
  },
];

function delta(worldVersionAfter: number, ...mutations: WorldMutation[]): JournalDelta {
  return { worldVersionAfter, mutations };
}

function bodies(world: ReturnType<typeof foldWorld>, collection: string) {
  return [...(world.get(collection) ?? new Map()).values()];
}

describe('foldWorld', () => {
  it('reads the baseline when the journal is empty', () => {
    const world = foldWorld(baseline, [], 0);

    expect(bodies(world, 'orders')).toHaveLength(2);
    expect(world.get('orders')?.get('ord_1')).toMatchObject({ status: 'open', total: 400 });
  });

  it('makes a created entity visible', () => {
    const world = foldWorld(
      baseline,
      [
        delta(1, {
          collection: 'refunds',
          op: 'create',
          entityId: 'ref_1',
          body: { refundId: 'ref_1', orderId: 'ord_1', amount: 400, status: 'processed' },
        }),
      ],
      1,
    );

    expect(world.get('refunds')?.get('ref_1')).toEqual({
      refundId: 'ref_1',
      orderId: 'ord_1',
      amount: 400,
      status: 'processed',
    });
  });

  it('overrides a baseline field with an update', () => {
    const world = foldWorld(
      baseline,
      [
        delta(1, {
          collection: 'orders',
          op: 'update',
          entityId: 'ord_1',
          body: { status: 'refunded' },
        }),
      ],
      1,
    );

    expect(world.get('orders')?.get('ord_1')).toEqual({
      orderId: 'ord_1',
      customerId: 'cus_1',
      status: 'refunded',
      total: 400,
    });
  });

  it('removes a deleted entity', () => {
    const world = foldWorld(
      baseline,
      [delta(1, { collection: 'orders', op: 'delete', entityId: 'ord_2' })],
      1,
    );

    expect(world.get('orders')?.has('ord_2')).toBe(false);
    expect(bodies(world, 'orders')).toHaveLength(1);
  });

  it('ignores deltas past the version it folds to', () => {
    const records = [
      delta(1, { collection: 'orders', op: 'update', entityId: 'ord_1', body: { status: 'held' } }),
      delta(2, {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: { status: 'refunded' },
      }),
      delta(3, { collection: 'orders', op: 'delete', entityId: 'ord_1' }),
    ];

    expect(foldWorld(baseline, records, 1).get('orders')?.get('ord_1')).toMatchObject({
      status: 'held',
    });
    expect(foldWorld(baseline, records, 2).get('orders')?.get('ord_1')).toMatchObject({
      status: 'refunded',
    });
    expect(foldWorld(baseline, records, 3).get('orders')?.has('ord_1')).toBe(false);
  });

  it('applies deltas in version order regardless of the order they arrive in', () => {
    const records = [
      delta(2, {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: { status: 'refunded' },
      }),
      delta(1, { collection: 'orders', op: 'update', entityId: 'ord_1', body: { status: 'held' } }),
    ];

    expect(foldWorld(baseline, records, 2).get('orders')?.get('ord_1')).toMatchObject({
      status: 'refunded',
    });
  });

  it('folds one journal to one world however the records were read back', () => {
    const records = [
      delta(1, { collection: 'orders', op: 'update', entityId: 'ord_1', body: { status: 'held' } }),
      delta(2, {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: { status: 'refunded' },
      }),
      delta(3, {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: { status: 'closed' },
      }),
    ];

    const forwards = foldWorld(baseline, records, 3).get('orders')?.get('ord_1');
    const backwards = foldWorld(baseline, [...records].reverse(), 3)
      .get('orders')
      ?.get('ord_1');
    const shuffled = foldWorld(baseline, [records[1]!, records[2]!, records[0]!], 3)
      .get('orders')
      ?.get('ord_1');

    expect(forwards).toMatchObject({ status: 'closed' });
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it('cannot order two records that share a version, which is why the write refuses one', () => {
    const collide = (worldVersionAfter: number, status: string): JournalDelta =>
      delta(worldVersionAfter, {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: { status },
      });
    const records = [collide(1, 'held'), collide(1, 'refunded')];

    // Nothing in the fold separates them, so the world a run replays is
    // whichever order the rows came back in. The unique index on
    // `(space, run, simulation, world_version_after)` is what keeps this
    // journal from existing.
    expect(foldWorld(baseline, records, 1).get('orders')?.get('ord_1')).toMatchObject({
      status: 'refunded',
    });
    expect(
      foldWorld(baseline, [...records].reverse(), 1)
        .get('orders')
        ?.get('ord_1'),
    ).toMatchObject({ status: 'held' });
  });
});

describe('queryWorld', () => {
  it('matches an entity a delta created, not only a seeded one', () => {
    const world = foldWorld(
      baseline,
      [
        delta(1, {
          collection: 'orders',
          op: 'create',
          entityId: 'ord_3',
          body: { orderId: 'ord_3', customerId: 'cus_1', status: 'open', total: 90 },
        }),
      ],
      1,
    );

    const found = queryWorld(world, {
      collection: 'orders',
      match: [{ path: '/customerId', value: 'cus_1' }],
    });

    expect(found.map((entity) => entity.id)).toEqual(['ord_1', 'ord_3']);
  });

  it('matches an entity a delta made match, and honours limit after the fold', () => {
    const world = foldWorld(
      baseline,
      [
        delta(1, {
          collection: 'orders',
          op: 'update',
          entityId: 'ord_2',
          body: { status: 'refunded' },
        }),
        delta(2, {
          collection: 'orders',
          op: 'update',
          entityId: 'ord_1',
          body: { status: 'refunded' },
        }),
      ],
      2,
    );

    const all = queryWorld(world, {
      collection: 'orders',
      match: [{ path: '/status', value: 'refunded' }],
    });
    const capped = queryWorld(world, {
      collection: 'orders',
      match: [{ path: '/status', value: 'refunded' }],
      limit: 1,
    });

    expect(all.map((entity) => entity.id)).toEqual(['ord_1', 'ord_2']);
    expect(capped.map((entity) => entity.id)).toEqual(['ord_1']);
  });

  it('resolves identity against the collection identityField, including a body that omits it', () => {
    const world = foldWorld(
      [
        { collection: 'customers', entityId: 'cus_1', body: { name: 'Alice' } },
        { collection: 'customers', entityId: 'cus_2', body: { customerId: 'cus_2', name: 'Bob' } },
      ],
      [],
      0,
    );

    expect(
      queryWorld(
        world,
        { collection: 'customers', match: [{ path: '/customerId', value: 'cus_1' }] },
        'customerId',
      ),
    ).toEqual([{ id: 'cus_1', body: { name: 'Alice' } }]);
    expect(
      queryWorld(
        world,
        { collection: 'customers', match: [{ path: '/customerId', value: 'cus_2' }] },
        'customerId',
      ),
    ).toHaveLength(1);
  });

  it('matches a path parameter string against the number the world holds', () => {
    const world = foldWorld(
      [{ collection: 'orders', entityId: '77', body: { orderId: 77 } }],
      [],
      0,
    );

    expect(
      queryWorld(world, { collection: 'orders', match: [{ path: '/orderId', value: '77' }] }),
    ).toHaveLength(1);
  });

  it('returns nothing for a collection the world has never seen', () => {
    expect(queryWorld(foldWorld(baseline, [], 0), { collection: 'refunds', match: [] })).toEqual(
      [],
    );
  });
});
