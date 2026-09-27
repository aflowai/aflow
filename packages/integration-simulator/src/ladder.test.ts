import { describe, expect, it } from 'vitest';
import {
  ApiEndpointSchema,
  SimulationRunContextSchema,
  SimulationSchema,
  type ApiEndpoint,
  type Simulation,
  type SimulationRunContext,
} from '@aflow/schemas';
import { contractExample, runLadder, SimulationUnmatchedError } from './ladder.js';
import { responseSchemaFor } from './readiness.js';
import { entityMatchesQuery } from './world.js';
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

const getCustomerEndpoint: ApiEndpoint = ApiEndpointSchema.parse({
  endpointId: 'getCustomer',
  name: 'Get customer',
  method: 'GET',
  pathTemplate: '/customers/{customerId}',
  params: [{ name: 'customerId', location: 'path', required: true, schema: { type: 'string' } }],
  responseSchemas: {
    '2xx': customerSchema,
    '4xx': { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
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
    collections: [
      {
        collection: 'customers',
        identityField: 'customerId',
        schema: customerSchema,
        ownership: 'shared',
      },
    ],
    effects: { getCustomer: getCustomerEffect },
    ...overrides,
  });
}

function runContext(overrides: Record<string, unknown> = {}): SimulationRunContext {
  return SimulationRunContextSchema.parse({
    simulationId: 'sim_payments',
    simulationRevision: 1,
    baselineVersion: 1,
    snapshotRef: 'inline:e30=',
    definitionHash: 'def_hash',
    seed: 'seed-alpha',
    clockAnchorMs: CLOCK_MS,
    ...overrides,
  });
}

interface MemoryWorld {
  store: WorldStore;
  committed: WorldMutation[];
  queries: WorldReadQuery[];
}

function createMemoryWorld(seed: Record<string, WorldEntity[]> = {}): MemoryWorld {
  const world = new Map<string, WorldEntity[]>(Object.entries(seed));
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
        const rows = (world.get(query.collection) ?? []).filter((entity) =>
          entityMatchesQuery(entity, query, 'customerId'),
        );
        return Promise.resolve(rows);
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

const alice: WorldEntity = {
  id: 'cus_1',
  body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
};

describe('runLadder — rung 1, declared rules', () => {
  it('answers from a matching rule even when the endpoint has a world effect', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      rules: [
        {
          ruleId: 'rate-limited',
          when: { endpointId: 'getCustomer' },
          respond: {
            status: 429,
            body: { error: 'slow down' },
            headers: { 'retry-after': '2' },
          },
        },
      ],
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.rung).toBe('rule');
    expect(response.ruleId).toBe('rate-limited');
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: 'slow down' });
    expect(response.headers).toEqual({ 'retry-after': '2' });
    expect(response.mutations).toEqual([]);
    // The effect was never resolved: a rule that reaches the world would make
    // the cheapest rung the expensive one.
    expect(world.queries).toEqual([]);
  });

  it('falls through to the world when the rule ordinal does not match this call', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      rules: [
        {
          ruleId: 'third-call-429',
          when: { endpointId: 'getCustomer', ordinal: 2 },
          respond: { status: 429 },
        },
      ],
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world, { ordinal: 0 }),
    });

    expect(response.rung).toBe('world');
    expect(response.status).toBe(200);
  });
});

describe('runLadder — a rule transition', () => {
  const tierRule = (transition: unknown) => ({
    ruleId: 'downgrade',
    when: { endpointId: 'getCustomer' },
    respond: { status: 200, body: { customerId: 'cus_1', name: 'Alice', tier: 'bronze' } },
    transition,
  });

  it('applies an update over the read the transition declares', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      rules: [
        tierRule({
          reads: [
            {
              collection: 'customers',
              select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
              as: 'customer',
            },
          ],
          writes: [
            {
              collection: 'customers',
              op: 'update',
              identity: 'customerId',
              targetRead: 'customer',
              assign: { tier: 'bronze' },
            },
          ],
        }),
      ],
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.rung).toBe('rule');
    expect(response.mutations).toEqual([
      {
        collection: 'customers',
        op: 'update',
        entityId: 'cus_1',
        body: { customerId: 'cus_1', name: 'Alice', tier: 'bronze' },
      },
    ]);
  });

  it('refuses at authoring time a transition whose update has no read to target', () => {
    // Accepted, this rule would answer 200 and change nothing on every call,
    // which is indistinguishable from a working simulation.
    expect(() =>
      simulation({
        rules: [
          tierRule({
            writes: [
              {
                collection: 'customers',
                op: 'update',
                identity: 'customerId',
                assign: { tier: 'bronze' },
              },
            ],
          }),
        ],
      }),
    ).toThrow(/must name the read/);
  });
});

describe('runLadder — rung 2, the world', () => {
  it('projects the entity the effect read', async () => {
    const world = createMemoryWorld({ customers: [alice] });

    const response = await runLadder({
      simulation: simulation(),
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.rung).toBe('world');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ customerId: 'cus_1', name: 'Alice', tier: 'gold' });
    expect(response.generationRequest).toBeUndefined();
  });

  it('responds with the declared status when onMissing names one', async () => {
    const world = createMemoryWorld({ customers: [] });
    const sim = simulation({
      effects: {
        getCustomer: {
          ...getCustomerEffect,
          reads: [{ ...getCustomerEffect.reads[0], onMissing: { respond: 404 } }],
        },
      },
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.status).toBe(404);
    expect(response.rung).toBe('world');
    expect(response.mutations).toEqual([]);
    expect(response.generationRequest).toBeUndefined();
  });

  it('renders the onMissing status class from its own declared schema', async () => {
    const world = createMemoryWorld({ customers: [] });
    const sim = simulation({
      effects: {
        getCustomer: {
          ...getCustomerEffect,
          reads: [{ ...getCustomerEffect.reads[0], onMissing: { respond: 404 } }],
        },
      },
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    // A null body would fail the mandatory response-schema check downstream,
    // which would make the whole "report it missing" branch unusable on any
    // endpoint that declares its 4xx shape.
    expect(response.body).toEqual({ error: '' });
  });

  it('throws when onMissing is `error`', async () => {
    const world = createMemoryWorld({ customers: [] });
    const sim = simulation({
      effects: {
        getCustomer: {
          ...getCustomerEffect,
          reads: [{ ...getCustomerEffect.reads[0], onMissing: 'error' }],
        },
      },
    });

    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(SimulationUnmatchedError);
  });
});

describe('runLadder — rung 3, generation', () => {
  it('asks for the missing FACTS and commits nothing yet', async () => {
    const world = createMemoryWorld({ customers: [] });
    const sim = simulation();

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.rung).toBe('generated');
    expect(response.generationRequest?.effect).toEqual(sim.effects['getCustomer']);
    expect(response.generationRequest?.missing).toEqual([
      { collection: 'customers', match: [{ path: '/customerId', value: 'cus_1' }], limit: 1 },
    ]);
    expect(response.mutations).toEqual([]);
    expect(world.committed).toEqual([]);
  });

  it('refuses to invent when the policy is `error`, even where generation would be allowed', async () => {
    const world = createMemoryWorld({ customers: [] });
    const sim = simulation({ policy: { unmatched: 'error' } });

    expect(sim.effects['getCustomer']?.reads[0]?.onMissing).toBe('generate');
    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(SimulationUnmatchedError);
  });
});

describe('the rung that used to stand below generation', () => {
  // `contract_example` was removed rather than deprecated. It could only fire
  // when generation declined, generation declines only on a missing success
  // schema, and `contractExample` throws on exactly that — so no call in the
  // executor could ever reach it. What is left is an honest refusal.
  it('is gone: a schemaless endpoint refuses instead of synthesizing', async () => {
    const schemaless = ApiEndpointSchema.parse({
      endpointId: 'getCustomer',
      name: 'Get customer',
      method: 'GET',
      pathTemplate: '/customers/{customerId}',
    });

    await expect(
      runLadder({
        simulation: simulation({ effects: {} }),
        endpoint: schemaless,
        request: request(),
        // A model IS available here. Without one the refusal is the other
        // refusal — the caller has nothing to generate with — and this case
        // would pass while never reaching the branch it names.
        context: context(createMemoryWorld(), {
          generate: () => {
            throw new Error('an ask that cannot be constrained is never made');
          },
        }),
      }),
    ).rejects.toThrow(/declares no success response schema/);
  });

  it('names the missing model, not the missing schema, when the caller has neither', async () => {
    await expect(
      runLadder({
        simulation: simulation({ effects: {} }),
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(createMemoryWorld()),
      }),
    ).rejects.toThrow(/no model to answer with/);
  });

  it('keeps the synthesizer for authoring surfaces, with its own refusal intact', () => {
    const schemaless = ApiEndpointSchema.parse({
      endpointId: 'getCustomer',
      name: 'Get customer',
      method: 'GET',
      pathTemplate: '/customers/{customerId}',
    });
    expect(() => contractExample(schemaless)).toThrow(/declares no success response schema/);
    expect(contractExample(getCustomerEndpoint).status).toBe(200);
  });
});

describe('responseSchemaFor', () => {
  it('selects the schema for the response`s OWN status class', () => {
    expect(responseSchemaFor(getCustomerEndpoint, 200)).toEqual(customerSchema);
    expect(responseSchemaFor(getCustomerEndpoint, 404)).toEqual({
      type: 'object',
      properties: { error: { type: 'string' } },
      required: ['error'],
    });
    expect(responseSchemaFor(getCustomerEndpoint, 503)).toBeUndefined();
  });
});

describe('runLadder — a request that supplies no value for a selector', () => {
  const noCustomerId = () => request({ params: {} });

  it('refuses to generate an entity for a predicate the caller never stated', async () => {
    const world = createMemoryWorld({ customers: [alice] });

    await expect(
      runLadder({
        simulation: simulation(),
        endpoint: getCustomerEndpoint,
        request: noCustomerId(),
        context: context(world),
      }),
    ).rejects.toThrow(SimulationUnmatchedError);
  });

  it('answers with the read`s declared missing status when it has one', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      effects: {
        getCustomer: {
          ...getCustomerEffect,
          reads: [{ ...getCustomerEffect.reads[0], onMissing: { respond: 404 } }],
        },
      },
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: noCustomerId(),
      context: context(world),
    });

    expect(response.status).toBe(404);
    expect(response.mutations).toEqual([]);
  });
});

describe('runLadder — a rule transition against the collection schema', () => {
  const transitionRule = (transition: unknown) => ({
    ruleId: 'downgrade',
    when: { endpointId: 'getCustomer' },
    respond: { status: 200, body: { customerId: 'cus_1', name: 'Alice', tier: 'bronze' } },
    transition,
  });

  const customerUpdate = (assign: Record<string, unknown>, collection = 'customers') => ({
    reads: [
      {
        collection,
        select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
        as: 'customer',
      },
    ],
    writes: [{ collection, op: 'update', identity: 'customerId', targetRead: 'customer', assign }],
  });

  it('refuses a transition body the collection schema forbids', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      rules: [transitionRule(customerUpdate({ tier: 'platinum' }))],
    });

    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(/SIMULATION_WORLD_VIOLATION/);
  });

  it('refuses a transition into a collection the simulation does not declare', async () => {
    const world = createMemoryWorld({ prospects: [alice] });
    const sim = simulation({
      rules: [transitionRule(customerUpdate({ tier: 'bronze' }, 'prospects'))],
    });

    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(/not declared/);
  });
});

describe('runLadder — a declared onMissing body', () => {
  const simWithOnMissing = (onMissing: unknown) =>
    simulation({
      effects: {
        getCustomer: {
          ...getCustomerEffect,
          reads: [{ ...getCustomerEffect.reads[0], onMissing }],
        },
      },
    });

  it('answers with the body the author declared', async () => {
    const world = createMemoryWorld({});
    const answer = await runLadder({
      simulation: simWithOnMissing({
        respond: 404,
        body: { error: 'No customer with that reference.' },
      }),
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: 'No customer with that reference.' });
  });

  it('falls back to a synthesized body when the author declared none', async () => {
    const world = createMemoryWorld({});
    const answer = await runLadder({
      simulation: simWithOnMissing({ respond: 404 }),
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(answer.status).toBe(404);
    // Required members only — well-formed, and deliberately not informative.
    expect(answer.body).toEqual({ error: '' });
  });
});

describe('runLadder — rung 1.5, what a code handler may write', () => {
  it('refuses a write to a collection the handler did not declare', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      handlers: {
        getCustomer: {
          collections: ['customers'],
          code: `return {
            status: 200,
            body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
            mutations: [
              { collection: 'audit', op: 'create', entityId: newId('audit'), body: { at: now } },
            ],
          };`,
        },
      },
    });

    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(/does not declare|not in its declared collections/);
    expect(world.committed).toEqual([]);
  });

  it('refuses a write that does not satisfy its collection schema', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      handlers: {
        getCustomer: {
          collections: ['customers'],
          code: `return {
            status: 200,
            body: {},
            mutations: [
              { collection: 'customers', op: 'update', entityId: 'cus_1', body: { tier: 'platinum' } },
            ],
          };`,
        },
      },
    });

    await expect(
      runLadder({
        simulation: sim,
        endpoint: getCustomerEndpoint,
        request: request(),
        context: context(world),
      }),
    ).rejects.toThrow(/customers/);
    expect(world.committed).toEqual([]);
  });

  it('returns a write that satisfies both', async () => {
    const world = createMemoryWorld({ customers: [alice] });
    const sim = simulation({
      handlers: {
        getCustomer: {
          collections: ['customers'],
          code: `return {
            status: 200,
            body: world.customers[0],
            mutations: [
              {
                collection: 'customers',
                op: 'update',
                entityId: 'cus_1',
                body: { customerId: 'cus_1', name: 'Alice', tier: 'bronze' },
              },
            ],
          };`,
        },
      },
    });

    const response = await runLadder({
      simulation: sim,
      endpoint: getCustomerEndpoint,
      request: request(),
      context: context(world),
    });

    expect(response.rung).toBe('code');
    expect(response.mutations).toEqual([
      {
        collection: 'customers',
        op: 'update',
        entityId: 'cus_1',
        body: { customerId: 'cus_1', name: 'Alice', tier: 'bronze' },
      },
    ]);
  });
});
