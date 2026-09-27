import { describe, expect, it } from 'vitest';
import { WorldEffectSchema, type SimulationCollection, type WorldEffect } from '@aflow/schemas';
import { resolveEffect, SimulationWorldViolationError, type EffectOutcome } from './effect.js';
import { mintEntityId } from './identity.js';
import { entityMatchesQuery } from './world.js';
import type {
  SimulatedRequest,
  WorldEntity,
  WorldMutation,
  WorldReadQuery,
  WorldStore,
} from './types.js';

const SEED = 'seed-alpha';
const CLOCK_MS = 1_700_000_000_000;
const CLOCK_ISO = '2023-11-14T22:13:20.000Z';
const LOGICAL_EXECUTION_ID = 'call-1';
const WORLD_VERSION = 7;

const collections: SimulationCollection[] = [
  {
    collection: 'customers',
    identityField: 'customerId',
    schema: { type: 'object', properties: { customerId: { type: 'string' } } },
  },
  {
    collection: 'orders',
    identityField: 'orderId',
    schema: { type: 'object', properties: { orderId: { type: 'string' } } },
  },
  {
    collection: 'refunds',
    identityField: 'refundId',
    schema: { type: 'object', properties: { refundId: { type: 'string' } } },
  },
];

interface MemoryWorld {
  store: WorldStore;
  committed: WorldMutation[];
  queries: WorldReadQuery[];
}

const identityFields = new Map(collections.map((c) => [c.collection, c.identityField]));

function createMemoryWorld(seed: Record<string, WorldEntity[]> = {}): MemoryWorld {
  const world = new Map<string, WorldEntity[]>(
    Object.entries(seed).map(([collection, entities]) => [
      collection,
      entities.map((entity) => ({ id: entity.id, body: { ...entity.body } })),
    ]),
  );
  const committed: WorldMutation[] = [];
  const queries: WorldReadQuery[] = [];
  let version = WORLD_VERSION;

  return {
    committed,
    queries,
    store: {
      version: () => version,
      stampOwnership: (mutations: readonly WorldMutation[]) => [...mutations],
      query: (query: WorldReadQuery) => {
        queries.push(query);
        const rows = (world.get(query.collection) ?? []).filter((entity) =>
          entityMatchesQuery(entity, query, identityFields.get(query.collection)),
        );
        return Promise.resolve(query.limit === undefined ? rows : rows.slice(0, query.limit));
      },
      commit: (mutations: WorldMutation[]) => {
        committed.push(...mutations);
        version += 1;
        return Promise.resolve({ worldVersionAfter: version, applied: true });
      },
    },
  };
}

function request(overrides: Partial<SimulatedRequest> = {}): SimulatedRequest {
  return {
    method: 'GET',
    url: 'https://simulated.invalid/payments',
    endpointId: 'getCustomer',
    params: {},
    body: undefined,
    ...overrides,
  };
}

function resolve(params: {
  effect: WorldEffect;
  request: SimulatedRequest;
  store: WorldStore;
  seed?: string;
  collections?: SimulationCollection[];
}): Promise<EffectOutcome> {
  return resolveEffect({
    effect: params.effect,
    request: params.request,
    store: params.store,
    collections: params.collections ?? collections,
    seed: params.seed ?? SEED,
    logicalExecutionId: LOGICAL_EXECUTION_ID,
    clockMs: CLOCK_MS,
  });
}

function resolved(outcome: EffectOutcome) {
  if (outcome.kind !== 'resolved')
    throw new Error(`expected a resolved outcome, got ${outcome.kind}`);
  return outcome;
}

const getCustomer = WorldEffectSchema.parse({
  reads: [
    {
      collection: 'customers',
      cardinality: 'one',
      onMissing: { respond: 404 },
      select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
      as: 'customer',
    },
  ],
  project: [{ bodyPath: '/customer', from: { read: 'customer' }, fields: ['customerId', 'name'] }],
  status: 200,
});

describe('resolveEffect — a `one` read', () => {
  const world = () =>
    createMemoryWorld({
      customers: [
        { id: 'cus_1', body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' } },
        { id: 'cus_2', body: { customerId: 'cus_2', name: 'Bob', tier: 'bronze' } },
      ],
    });

  it('projects the entity it hit into the declared body path', async () => {
    const memory = world();

    const outcome = await resolve({
      effect: getCustomer,
      request: request({ params: { customerId: 'cus_1' } }),
      store: memory.store,
    });

    expect(resolved(outcome)).toEqual({
      kind: 'resolved',
      status: 200,
      body: { customer: { customerId: 'cus_1', name: 'Alice' } },
      mutations: [],
    });
  });

  it('reports the miss with the read`s own onMissing rather than answering', async () => {
    const memory = world();

    const outcome = await resolve({
      effect: getCustomer,
      request: request({ params: { customerId: 'cus_absent' } }),
      store: memory.store,
    });

    expect(outcome).toEqual({
      kind: 'missing',
      readIndex: 0,
      query: {
        collection: 'customers',
        match: [{ path: '/customerId', value: 'cus_absent' }],
        limit: 1,
      },
      onMissing: { respond: 404 },
    });
  });
});

describe('resolveEffect — cardinality', () => {
  // An empty listRefunds is a valid 200 carrying [], while an empty getCustomer
  // is not a valid customer. Only cardinality separates them.
  const listRefunds = WorldEffectSchema.parse({
    reads: [
      {
        collection: 'refunds',
        cardinality: 'many',
        onMissing: 'error',
        select: [{ entityPath: '/orderId', requestPath: '/params/orderId' }],
        as: 'refunds',
      },
    ],
    project: [{ bodyPath: '/refunds', from: { read: 'refunds' }, fields: [] }],
    status: 200,
  });

  it('resolves an empty `many` read as an empty list, never as missing', async () => {
    const memory = createMemoryWorld({ refunds: [] });

    const outcome = await resolve({
      effect: listRefunds,
      request: request({ endpointId: 'listRefunds', params: { orderId: 'ord_1' } }),
      store: memory.store,
    });

    expect(outcome.kind).toBe('resolved');
    expect(resolved(outcome).body).toEqual({ refunds: [] });
    expect(resolved(outcome).status).toBe(200);
  });

  it('returns every matching entity of a `many` read', async () => {
    const memory = createMemoryWorld({
      refunds: [
        { id: 'ref_1', body: { refundId: 'ref_1', orderId: 'ord_1', amount: 100 } },
        { id: 'ref_2', body: { refundId: 'ref_2', orderId: 'ord_1', amount: 300 } },
        { id: 'ref_3', body: { refundId: 'ref_3', orderId: 'ord_9', amount: 50 } },
      ],
    });

    const outcome = await resolve({
      effect: listRefunds,
      request: request({ endpointId: 'listRefunds', params: { orderId: 'ord_1' } }),
      store: memory.store,
    });

    expect(resolved(outcome).body).toEqual({
      refunds: [
        { refundId: 'ref_1', orderId: 'ord_1', amount: 100 },
        { refundId: 'ref_2', orderId: 'ord_1', amount: 300 },
      ],
    });
  });
});

describe('resolveEffect — a create write', () => {
  const createRefund = WorldEffectSchema.parse({
    reads: [
      {
        collection: 'refunds',
        cardinality: 'many',
        select: [{ entityPath: '/orderId', requestPath: '/body/orderId' }],
        as: 'existing',
      },
    ],
    writes: [
      {
        collection: 'refunds',
        op: 'create',
        identity: 'refundId',
        from: '/body',
        assign: { status: 'processed', createdAt: 'now' },
        as: 'refund',
      },
    ],
    project: [{ bodyPath: '/refund', from: { read: 'existing' }, fields: [] }],
    status: 201,
  });

  const call = () =>
    request({
      method: 'POST',
      endpointId: 'createRefund',
      body: { orderId: 'ord_1', amount: 400 },
    });

  it('mints the id from (seed, logicalExecutionId, collection, sequence)', async () => {
    const memory = createMemoryWorld({ refunds: [] });

    const outcome = await resolve({ effect: createRefund, request: call(), store: memory.store });

    expect(resolved(outcome).mutations).toEqual([
      {
        collection: 'refunds',
        op: 'create',
        entityId: mintEntityId({
          seed: SEED,
          logicalExecutionId: LOGICAL_EXECUTION_ID,
          collection: 'refunds',
          sequence: 0,
        }),
        body: {
          orderId: 'ord_1',
          amount: 400,
          status: 'processed',
          createdAt: CLOCK_ISO,
          refundId: expect.stringMatching(/^refunds_[0-9a-f]{20}$/) as unknown as string,
        },
      },
    ]);
  });

  it('mints a different id under a different seed', async () => {
    const first = await resolve({
      effect: createRefund,
      request: call(),
      store: createMemoryWorld({ refunds: [] }).store,
    });
    const second = await resolve({
      effect: createRefund,
      request: call(),
      store: createMemoryWorld({ refunds: [] }).store,
      seed: 'seed-beta',
    });

    expect(resolved(first).mutations[0]?.entityId).not.toBe(
      resolved(second).mutations[0]?.entityId,
    );
  });

  it('renders the created entity in the SAME response', async () => {
    const memory = createMemoryWorld({ refunds: [] });

    const outcome = await resolve({ effect: createRefund, request: call(), store: memory.store });
    const created = resolved(outcome).mutations[0];

    expect(resolved(outcome).status).toBe(201);
    expect(resolved(outcome).body).toEqual({
      refund: [{ ...created?.body }],
    });
  });

  it('renders the entity the named write created, with no read involved', async () => {
    const bareCreate = WorldEffectSchema.parse({
      writes: [
        { collection: 'refunds', op: 'create', identity: 'refundId', from: '/body', as: 'refund' },
      ],
      project: [{ bodyPath: '/', from: { write: 'refund' }, fields: [] }],
      status: 201,
    });
    const memory = createMemoryWorld();

    const outcome = await resolve({ effect: bareCreate, request: call(), store: memory.store });

    expect(resolved(outcome).body).toEqual({
      orderId: 'ord_1',
      amount: 400,
      refundId: resolved(outcome).mutations[0]?.entityId,
    });
  });

  it('leaves the mutation uncommitted — the caller owns the transaction', async () => {
    const memory = createMemoryWorld({ refunds: [] });

    await resolve({ effect: createRefund, request: call(), store: memory.store });

    expect(memory.committed).toEqual([]);
  });

  it('refuses at authoring time a root projection standing beside another', () => {
    // Accepted, the root one would answer and the sibling would render
    // nowhere — a field the author declared, silently absent from every call.
    expect(() =>
      WorldEffectSchema.parse({
        writes: [
          {
            collection: 'refunds',
            op: 'create',
            identity: 'refundId',
            from: '/body',
            as: 'refund',
          },
        ],
        project: [
          { bodyPath: '/', from: { write: 'refund' } },
          { bodyPath: '/refund', from: { write: 'refund' } },
        ],
        status: 201,
      }),
    ).toThrow(/must be the only one/);
  });
});

describe('resolveEffect — an update write', () => {
  const refundOrder = WorldEffectSchema.parse({
    reads: [
      {
        collection: 'orders',
        cardinality: 'one',
        onMissing: { respond: 404 },
        select: [{ entityPath: '/orderId', requestPath: '/params/orderId' }],
        as: 'order',
      },
    ],
    writes: [
      {
        collection: 'orders',
        op: 'update',
        identity: 'orderId',
        targetRead: 'order',
        assign: { status: 'refunded', updatedAt: 'now' },
      },
    ],
    project: [{ bodyPath: '/', from: { read: 'order' }, fields: [] }],
    status: 200,
  });

  const world = () =>
    createMemoryWorld({
      orders: [
        {
          id: 'ord_1',
          body: { orderId: 'ord_1', customerId: 'cus_1', status: 'open', total: 400 },
        },
        {
          id: 'ord_2',
          body: { orderId: 'ord_2', customerId: 'cus_2', status: 'open', total: 120 },
        },
      ],
    });

  it('applies only to the entities its targetRead selected', async () => {
    const memory = world();

    const outcome = await resolve({
      effect: refundOrder,
      request: request({ method: 'POST', endpointId: 'refundOrder', params: { orderId: 'ord_1' } }),
      store: memory.store,
    });

    expect(resolved(outcome).mutations).toEqual([
      {
        collection: 'orders',
        op: 'update',
        entityId: 'ord_1',
        body: {
          orderId: 'ord_1',
          customerId: 'cus_1',
          status: 'refunded',
          total: 400,
          updatedAt: CLOCK_ISO,
        },
      },
    ]);
  });

  it('renders the post-mutation entity, not the one it read', async () => {
    const memory = world();

    const outcome = await resolve({
      effect: refundOrder,
      request: request({ method: 'POST', endpointId: 'refundOrder', params: { orderId: 'ord_1' } }),
      store: memory.store,
    });

    expect(resolved(outcome).body).toMatchObject({ orderId: 'ord_1', status: 'refunded' });
  });

  it('drops a deleted entity from the response it renders', async () => {
    const cancelOrder = WorldEffectSchema.parse({
      reads: [
        {
          collection: 'orders',
          cardinality: 'many',
          select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
          as: 'orders',
        },
      ],
      writes: [{ collection: 'orders', op: 'delete', identity: 'orderId', targetRead: 'orders' }],
      project: [{ bodyPath: '/orders', from: { read: 'orders' }, fields: [] }],
      status: 200,
    });
    const memory = world();

    const outcome = await resolve({
      effect: cancelOrder,
      request: request({
        method: 'DELETE',
        endpointId: 'cancelOrders',
        params: { customerId: 'cus_1' },
      }),
      store: memory.store,
    });

    expect(resolved(outcome).mutations).toEqual([
      { collection: 'orders', op: 'delete', entityId: 'ord_1' },
    ]);
    expect(resolved(outcome).body).toEqual({ orders: [] });
  });
});

describe('resolveEffect — the virtual clock', () => {
  const stampOnly = WorldEffectSchema.parse({
    writes: [
      {
        collection: 'refunds',
        op: 'create',
        identity: 'refundId',
        assign: { createdAt: 'now' },
      },
    ],
    status: 201,
  });

  it('resolves `now` against clockMs, never wall-clock', async () => {
    const memory = createMemoryWorld();

    const outcome = await resolveEffect({
      effect: stampOnly,
      request: request({ method: 'POST', endpointId: 'createRefund', body: {} }),
      store: memory.store,
      collections,
      seed: SEED,
      clockMs: CLOCK_MS,
    });

    expect(resolved(outcome).mutations[0]?.body?.['createdAt']).toBe(CLOCK_ISO);
  });

  it('moves the stamp only when the virtual clock moves', async () => {
    const memory = createMemoryWorld();

    const outcome = await resolveEffect({
      effect: stampOnly,
      request: request({ method: 'POST', endpointId: 'createRefund', body: {} }),
      store: memory.store,
      collections,
      seed: SEED,
      clockMs: CLOCK_MS + 86_400_000,
    });

    expect(resolved(outcome).mutations[0]?.body?.['createdAt']).toBe('2023-11-15T22:13:20.000Z');
  });
});

describe('resolveEffect — a selector the request supplies no value for', () => {
  const world = () =>
    createMemoryWorld({
      customers: [
        { id: 'cus_1', body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' } },
        { id: 'cus_2', body: { customerId: 'cus_2', name: 'Bob', tier: 'bronze' } },
      ],
      orders: [
        { id: 'ord_1', body: { orderId: 'ord_1', customerId: 'cus_1', status: 'open' } },
        { id: 'ord_2', body: { orderId: 'ord_2', customerId: 'cus_2', status: 'open' } },
      ],
    });

  it('reports a miss on a `one` read rather than answering with an unrelated entity', async () => {
    const memory = world();

    const outcome = await resolve({
      effect: getCustomer,
      request: request({ params: {} }),
      store: memory.store,
    });

    expect(outcome.kind).toBe('missing');
    if (outcome.kind !== 'missing') throw new Error('expected a missing outcome');
    expect(outcome.onMissing).toEqual({ respond: 404 });
    expect(outcome.unresolved).toEqual({
      entityPath: '/customerId',
      requestPath: '/params/customerId',
    });
  });

  it('issues no query at all, so a broadened read cannot reach the store', async () => {
    const memory = world();

    await resolve({ effect: getCustomer, request: request({ params: {} }), store: memory.store });

    expect(memory.queries).toEqual([]);
  });

  it('resolves a `many` read to an empty set rather than to the whole collection', async () => {
    const listOrders = WorldEffectSchema.parse({
      reads: [
        {
          collection: 'orders',
          cardinality: 'many',
          select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
          as: 'orders',
        },
      ],
      project: [{ bodyPath: '/orders', from: { read: 'orders' }, fields: [] }],
      status: 200,
    });
    const memory = world();

    const outcome = await resolve({
      effect: listOrders,
      request: request({ endpointId: 'listOrders', params: {} }),
      store: memory.store,
    });

    expect(resolved(outcome).body).toEqual({ orders: [] });
    expect(memory.queries).toEqual([]);
  });

  it('leaves a write targeting it with nothing to mutate', async () => {
    const closeOrders = WorldEffectSchema.parse({
      reads: [
        {
          collection: 'orders',
          cardinality: 'many',
          select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
          as: 'orders',
        },
      ],
      writes: [
        {
          collection: 'orders',
          op: 'update',
          identity: 'orderId',
          targetRead: 'orders',
          assign: { status: 'closed' },
        },
      ],
      project: [{ bodyPath: '/orders', from: { read: 'orders' }, fields: [] }],
      status: 200,
    });
    const memory = world();

    const outcome = await resolve({
      effect: closeOrders,
      request: request({ method: 'POST', endpointId: 'closeOrders', params: {} }),
      store: memory.store,
    });

    expect(resolved(outcome).mutations).toEqual([]);
  });
});

describe('resolveEffect — mutations against the collection schema', () => {
  const strictCollections: SimulationCollection[] = [
    {
      collection: 'refunds',
      identityField: 'refundId',
      schema: {
        type: 'object',
        properties: {
          refundId: { type: 'string' },
          orderId: { type: 'string' },
          amount: { type: 'number' },
          status: { type: 'string', enum: ['processed', 'pending'] },
        },
        required: ['refundId', 'orderId', 'amount', 'status'],
        additionalProperties: false,
      },
    },
  ];

  const createRefund = WorldEffectSchema.parse({
    writes: [
      {
        collection: 'refunds',
        op: 'create',
        identity: 'refundId',
        from: '/body',
        assign: { status: 'processed' },
        as: 'refund',
      },
    ],
    project: [{ bodyPath: '/', from: { write: 'refund' }, fields: [] }],
    status: 201,
  });

  const create = (body: unknown, declared: SimulationCollection[] = strictCollections) =>
    resolve({
      effect: createRefund,
      request: request({ method: 'POST', endpointId: 'createRefund', body }),
      store: createMemoryWorld({ refunds: [] }).store,
      collections: declared,
    });

  async function violation(promise: Promise<unknown>): Promise<SimulationWorldViolationError> {
    const error = await promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SimulationWorldViolationError);
    return error as SimulationWorldViolationError;
  }

  it('commits a conforming create', async () => {
    const outcome = await create({ orderId: 'ord_1', amount: 400 });

    expect(resolved(outcome).mutations).toHaveLength(1);
  });

  it('refuses a create whose body the collection schema forbids', async () => {
    const error = await violation(create({ orderId: 'ord_1', amount: 'four hundred' }));

    expect(error.collection).toBe('refunds');
    expect(error.issues.join(' ')).toContain('/amount');
    expect(error.message).toContain('refunds');
  });

  it('refuses a create the schema forbids for a field the request never supplied', async () => {
    const error = await violation(create({ orderId: 'ord_1' }));

    expect(error.issues.join(' ')).toContain('amount');
  });

  it('refuses an update whose assignment the collection schema forbids', async () => {
    const closeRefund = WorldEffectSchema.parse({
      reads: [
        {
          collection: 'refunds',
          cardinality: 'one',
          select: [{ entityPath: '/refundId', requestPath: '/params/refundId' }],
          as: 'refund',
        },
      ],
      writes: [
        {
          collection: 'refunds',
          op: 'update',
          identity: 'refundId',
          targetRead: 'refund',
          assign: { status: 'reversed' },
        },
      ],
      project: [{ bodyPath: '/', from: { read: 'refund' }, fields: [] }],
      status: 200,
    });
    const memory = createMemoryWorld({
      refunds: [
        {
          id: 'ref_1',
          body: { refundId: 'ref_1', orderId: 'ord_1', amount: 400, status: 'processed' },
        },
      ],
    });

    const error = await violation(
      resolve({
        effect: closeRefund,
        request: request({
          method: 'POST',
          endpointId: 'closeRefund',
          params: { refundId: 'ref_1' },
        }),
        store: memory.store,
        collections: strictCollections,
      }),
    );

    expect(error.issues.join(' ')).toContain('/status');
  });

  it('refuses an entity the collection cannot address', async () => {
    const misidentified = WorldEffectSchema.parse({
      writes: [
        { collection: 'refunds', op: 'create', identity: 'id', from: '/body', as: 'refund' },
      ],
      project: [{ bodyPath: '/', from: { write: 'refund' }, fields: [] }],
      status: 201,
    });

    const error = await violation(
      resolve({
        effect: misidentified,
        request: request({
          method: 'POST',
          endpointId: 'createRefund',
          body: { orderId: 'ord_1' },
        }),
        store: createMemoryWorld({ refunds: [] }).store,
        collections: [
          { collection: 'refunds', identityField: 'refundId', schema: { type: 'object' } },
        ],
      }),
    );

    expect(error.issues.join(' ')).toContain('refundId');
  });

  it('refuses a write into a collection the simulation does not declare', async () => {
    const error = await violation(create({ orderId: 'ord_1', amount: 400 }, []));

    expect(error.collection).toBe('refunds');
    expect(error.issues.join(' ')).toContain('not declared');
  });
});

describe('resolveEffect — a mutation and a sibling read of the same collection', () => {
  const collectionScoped = (extra: Record<string, unknown>) =>
    WorldEffectSchema.parse({
      reads: [
        {
          collection: 'orders',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/orderId', requestPath: '/params/orderId' }],
          as: 'target',
        },
        {
          collection: 'orders',
          cardinality: 'many',
          onMissing: 'generate',
          select: [{ entityPath: '/orderId', requestPath: '/params/otherId' }],
          as: 'bystander',
        },
      ],
      project: [{ bodyPath: '/bystander', from: { read: 'bystander' }, fields: [] }],
      status: 200,
      ...extra,
    });

  const world = () =>
    createMemoryWorld({
      orders: [
        { id: 'ord_a', body: { orderId: 'ord_a', status: 'open' } },
        { id: 'ord_b', body: { orderId: 'ord_b', status: 'open' } },
      ],
    });

  const call = () =>
    request({
      method: 'POST',
      endpointId: 'touchOrder',
      params: { orderId: 'ord_a', otherId: 'ord_b' },
    });

  it('does not leak an updated entity into a sibling read that never selected it', async () => {
    const memory = world();
    const outcome = await resolve({
      effect: collectionScoped({
        writes: [
          {
            collection: 'orders',
            op: 'update',
            identity: 'orderId',
            targetRead: 'target',
            assign: { status: 'refunded' },
          },
        ],
      }),
      request: call(),
      store: memory.store,
    });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    const body = outcome.body as { bystander: WorldEntity['body'][] };
    // Sharing a collection is not sharing a predicate: ord_a satisfies the
    // target read and never the bystander's.
    expect(body.bystander.map((e) => e['orderId'])).toEqual(['ord_b']);
  });

  it('drops an entity that its update moved out of the read predicate', async () => {
    const memory = world();
    const outcome = await resolve({
      effect: WorldEffectSchema.parse({
        reads: [
          {
            collection: 'orders',
            cardinality: 'many',
            onMissing: 'generate',
            select: [{ entityPath: '/status', requestPath: '/params/status' }],
            as: 'open',
          },
        ],
        writes: [
          {
            collection: 'orders',
            op: 'update',
            identity: 'orderId',
            targetRead: 'open',
            assign: { status: 'closed' },
          },
        ],
        project: [{ bodyPath: '/', from: { read: 'open' }, fields: [] }],
        status: 200,
      }),
      request: request({
        method: 'POST',
        endpointId: 'closeOpen',
        params: { status: 'open' },
      }),
      store: memory.store,
    });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.body).toEqual([]);
  });

  it('keeps a `one` read at one entity when a create also satisfies it', async () => {
    const memory = world();
    const outcome = await resolve({
      effect: WorldEffectSchema.parse({
        reads: [
          {
            collection: 'orders',
            cardinality: 'one',
            onMissing: { respond: 404 },
            select: [{ entityPath: '/status', requestPath: '/params/status' }],
            as: 'one',
          },
        ],
        writes: [
          {
            collection: 'orders',
            op: 'create',
            identity: 'orderId',
            assign: { status: 'open' },
          },
        ],
        project: [{ bodyPath: '/', from: { read: 'one' }, fields: [] }],
        status: 200,
      }),
      request: request({ method: 'POST', endpointId: 'addOrder', params: { status: 'open' } }),
      store: memory.store,
    });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    // A bounded read stays bounded, and stays about the entity it resolved to.
    expect((outcome.body as Record<string, unknown>)['orderId']).toBe('ord_a');
  });
});
