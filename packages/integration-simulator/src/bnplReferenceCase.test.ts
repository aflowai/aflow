import AjvModule from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiEndpointSchema,
  SimulationRunContextSchema,
  SimulationSchema,
  type ApiEndpoint,
  type Simulation,
  type SimulationRunContext,
} from '@aflow/schemas';
import { runLadder } from './ladder.js';
import { responseSchemaFor, simulationReadiness } from './readiness.js';
import { applyMutation, queryWorld, type FoldedWorld } from './world.js';
import type { SimulatedRequest, SimulatedResponse, WorldStore } from './types.js';

/**
 * The BNPL support API, end to end against a world nobody has built.
 *
 * The case is the grammar's acceptance test rather than a demo: an endpoint
 * that returns what it created, a read-back that agrees with it, a nested
 * reference that addresses the entity it names, an escalation branch that
 * exists only because the world holds a collections case, an ordinal failure
 * injection, and a declared 404 whose body still satisfies the contract.
 */

interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}
interface AjvInstance {
  compile(schema: Record<string, unknown>): ValidateFn;
}
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const ajvModule = AjvModule as unknown as { default?: AjvConstructor };
const Ajv: AjvConstructor = ajvModule.default ?? (AjvModule as unknown as AjvConstructor);
const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });

const CLOCK_MS = 1_700_000_000_000;
const CLOCK_ISO = '2023-11-14T22:13:20.000Z';
const SEED = 'seed-bnpl';

// ============================================================================
// The definition — authored, never connected
// ============================================================================

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: { error: { type: 'string' }, retryAfter: { type: 'number' } },
};

const customerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['customerId', 'name', 'tier'],
  properties: {
    customerId: { type: 'string' },
    name: { type: 'string' },
    tier: { type: 'string', enum: ['bronze', 'gold'] },
  },
};

const customerRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } },
};

const orderSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'status', 'total', 'customer'],
  properties: {
    orderId: { type: 'string' },
    status: { type: 'string' },
    total: { type: 'number' },
    customer: customerRefSchema,
  },
};

const refundSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['refundId', 'orderId', 'amount', 'status', 'createdAt'],
  properties: {
    refundId: { type: 'string' },
    orderId: { type: 'string' },
    amount: { type: 'number' },
    reason: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
  },
};

const refundListSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['refunds'],
  properties: { refunds: { type: 'array', items: refundSchema } },
};

const paymentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paymentId', 'orderId', 'status', 'amount'],
  properties: {
    paymentId: { type: 'string' },
    orderId: { type: 'string' },
    status: { type: 'string' },
    amount: { type: 'number' },
    lastAttemptAt: { type: 'string' },
  },
};

const collectionsCaseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['caseId', 'stage', 'customer'],
  properties: {
    caseId: { type: 'string' },
    stage: { type: 'string', enum: ['in_collections', 'closed'] },
    openedAt: { type: 'string' },
    customer: customerRefSchema,
  },
};

const endpoints: ApiEndpoint[] = [
  ApiEndpointSchema.parse({
    endpointId: 'getCustomer',
    name: 'Get customer',
    method: 'GET',
    pathTemplate: '/customers/{customerId}',
    params: [{ name: 'customerId', location: 'path', required: true, schema: { type: 'string' } }],
    writeRiskTier: 'read',
    responseSchemas: { '2xx': customerSchema, '4xx': errorSchema },
  }),
  ApiEndpointSchema.parse({
    endpointId: 'getOrder',
    name: 'Get order',
    method: 'GET',
    pathTemplate: '/orders/{orderId}',
    params: [{ name: 'orderId', location: 'path', required: true, schema: { type: 'string' } }],
    writeRiskTier: 'read',
    responseSchemas: { '2xx': orderSchema, '4xx': errorSchema },
  }),
  ApiEndpointSchema.parse({
    endpointId: 'createRefund',
    name: 'Create refund',
    method: 'POST',
    pathTemplate: '/refunds',
    writeRiskTier: 'high',
    responseSchemas: { '2xx': refundSchema, '4xx': errorSchema },
  }),
  ApiEndpointSchema.parse({
    endpointId: 'listRefunds',
    name: 'List refunds',
    method: 'GET',
    pathTemplate: '/refunds',
    params: [{ name: 'orderId', location: 'query', required: true, schema: { type: 'string' } }],
    writeRiskTier: 'read',
    responseSchemas: { '2xx': refundListSchema, '4xx': errorSchema },
  }),
  ApiEndpointSchema.parse({
    endpointId: 'retryPayment',
    name: 'Retry payment',
    method: 'POST',
    pathTemplate: '/payments/{paymentId}/retry',
    params: [{ name: 'paymentId', location: 'path', required: true, schema: { type: 'string' } }],
    writeRiskTier: 'medium',
    responseSchemas: { '2xx': paymentSchema, '4xx': errorSchema },
  }),
  ApiEndpointSchema.parse({
    endpointId: 'getCollectionsStatus',
    name: 'Get collections status',
    method: 'GET',
    pathTemplate: '/customers/{customerId}/collections',
    params: [{ name: 'customerId', location: 'path', required: true, schema: { type: 'string' } }],
    writeRiskTier: 'read',
    responseSchemas: { '2xx': collectionsCaseSchema, '4xx': errorSchema },
  }),
];

// ============================================================================
// The simulation
// ============================================================================

const simulation: Simulation = SimulationSchema.parse({
  simulationId: 'bnpl-core',
  name: 'BNPL core',
  targets: { sourceKind: 'api', integrationId: 'bnpl-core' },
  persona: 'A buy-now-pay-later provider handling refunds, orders and payment issues.',
  collections: [
    {
      collection: 'customers',
      identityField: 'customerId',
      schema: customerSchema,
      ownership: 'shared',
    },
    {
      ownership: 'shared',
      collection: 'orders',
      identityField: 'orderId',
      schema: { type: 'object' },
    },
    {
      ownership: 'shared',
      collection: 'payments',
      identityField: 'paymentId',
      schema: { type: 'object' },
    },
    {
      ownership: 'shared',
      collection: 'refunds',
      identityField: 'refundId',
      schema: { type: 'object' },
    },
    {
      ownership: 'shared',
      collection: 'collections_cases',
      identityField: 'caseId',
      schema: { type: 'object' },
    },
  ],
  rules: [
    {
      ruleId: 'payments-rate-limit-on-third-retry',
      description: 'The payments provider 429s mid-recovery.',
      when: { endpointId: 'retryPayment', ordinal: 2 },
      respond: {
        status: 429,
        body: { error: 'rate_limited', retryAfter: 2 },
        headers: { 'retry-after': '2' },
      },
    },
  ],
  effects: {
    getCustomer: {
      reads: [
        {
          collection: 'customers',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/customerId', requestPath: '/params/customerId' }],
          as: 'customer',
        },
      ],
      project: [{ bodyPath: '/', from: { read: 'customer' } }],
      status: 200,
    },
    getOrder: {
      reads: [
        {
          collection: 'orders',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/orderId', requestPath: '/params/orderId' }],
          as: 'order',
        },
      ],
      project: [{ bodyPath: '/', from: { read: 'order' } }],
      status: 200,
    },
    createRefund: {
      reads: [
        {
          collection: 'orders',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/orderId', requestPath: '/body/orderId' }],
          as: 'order',
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
        {
          collection: 'orders',
          op: 'update',
          identity: 'orderId',
          targetRead: 'order',
          assign: { status: 'refunded' },
        },
      ],
      project: [{ bodyPath: '/', from: { write: 'refund' } }],
      status: 201,
    },
    listRefunds: {
      reads: [
        {
          collection: 'refunds',
          cardinality: 'many',
          onMissing: 'error',
          select: [{ entityPath: '/orderId', requestPath: '/params/orderId' }],
          as: 'refunds',
        },
      ],
      project: [{ bodyPath: '/refunds', from: { read: 'refunds' } }],
      status: 200,
    },
    retryPayment: {
      reads: [
        {
          collection: 'payments',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/paymentId', requestPath: '/params/paymentId' }],
          as: 'payment',
        },
      ],
      writes: [
        {
          collection: 'payments',
          op: 'update',
          identity: 'paymentId',
          targetRead: 'payment',
          assign: { status: 'retrying', lastAttemptAt: 'now' },
          as: 'retried',
        },
      ],
      project: [{ bodyPath: '/', from: { write: 'retried' } }],
      status: 200,
    },
    getCollectionsStatus: {
      reads: [
        {
          collection: 'collections_cases',
          cardinality: 'one',
          onMissing: { respond: 404 },
          select: [{ entityPath: '/customer/id', requestPath: '/params/customerId' }],
          as: 'case',
        },
      ],
      project: [{ bodyPath: '/', from: { read: 'case' } }],
      status: 200,
    },
  },
});

// ============================================================================
// The baseline world
// ============================================================================

interface BaselineRow {
  collection: string;
  entityId: string;
  body: Record<string, unknown>;
}

const baseline: BaselineRow[] = [
  {
    collection: 'customers',
    entityId: 'cus_1',
    body: { customerId: 'cus_1', name: 'Alice', tier: 'gold' },
  },
  {
    collection: 'customers',
    entityId: 'cus_2',
    body: { customerId: 'cus_2', name: 'Bob', tier: 'bronze' },
  },
  {
    collection: 'orders',
    entityId: 'ord_1',
    body: {
      orderId: 'ord_1',
      status: 'open',
      total: 400,
      customer: { id: 'cus_1', name: 'Alice' },
    },
  },
  {
    collection: 'payments',
    entityId: 'pay_1',
    body: { paymentId: 'pay_1', orderId: 'ord_1', status: 'failed', amount: 400 },
  },
  {
    collection: 'collections_cases',
    entityId: 'case_1',
    body: {
      caseId: 'case_1',
      stage: 'in_collections',
      openedAt: '2023-10-01T00:00:00.000Z',
      customer: { id: 'cus_2', name: 'Bob' },
    },
  },
  {
    // A closed case whose top-level `id` holds the customer the OPEN case
    // belongs to, while its own nested reference names someone else. A
    // selector reduced to its last segment matches this row for cus_2 and
    // reports a customer in collections as settled — the escalation branch
    // silently not firing, on an answer the agent has no way to question.
    collection: 'collections_cases',
    entityId: 'case_legacy',
    body: {
      caseId: 'case_legacy',
      id: 'cus_2',
      stage: 'closed',
      customer: { id: 'cus_7', name: 'Carol' },
    },
  },
];

const identityFields = new Map(simulation.collections.map((c) => [c.collection, c.identityField]));

// ============================================================================
// The harness — one call, the way the executor makes it
// ============================================================================

function runContext(): SimulationRunContext {
  return SimulationRunContextSchema.parse({
    simulationId: 'bnpl-core',
    simulationRevision: 1,
    baselineVersion: 1,
    snapshotRef: 'inline:e30=',
    definitionHash: 'bnpl_v1',
    seed: SEED,
    clockAnchorMs: CLOCK_MS,
  });
}

function endpointFor(endpointId: string): ApiEndpoint {
  const endpoint = endpoints.find((e) => e.endpointId === endpointId);
  if (!endpoint) throw new Error(`no endpoint "${endpointId}" in this definition`);
  return endpoint;
}

function buildUrl(endpoint: ApiEndpoint, params: Record<string, unknown>): string {
  const path = endpoint.pathTemplate.replaceAll(/\{(\w+)\}/g, (_all, name: string) =>
    String(params[name] ?? ''),
  );
  return `https://simulated.invalid/bnpl-core${path}`;
}

/** Mandatory and fail-loud, against the schema for the response's OWN status class. */
function assertContractHolds(endpoint: ApiEndpoint, response: SimulatedResponse): void {
  const schema = responseSchemaFor(endpoint, response.status);
  if (schema === undefined) {
    throw new Error(
      `${endpoint.endpointId} answered ${String(response.status)}, a status class it declares no schema for.`,
    );
  }
  const validate = ajv.compile(schema);
  if (!validate(response.body)) {
    throw new Error(
      `${endpoint.endpointId} answered a body outside its contract: ${JSON.stringify(validate.errors)}`,
    );
  }
}

interface Simulator {
  call(params: {
    endpointId: string;
    params?: Record<string, unknown>;
    body?: unknown;
  }): Promise<SimulatedResponse>;
  entity(collection: string, entityId: string): Record<string, unknown> | undefined;
}

function createSimulator(): Simulator {
  const world: FoldedWorld = new Map();
  for (const row of baseline) {
    applyMutation(world, {
      collection: row.collection,
      op: 'create',
      entityId: row.entityId,
      body: row.body,
    });
  }
  let version = 1;
  const ordinals = new Map<string, number>();

  const store: WorldStore = {
    version: () => version,
    stampOwnership: (mutations: readonly WorldMutation[]) => [...mutations],
    query: (query) =>
      Promise.resolve(queryWorld(world, query, identityFields.get(query.collection))),
    commit: (mutations) => {
      for (const mutation of mutations) applyMutation(world, mutation);
      version += 1;
      return Promise.resolve({ worldVersionAfter: version, applied: true });
    },
  };

  return {
    entity: (collection, entityId) => world.get(collection)?.get(entityId),
    async call(params) {
      const endpoint = endpointFor(params.endpointId);
      const callParams = params.params ?? {};
      const request: SimulatedRequest = {
        method: endpoint.method,
        url: buildUrl(endpoint, callParams),
        endpointId: endpoint.endpointId,
        params: callParams,
        body: params.body,
      };
      const ordinal = ordinals.get(endpoint.endpointId) ?? 0;
      ordinals.set(endpoint.endpointId, ordinal + 1);

      const response = await runLadder({
        simulation,
        endpoint,
        request,
        context: { runContext: runContext(), ordinal, clockMs: CLOCK_MS, store },
      });
      assertContractHolds(endpoint, response);
      // The executor commits the call's delta as one transaction with its
      // journal record, so every later read sees what this call changed.
      await store.commit(response.mutations);
      return response;
    },
  };
}

function bodyRecord(response: SimulatedResponse): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
    throw new Error(`expected an object body, got ${JSON.stringify(response.body)}`);
  }
  return response.body as Record<string, unknown>;
}

// ============================================================================
// The case
// ============================================================================

describe('bnpl-core — the simulation compiles', () => {
  it('is world-ready on every endpoint it declares an effect for', () => {
    const report = simulationReadiness({ endpoints }, simulation);

    expect(report.diagnostics).toEqual([]);
    expect(report.worldReadyCount).toBe(endpoints.length);
    expect(report.notReadyCount).toBe(0);
  });
});

describe('bnpl-core — getOrder', () => {
  it('returns the order and the customer it references', async () => {
    const sim = createSimulator();

    const response = await sim.call({ endpointId: 'getOrder', params: { orderId: 'ord_1' } });

    expect(response.rung).toBe('world');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      orderId: 'ord_1',
      status: 'open',
      total: 400,
      customer: { id: 'cus_1', name: 'Alice' },
    });
    expect(response.mutations).toEqual([]);
  });

  it('reports an order the world does not hold as its declared 404', async () => {
    const sim = createSimulator();

    const response = await sim.call({ endpointId: 'getOrder', params: { orderId: 'ord_typo' } });

    expect(response.status).toBe(404);
    expect(response.mutations).toEqual([]);
  });
});

describe('bnpl-core — createRefund', () => {
  let sim: Simulator;
  beforeEach(() => {
    sim = createSimulator();
  });

  it('returns the refund it created, not the order it read', async () => {
    const response = await sim.call({
      endpointId: 'createRefund',
      body: { orderId: 'ord_1', amount: 400, reason: 'damaged' },
    });

    expect(response.rung).toBe('world');
    expect(response.status).toBe(201);
    const body = bodyRecord(response);
    expect(body).toEqual({
      refundId: expect.stringMatching(/^refunds_[0-9a-f]{20}$/) as unknown as string,
      orderId: 'ord_1',
      amount: 400,
      reason: 'damaged',
      status: 'processed',
      createdAt: CLOCK_ISO,
    });
    expect(sim.entity('refunds', String(body['refundId']))).toEqual(body);
  });

  it('marks the order refunded in the same call', async () => {
    await sim.call({
      endpointId: 'createRefund',
      body: { orderId: 'ord_1', amount: 400, reason: 'damaged' },
    });

    expect(sim.entity('orders', 'ord_1')).toMatchObject({ orderId: 'ord_1', status: 'refunded' });
  });

  it('shows up in listRefunds afterwards', async () => {
    const created = bodyRecord(
      await sim.call({
        endpointId: 'createRefund',
        body: { orderId: 'ord_1', amount: 400, reason: 'damaged' },
      }),
    );

    const listed = await sim.call({ endpointId: 'listRefunds', params: { orderId: 'ord_1' } });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ refunds: [created] });
  });

  it('lists nothing for an order no refund names', async () => {
    const listed = await sim.call({ endpointId: 'listRefunds', params: { orderId: 'ord_1' } });

    expect(listed.body).toEqual({ refunds: [] });
  });
});

describe('bnpl-core — getCollectionsStatus', () => {
  it('drives the escalation branch for the customer the case names', async () => {
    const sim = createSimulator();

    const response = await sim.call({
      endpointId: 'getCollectionsStatus',
      params: { customerId: 'cus_2' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      caseId: 'case_1',
      stage: 'in_collections',
      openedAt: '2023-10-01T00:00:00.000Z',
      customer: { id: 'cus_2', name: 'Bob' },
    });
  });

  it('reports a customer no case names as not in collections', async () => {
    const sim = createSimulator();

    const response = await sim.call({
      endpointId: 'getCollectionsStatus',
      params: { customerId: 'cus_1' },
    });

    expect(response.status).toBe(404);
  });
});

describe('bnpl-core — retryPayment', () => {
  it('returns the payment it updated, then 429s on the third call', async () => {
    const sim = createSimulator();

    const first = await sim.call({ endpointId: 'retryPayment', params: { paymentId: 'pay_1' } });
    expect(first.rung).toBe('world');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      paymentId: 'pay_1',
      orderId: 'ord_1',
      status: 'retrying',
      amount: 400,
      lastAttemptAt: CLOCK_ISO,
    });

    const second = await sim.call({ endpointId: 'retryPayment', params: { paymentId: 'pay_1' } });
    expect(second.status).toBe(200);

    const third = await sim.call({ endpointId: 'retryPayment', params: { paymentId: 'pay_1' } });
    expect(third.rung).toBe('rule');
    expect(third.ruleId).toBe('payments-rate-limit-on-third-retry');
    expect(third.status).toBe(429);
    expect(third.headers).toEqual({ 'retry-after': '2' });
    expect(third.mutations).toEqual([]);
  });
});

describe('bnpl-core — getCustomer', () => {
  it('returns the customer the world holds', async () => {
    const sim = createSimulator();

    const response = await sim.call({ endpointId: 'getCustomer', params: { customerId: 'cus_1' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ customerId: 'cus_1', name: 'Alice', tier: 'gold' });
  });

  it('answers a miss with a 404 body its own status class admits', async () => {
    const sim = createSimulator();

    // assertContractHolds already validated it; the branch is only usable if a
    // declared 4xx shape is satisfied, so state that the body is not null.
    const response = await sim.call({
      endpointId: 'getCustomer',
      params: { customerId: 'cus_absent' },
    });

    expect(response.status).toBe(404);
    expect(response.rung).toBe('world');
    expect(response.body).toEqual({ error: '' });
    expect(response.mutations).toEqual([]);
  });
});
