import { describe, expect, it } from 'vitest';
import {
  ApiEndpointSchema,
  SimulationRunContextSchema,
  SimulationSchema,
  type ApiEndpoint,
  type Simulation,
  type SimulationRunContext,
} from '@aflow/schemas';
import {
  buildGenerationAsk,
  buildWorldSlice,
  generationOutputSchema,
  validateGeneratedAnswer,
  SimulationGenerationError,
  SimulationGenerationUnavailableError,
  WORLD_SLICE_SAMPLE_LIMIT,
  type GeneratedAnswer,
  type GenerateSimulatedAnswer,
  type GenerationAsk,
} from './generate.js';
import { runLadder } from './ladder.js';
import { applyMutation, queryWorld, type FoldedWorld } from './world.js';
import type {
  SimulatedRequest,
  SimulationContext,
  WorldEntity,
  WorldMutation,
  WorldReadQuery,
  WorldStore,
} from './types.js';

const CLOCK_MS = 1_700_000_000_000;

const customerSchema = {
  type: 'object',
  properties: {
    customerId: { type: 'string' },
    name: { type: 'string' },
    tier: { type: 'string', enum: ['bronze', 'gold'] },
  },
  required: ['customerId', 'name', 'tier'],
};

const orderSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    customerId: { type: 'string' },
    total: { type: 'number' },
    status: { type: 'string', enum: ['open', 'refunded'] },
  },
  required: ['orderId', 'customerId', 'total', 'status'],
};

const collections = [
  {
    collection: 'customers',
    identityField: 'customerId',
    schema: customerSchema,
    ownership: 'shared',
  },
  { collection: 'orders', identityField: 'orderId', schema: orderSchema, ownership: 'shared' },
];

const getCustomer: ApiEndpoint = ApiEndpointSchema.parse({
  endpointId: 'getCustomer',
  name: 'Get customer',
  method: 'GET',
  pathTemplate: '/customers/{customerId}',
  params: [{ name: 'customerId', location: 'path', required: true, schema: { type: 'string' } }],
  responseSchemas: {
    '2xx': customerSchema,
    '4xx': { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
  },
  writeRiskTier: 'read',
});

const listOrders: ApiEndpoint = ApiEndpointSchema.parse({
  endpointId: 'listOrders',
  name: 'List orders',
  method: 'GET',
  pathTemplate: '/customers/{customerId}/orders',
  params: [{ name: 'customerId', location: 'path', required: true, schema: { type: 'string' } }],
  responseSchemas: {
    '2xx': {
      type: 'object',
      properties: { orders: { type: 'array', items: orderSchema } },
      required: ['orders'],
    },
  },
});

const getCustomerEffect = {
  reads: [
    {
      collection: 'customers',
      cardinality: 'one',
      onMissing: 'generate',
      select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
      as: 'customer',
    },
  ],
  project: [{ bodyPath: '/', from: { read: 'customer' }, fields: [] }],
  status: 200,
};

function simulation(overrides: Record<string, unknown> = {}): Simulation {
  return SimulationSchema.parse({
    simulationId: 'sim_payments',
    name: 'Payments',
    targets: { sourceKind: 'api', integrationId: 'payments' },
    domainBrief: 'A retail payments provider with customers and their orders.',
    collections,
    ...overrides,
  });
}

function runContext(): SimulationRunContext {
  return SimulationRunContextSchema.parse({
    simulationId: 'sim_payments',
    simulationRevision: 1,
    baselineVersion: 1,
    snapshotRef: 'inline:e30=',
    definitionHash: 'def_hash',
    seed: 'seed-alpha',
    clockAnchorMs: CLOCK_MS,
  });
}

const identityFields = new Map(collections.map((c) => [c.collection, c.identityField]));

interface MemoryWorld {
  store: WorldStore;
  committed: WorldMutation[];
  queries: WorldReadQuery[];
}

function createMemoryWorld(seed: Record<string, WorldEntity[]> = {}): MemoryWorld {
  // The same fold the executor's store keeps, so what one call commits is what
  // the next one reads — the property a generated mutation stands or falls on.
  const world: FoldedWorld = new Map();
  for (const [collection, entities] of Object.entries(seed)) {
    for (const entity of entities) {
      applyMutation(world, { collection, op: 'create', entityId: entity.id, body: entity.body });
    }
  }
  const committed: WorldMutation[] = [];
  const queries: WorldReadQuery[] = [];
  let version = 1;

  return {
    committed,
    queries,
    store: {
      version: () => version,
      stampOwnership: (mutations: readonly WorldMutation[]) => [...mutations],
      query: (query: WorldReadQuery) => {
        queries.push(query);
        return Promise.resolve(queryWorld(world, query, identityFields.get(query.collection)));
      },
      commit: (mutations: WorldMutation[]) => {
        committed.push(...mutations);
        for (const mutation of mutations) applyMutation(world, mutation);
        version += 1;
        return Promise.resolve({ worldVersionAfter: version, applied: true });
      },
    },
  };
}

function request(overrides: Partial<SimulatedRequest> = {}): SimulatedRequest {
  return {
    method: 'GET',
    url: 'https://simulated.invalid/payments/customers/cus_1',
    endpointId: 'getCustomer',
    params: { customerId: 'cus_1' },
    body: undefined,
    ...overrides,
  };
}

function context(
  world: MemoryWorld,
  overrides: Partial<SimulationContext> = {},
): SimulationContext {
  return {
    runContext: runContext(),
    ordinal: 0,
    clockMs: CLOCK_MS,
    store: world.store,
    ...overrides,
  };
}

interface StubPort {
  generate: GenerateSimulatedAnswer;
  asks: GenerationAsk[];
}

function stubPort(answer: GeneratedAnswer | ((ask: GenerationAsk) => GeneratedAnswer)): StubPort {
  const asks: GenerationAsk[] = [];
  const generate: GenerateSimulatedAnswer = (ask) => {
    asks.push(ask);
    return Promise.resolve(typeof answer === 'function' ? answer(ask) : answer);
  };
  return { generate, asks };
}

const alice: WorldEntity = {
  id: 'cus_1',
  body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
};
const bob: WorldEntity = {
  id: 'cus_2',
  body: { customerId: 'cus_2', name: 'Bob', tier: 'bronze' },
};

function order(index: number, customerId: string): WorldEntity {
  return {
    id: `ord_${String(index)}`,
    body: { orderId: `ord_${String(index)}`, customerId, total: index * 10, status: 'open' },
  };
}

describe('buildWorldSlice', () => {
  it('returns the entity the request addresses by its identity', async () => {
    const world = createMemoryWorld({ customers: [alice, bob] });

    const slice = await buildWorldSlice({ request: request(), collections, store: world.store });

    const customers = slice.collections.find((c) => c.collection === 'customers');
    expect(customers?.matched.map((e) => e.id)).toEqual(['cus_1']);
    expect(customers?.sample.map((e) => e.id)).toEqual(['cus_2']);
  });

  it('reaches related rows through another collection`s identity field', async () => {
    // `orders` declares `customerId`, which is the identity of `customers`, so
    // a request naming a customer addresses that customer's orders without any
    // declared index and without an effect saying so.
    const world = createMemoryWorld({
      customers: [alice],
      orders: [order(1, 'cus_1'), order(2, 'cus_2'), order(3, 'cus_1')],
    });

    const slice = await buildWorldSlice({ request: request(), collections, store: world.store });

    const orders = slice.collections.find((c) => c.collection === 'orders');
    expect(orders?.matched.map((e) => e.id)).toEqual(['ord_1', 'ord_3']);
  });

  it('addresses rows by a request key the collection declares as a property', async () => {
    // `tier` is no collection's identity, so nothing relates rows by it. The
    // request naming the same key the schema declares is the declaration —
    // which is what a path parameter means.
    const world = createMemoryWorld({ customers: [alice, bob] });

    const slice = await buildWorldSlice({
      request: request({ params: { tier: 'gold' } }),
      collections,
      store: world.store,
    });

    const customers = slice.collections.find((c) => c.collection === 'customers');
    expect(customers?.matched.map((e) => e.id)).toEqual(['cus_1']);
  });

  it('follows one hop, so a collection related only through another is matched', async () => {
    // The request names a customer. `lines` carries no customerId, so only the
    // order ids reached in the first pass address them. Without the hop the
    // model sees `lines` as a bounded sample and totals an estimate.
    const lineSchema = {
      type: 'object',
      properties: { lineId: { type: 'string' }, orderId: { type: 'string' } },
      required: ['lineId', 'orderId'],
    };
    const related = [
      ...collections,
      { collection: 'lines', identityField: 'lineId', schema: lineSchema, ownership: 'shared' },
    ];
    const line = (id: string, orderId: string): WorldEntity => ({
      id,
      body: { lineId: id, orderId },
    });
    const world = createMemoryWorld({
      customers: [alice],
      orders: [order(1, 'cus_1'), order(2, 'cus_2')],
      lines: [line('lin_1', 'ord_1'), line('lin_2', 'ord_2')],
    });

    const slice = await buildWorldSlice({
      request: request(),
      collections: related,
      store: world.store,
    });

    const lines = slice.collections.find((c) => c.collection === 'lines');
    expect(lines?.matched.map((e) => e.id)).toEqual(['lin_1']);
  });

  it('bounds the sample and says the collection holds more', async () => {
    const world = createMemoryWorld({
      customers: [],
      orders: Array.from({ length: 20 }, (_, index) => order(index + 1, 'cus_9')),
    });

    const slice = await buildWorldSlice({
      request: request({ params: {} }),
      collections,
      store: world.store,
    });

    const orders = slice.collections.find((c) => c.collection === 'orders');
    expect(orders?.sample).toHaveLength(WORLD_SLICE_SAMPLE_LIMIT);
    expect(orders?.truncated).toBe(true);
    expect(orders?.matched).toEqual([]);
  });
});

describe('generationOutputSchema', () => {
  it('inlines the endpoint`s success schema as the body, and each collection`s schema as a mutation body', () => {
    const schema = generationOutputSchema({ endpoint: getCustomer, collections });
    const properties = schema?.['properties'] as Record<string, unknown>;

    expect(properties['body']).toEqual(customerSchema);
    // The endpoint declares one success status, so the caller stamps it rather
    // than asking the model to echo a constant it can only get wrong.
    expect(properties['status']).toBeUndefined();
    expect(schema?.['required']).toEqual(['body', 'mutations']);

    const mutations = properties['mutations'] as Record<string, unknown>;
    const items = mutations['items'] as { anyOf: Array<Record<string, unknown>> };
    const bodies = items.anyOf.map((branch) => {
      const branchProperties = branch['properties'] as Record<string, unknown>;
      return branchProperties['body'];
    });
    expect(bodies).toEqual([customerSchema, orderSchema]);
  });

  it('has nothing to constrain an answer with when the endpoint declares no success schema', () => {
    const schemaless = ApiEndpointSchema.parse({
      endpointId: 'ping',
      name: 'Ping',
      method: 'GET',
      pathTemplate: '/ping',
    });

    expect(generationOutputSchema({ endpoint: schemaless, collections })).toBeUndefined();
  });
});

describe('buildGenerationAsk', () => {
  it('carries the request, the response schema and the world slice', async () => {
    const world = createMemoryWorld({ customers: [alice], orders: [order(1, 'cus_1')] });
    const slice = await buildWorldSlice({ request: request(), collections, store: world.store });

    const ask = buildGenerationAsk({
      simulation: simulation(),
      endpoint: getCustomer,
      request: request(),
      world: slice,
      clockMs: CLOCK_MS,
      priorCalls: [{ endpointId: 'listOrders', status: 200 }],
    });

    expect(ask?.request.params).toEqual({ customerId: 'cus_1' });
    expect(ask?.success).toEqual({ status: 200, schema: customerSchema });
    expect(ask?.domainBrief).toContain('retail payments provider');
    expect(ask?.clockMs).toBe(CLOCK_MS);
    expect(ask?.priorCalls).toEqual([{ endpointId: 'listOrders', status: 200 }]);
    expect(
      ask?.world.collections.find((c) => c.collection === 'customers')?.matched.map((e) => e.id),
    ).toEqual(['cus_1']);
    expect(ask?.endpoint.params.map((p) => p.name)).toEqual(['customerId']);
    // The write-risk tier is orchestrator-plane and never crosses into a model's context.
    expect(Object.keys(ask?.endpoint ?? {})).not.toContain('writeRiskTier');
  });
});

describe('validateGeneratedAnswer', () => {
  it('accepts an answer inside the response schema and its collections', () => {
    const issues = validateGeneratedAnswer({
      endpoint: getCustomer,
      collections,
      answer: {
        status: 200,
        body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
        mutations: [
          {
            collection: 'orders',
            op: 'create',
            entityId: 'ord_9',
            body: { orderId: 'ord_9', customerId: 'cus_1', total: 12, status: 'open' },
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it('reports a status the endpoint declares no schema for', () => {
    const issues = validateGeneratedAnswer({
      endpoint: getCustomer,
      collections,
      answer: { status: 503, body: {}, mutations: [] },
    });

    expect(issues[0]?.location).toBe('status');
    expect(issues[0]?.detail).toContain("responseSchemas['5xx']");
  });

  it('reports a create carrying no post-image', () => {
    const issues = validateGeneratedAnswer({
      endpoint: getCustomer,
      collections,
      answer: {
        status: 200,
        body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
        mutations: [{ collection: 'orders', op: 'create', entityId: 'ord_9' }],
      },
    });

    expect(issues[0]?.location).toBe('mutations[0]');
    expect(issues[0]?.detail).toContain('post-image');
  });
});

describe('runLadder — rung 3 with a model', () => {
  it('answers an endpoint with no effect and no rule, rather than falling to the contract example', async () => {
    const world = createMemoryWorld({ customers: [alice], orders: [order(1, 'cus_1')] });
    const port = stubPort({
      status: 200,
      body: { orders: [{ orderId: 'ord_1', customerId: 'cus_1', total: 10, status: 'open' }] },
      mutations: [],
    });

    const response = await runLadder({
      simulation: simulation(),
      endpoint: listOrders,
      request: request({ endpointId: 'listOrders' }),
      context: context(world, { generate: port.generate }),
    });

    expect(response.rung).toBe('generated');
    expect(response.body).toEqual({
      orders: [{ orderId: 'ord_1', customerId: 'cus_1', total: 10, status: 'open' }],
    });
    expect(port.asks).toHaveLength(1);
    expect(port.asks[0]?.endpoint.endpointId).toBe('listOrders');
  });

  it('answers an effect whose read missed, instead of asking the caller for facts', async () => {
    const world = createMemoryWorld({ customers: [] });
    const port = stubPort({
      status: 200,
      body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
      mutations: [
        {
          collection: 'customers',
          op: 'create',
          entityId: 'cus_1',
          body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
        },
      ],
    });

    const response = await runLadder({
      simulation: simulation({ effects: { getCustomer: getCustomerEffect } }),
      endpoint: getCustomer,
      request: request(),
      context: context(world, { generate: port.generate }),
    });

    expect(response.rung).toBe('generated');
    expect(response.generationRequest).toBeUndefined();
    // Returned, not committed: the caller owns the journal record the commit
    // belongs to, so the ladder never writes.
    expect(response.mutations).toEqual([
      {
        collection: 'customers',
        op: 'create',
        entityId: 'cus_1',
        body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
      },
    ]);
    expect(world.committed).toEqual([]);
  });

  it('rejects a body outside the endpoint`s response schema', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const port = stubPort({
      status: 200,
      body: { customerId: 'cus_1', name: 'Alice', tier: 'platinum' },
      mutations: [],
    });

    await expect(
      runLadder({
        simulation: simulation(),
        endpoint: getCustomer,
        request: request(),
        context: context(world, { generate: port.generate }),
      }),
    ).rejects.toThrow(SimulationGenerationError);
  });

  it('fails the call when generation is unavailable, rather than answering from the contract', async () => {
    // The contract example proves wiring and nothing about behaviour. Falling
    // into it because the space has no provider would present one as the
    // other, and it is the same class as a spent ceiling — which already
    // refuses loudly.
    const world = createMemoryWorld({ customers: [alice] });
    const unavailable: GenerateSimulatedAnswer = () =>
      Promise.reject(
        new SimulationGenerationUnavailableError('listOrders', 'No provider connected.'),
      );

    await expect(
      runLadder({
        simulation: simulation(),
        endpoint: listOrders,
        request: request({ endpointId: 'listOrders' }),
        context: context(world, { generate: unavailable }),
      }),
    ).rejects.toBeInstanceOf(SimulationGenerationUnavailableError);
  });

  it('carries the rejected answer, because the violation alone does not say which side is wrong', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const refused = { error: 'not_found', message: 'No such customer.' };
    const port = stubPort({ status: 200, body: refused, mutations: [] });

    const failure = await runLadder({
      simulation: simulation(),
      endpoint: getCustomer,
      request: request(),
      context: context(world, { generate: port.generate }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SimulationGenerationError);
    expect((failure as SimulationGenerationError).answer.body).toEqual(refused);
  });

  it('rejects a mutation outside its collection schema', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const port = stubPort({
      status: 200,
      body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
      mutations: [
        {
          collection: 'orders',
          op: 'create',
          entityId: 'ord_9',
          body: { orderId: 'ord_9', customerId: 'cus_1', total: 12, status: 'settled' },
        },
      ],
    });

    await expect(
      runLadder({
        simulation: simulation(),
        endpoint: getCustomer,
        request: request(),
        context: context(world, { generate: port.generate }),
      }),
    ).rejects.toThrow(/SIMULATION_GENERATION_INVALID/);
  });

  it('commits what it generated, so the next call reads it from the world', async () => {
    const world = createMemoryWorld({ customers: [] });
    const invented = { customerId: 'cus_1', name: 'Alice', tier: 'gold' };
    const port = stubPort({
      status: 200,
      body: invented,
      mutations: [{ collection: 'customers', op: 'create', entityId: 'cus_1', body: invented }],
    });
    const sim = simulation({ effects: { getCustomer: getCustomerEffect } });

    const first = await runLadder({
      simulation: sim,
      endpoint: getCustomer,
      request: request(),
      context: context(world, { generate: port.generate }),
    });
    // The one commit every rung's delta goes through, wherever the answer came
    // from. The executor makes it unconditionally, once, per call.
    await world.store.commit(first.mutations);

    const second = await runLadder({
      simulation: sim,
      endpoint: getCustomer,
      request: request(),
      context: context(world, { generate: port.generate, ordinal: 1 }),
    });

    expect(second.rung).toBe('world');
    expect(second.body).toEqual(invented);
    // An entity read a second time is served from the world without reaching
    // the model, which is what keeps the rung's cost bounded across a run.
    expect(port.asks).toHaveLength(1);
  });

  it('never reaches the port when the policy refuses to invent', async () => {
    const world = createMemoryWorld({ customers: [] });
    const port = stubPort({ status: 200, body: {}, mutations: [] });

    await expect(
      runLadder({
        simulation: simulation({ policy: { unmatched: 'error' } }),
        endpoint: listOrders,
        request: request({ endpointId: 'listOrders' }),
        context: context(world, { generate: port.generate }),
      }),
    ).rejects.toThrow(/refuses to invent/);
    expect(port.asks).toEqual([]);
  });

  it('never reaches the port when an effect`s read misses and the policy refuses', async () => {
    const world = createMemoryWorld({ customers: [] });
    const port = stubPort({ status: 200, body: {}, mutations: [] });

    await expect(
      runLadder({
        simulation: simulation({
          effects: { getCustomer: getCustomerEffect },
          policy: { unmatched: 'error' },
        }),
        endpoint: getCustomer,
        request: request(),
        context: context(world, { generate: port.generate }),
      }),
    ).rejects.toThrow(/generation is disabled/);
    expect(port.asks).toEqual([]);
  });

  it('answers from a declared rule without reaching the port', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const port = stubPort({ status: 200, body: {}, mutations: [] });

    const response = await runLadder({
      simulation: simulation({
        rules: [
          {
            ruleId: 'rate-limited',
            when: { endpointId: 'getCustomer' },
            respond: { status: 429, body: { error: 'slow down' } },
          },
        ],
      }),
      endpoint: getCustomer,
      request: request(),
      context: context(world, { generate: port.generate }),
    });

    expect(response.rung).toBe('rule');
    expect(port.asks).toEqual([]);
  });

  it('falls to the contract example when the endpoint has no success schema to constrain an answer', async () => {
    const world = createMemoryWorld();
    const port = stubPort({ status: 200, body: {}, mutations: [] });
    const schemaless = ApiEndpointSchema.parse({
      endpointId: 'ping',
      name: 'Ping',
      method: 'GET',
      pathTemplate: '/ping',
    });

    await expect(
      runLadder({
        simulation: simulation(),
        endpoint: schemaless,
        request: request({ endpointId: 'ping' }),
        context: context(world, { generate: port.generate }),
      }),
    ).rejects.toThrow(/declares no success response schema/);
    expect(port.asks).toEqual([]);
  });
});
