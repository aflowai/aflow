import { describe, expect, it } from 'vitest';
import {
  ApiEndpointSchema,
  SimulationSchema,
  type ApiEndpoint,
  type Simulation,
  type SimulationDiagnosticCode,
} from '@aflow/schemas';
import { endpointReadiness, simulationReadiness, statusClassOf } from './readiness.js';

const customerSchema = {
  type: 'object',
  properties: { customerId: { type: 'string' }, name: { type: 'string' } },
  required: ['customerId', 'name'],
};

function endpoint(overrides: Record<string, unknown> = {}): ApiEndpoint {
  return ApiEndpointSchema.parse({
    endpointId: 'getCustomer',
    name: 'Get customer',
    method: 'GET',
    pathTemplate: '/customers/{customerId}',
    responseSchemas: { '2xx': customerSchema },
    ...overrides,
  });
}

const getCustomerEffect = {
  reads: [
    {
      collection: 'customers',
      cardinality: 'one',
      onMissing: { respond: 404 },
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
    ...overrides,
  });
}

function codes(diagnostics: ReadonlyArray<{ code: SimulationDiagnosticCode }>): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/**
 * Codes a whole-artifact assertion is about, minus `collection_unread`.
 *
 * These fixtures are minimal on purpose — they declare the one collection a
 * rule or effect case needs and no effect reading it, which is exactly what
 * `collection_unread` reports. Filtering it keeps each assertion about the one
 * property it was written for, rather than restating the whole report.
 */
function codesExceptUnread(
  diagnostics: ReadonlyArray<{ code: SimulationDiagnosticCode }>,
): string[] {
  return codes(diagnostics).filter((code) => code !== 'collection_unread');
}

/** The one finding an assertion is about, found by code rather than position. */
function byCode<T extends { code: SimulationDiagnosticCode }>(
  diagnostics: readonly T[],
  code: SimulationDiagnosticCode,
): T | undefined {
  return diagnostics.find((diagnostic) => diagnostic.code === code);
}

describe('endpointReadiness', () => {
  it('is contract_ready with a compiling success schema and no effect', () => {
    const report = endpointReadiness(endpoint(), simulation());

    expect(report.readiness).toBe('contract_ready');
    expect(report.hasEffect).toBe(false);
    expect(report.declaredStatusClasses).toEqual(['2xx']);
    expect(report.diagnostics).toEqual([]);
  });

  it('is world_ready with a compiling effect', () => {
    const report = endpointReadiness(
      endpoint(),
      simulation({ effects: { getCustomer: getCustomerEffect } }),
    );

    expect(report.readiness).toBe('world_ready');
    expect(report.hasEffect).toBe(true);
    expect(report.diagnostics).toEqual([]);
  });

  it('is not_ready with no response schemas at all', () => {
    const report = endpointReadiness(
      endpoint({ responseSchemas: undefined }),
      simulation({ effects: { getCustomer: getCustomerEffect } }),
    );

    expect(report.readiness).toBe('not_ready');
    expect(report.declaredStatusClasses).toEqual([]);
    expect(codes(report.diagnostics)).toContain('response_schema_missing');
  });

  it('is not_ready when a declared schema does not compile', () => {
    const report = endpointReadiness(
      endpoint({ responseSchemas: { '2xx': { type: 'not-a-type' } } }),
      simulation(),
    );

    expect(report.readiness).toBe('not_ready');
    expect(codes(report.diagnostics)).toEqual(['response_schema_uncompilable']);
    expect(report.diagnostics[0]?.detail).toContain("responseSchemas['2xx']");
  });

  it('drops to contract_ready when the effect names a collection nobody declared', () => {
    // The effect is authored against a declared collection and the collection
    // is dropped afterwards — readiness is recomputed at read, so the drift
    // surfaces without anything having to restamp the endpoint.
    const authored = simulation({ effects: { getCustomer: getCustomerEffect } });
    const drifted: Simulation = { ...authored, collections: [] };

    const report = endpointReadiness(endpoint(), drifted);

    expect(report.readiness).toBe('contract_ready');
    expect(report.hasEffect).toBe(true);
    expect(codesExceptUnread(report.diagnostics)).toEqual(['effect_collection_unknown']);
    expect(byCode(report.diagnostics, 'effect_collection_unknown')?.detail).toContain('customers');
  });

  it('reports a projection whose named source no read supplies', () => {
    const drifted: Simulation = {
      ...simulation(),
      effects: {
        getCustomer: {
          reads: [],
          writes: [],
          project: [{ bodyPath: '/', from: { read: 'customer' }, fields: [] }],
          status: 200,
        },
      },
    };

    expect(codes(endpointReadiness(endpoint(), drifted).diagnostics)).toEqual([
      'effect_projection_invalid',
    ]);
  });
});

describe('simulationReadiness', () => {
  const listRefunds = endpoint({
    endpointId: 'listRefunds',
    name: 'List refunds',
    responseSchemas: undefined,
  });

  it('counts each endpoint at its own level', () => {
    const report = simulationReadiness(
      { endpoints: [endpoint(), listRefunds] },
      simulation({ effects: { getCustomer: getCustomerEffect } }),
    );

    expect(report.worldReadyCount).toBe(1);
    expect(report.contractReadyCount).toBe(0);
    expect(report.notReadyCount).toBe(1);
    expect(report.endpoints.map((e) => e.endpointId)).toEqual(['getCustomer', 'listRefunds']);
  });

  it('reports a rule answering a status class the endpoint never declared', () => {
    const report = simulationReadiness(
      { endpoints: [endpoint()] },
      simulation({
        rules: [
          {
            ruleId: 'rate-limited',
            when: { endpointId: 'getCustomer' },
            respond: { status: 429 },
          },
        ],
      }),
    );

    expect(codesExceptUnread(report.diagnostics)).toEqual(['rule_status_undeclared']);
    const ruleFinding = byCode(report.diagnostics, 'rule_status_undeclared');
    expect(ruleFinding?.ruleId).toBe('rate-limited');
    expect(ruleFinding?.detail).toContain("responseSchemas['4xx']");
    // The endpoint itself stays usable — one unfinished rule disabling the
    // integration would make incremental authoring impossible.
    expect(report.endpoints[0]?.readiness).toBe('contract_ready');
  });

  it('accepts a rule whose status class the endpoint does declare', () => {
    const report = simulationReadiness(
      {
        endpoints: [
          endpoint({ responseSchemas: { '2xx': customerSchema, '4xx': customerSchema } }),
        ],
      },
      simulation({
        rules: [
          {
            ruleId: 'rate-limited',
            when: { endpointId: 'getCustomer' },
            respond: { status: 429 },
          },
        ],
      }),
    );

    // Scoped to the rule axis: this fixture declares `customers` with no
    // effect reading it, which `collection_unread` reports on its own.
    expect(codesExceptUnread(report.diagnostics)).toEqual([]);
  });

  it('reports an effect declared for an endpoint the definition does not have', () => {
    const report = simulationReadiness(
      { endpoints: [endpoint()] },
      simulation({ effects: { deleteCustomer: getCustomerEffect } }),
    );

    expect(codes(report.diagnostics)).toEqual(['effect_uncompilable']);
    expect(byCode(report.diagnostics, 'effect_uncompilable')?.endpointId).toBe('deleteCustomer');
  });
});

describe('statusClassOf', () => {
  it('maps a status to the key the response-schema lookup uses', () => {
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf(404)).toBe('4xx');
    expect(statusClassOf(429)).toBe('4xx');
    expect(statusClassOf(503)).toBe('5xx');
  });
});

describe('a collection nothing reads', () => {
  const unreadDefinition = {
    endpoints: [
      ApiEndpointSchema.parse({
        endpointId: 'listClasses',
        name: 'List classes',
        method: 'GET',
        pathTemplate: '/classes',
        responseSchemas: { '2xx': { type: 'object' } },
      }),
    ],
  };

  function withEffects(effects: Record<string, unknown>): Simulation {
    return SimulationSchema.parse({
      simulationId: 'studio-sim',
      name: 'Studio',
      targets: { sourceKind: 'api', integrationId: 'studio-core' },
      collections: [
        {
          collection: 'classes',
          identityField: 'classId',
          ownership: 'shared',
          schema: { type: 'object' },
        },
        {
          collection: 'bookings',
          identityField: 'bookingId',
          ownership: 'shared',
          schema: { type: 'object' },
        },
      ],
      effects,
    });
  }

  function unread(simulation: Simulation): string[] {
    return simulationReadiness(unreadDefinition, simulation)
      .diagnostics.filter((d) => d.code === 'collection_unread')
      .map((d) => d.collection ?? '')
      .sort();
  }

  it('is reported, because seeding it costs a model call on every request', () => {
    // The exact artifact an agent produced when asked for "a small world so it
    // isn't inventing everything": collections and seed rows, no effects. Every
    // endpoint stayed generation-only and the world was never read.
    expect(unread(withEffects({}))).toEqual(['bookings', 'classes']);
  });

  it('is silent once an effect reads it', () => {
    expect(
      unread(
        withEffects({
          listClasses: {
            reads: [{ collection: 'classes', select: [], cardinality: 'many', as: 'classes' }],
            writes: [],
            project: [{ bodyPath: '/', from: { read: 'classes' }, fields: [] }],
            status: 200,
          },
        }),
      ),
    ).toEqual(['bookings']);
  });

  it('counts a write as reaching the collection, not only a read', () => {
    expect(
      unread(
        withEffects({
          listClasses: {
            reads: [{ collection: 'classes', select: [], cardinality: 'many', as: 'classes' }],
            writes: [
              { collection: 'bookings', op: 'create', identity: 'bookingId', as: 'booking' },
            ],
            project: [{ bodyPath: '/', from: { write: 'booking' }, fields: [] }],
            status: 200,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('simulationReadiness — a body written by hand', () => {
  const notFoundEndpoint = endpoint({
    responseSchemas: {
      '2xx': customerSchema,
      '4xx': { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    },
  });

  it('reports a rule body outside the status class it answers', () => {
    const report = simulationReadiness(
      { endpoints: [notFoundEndpoint] },
      simulation({
        rules: [
          {
            ruleId: 'rate-limited',
            when: { endpointId: 'getCustomer' },
            respond: { status: 429, body: { message: 'slow down' } },
          },
        ],
      }),
    );

    expect(codesExceptUnread(report.diagnostics)).toEqual(['authored_body_off_contract']);
    const finding = byCode(report.diagnostics, 'authored_body_off_contract');
    expect(finding?.ruleId).toBe('rate-limited');
    expect(finding?.detail).toContain("responseSchemas['4xx']");
  });

  it('reports an onMissing body outside the status class it answers', () => {
    const report = simulationReadiness(
      { endpoints: [notFoundEndpoint] },
      simulation({
        effects: {
          getCustomer: {
            ...getCustomerEffect,
            reads: [
              {
                ...getCustomerEffect.reads[0],
                onMissing: { respond: 404, body: { detail: 'no such customer' } },
              },
            ],
          },
        },
      }),
    );

    expect(codesExceptUnread(report.diagnostics)).toEqual(['authored_body_off_contract']);
    expect(byCode(report.diagnostics, 'authored_body_off_contract')?.endpointId).toBe(
      'getCustomer',
    );
  });

  it('says nothing when the authored body satisfies the contract', () => {
    const report = simulationReadiness(
      { endpoints: [notFoundEndpoint] },
      simulation({
        effects: {
          getCustomer: {
            ...getCustomerEffect,
            reads: [
              {
                ...getCustomerEffect.reads[0],
                onMissing: { respond: 404, body: { error: 'no such customer' } },
              },
            ],
          },
        },
      }),
    );

    expect(codesExceptUnread(report.diagnostics)).toEqual([]);
  });

  it('stays silent about a body whose status class is already reported undeclared', () => {
    const report = simulationReadiness(
      { endpoints: [endpoint()] },
      simulation({
        rules: [
          {
            ruleId: 'rate-limited',
            when: { endpointId: 'getCustomer' },
            respond: { status: 429, body: { message: 'slow down' } },
          },
        ],
      }),
    );

    // One authoring mistake, one finding: the class is undeclared, so there is
    // no contract for the body to be off.
    expect(codesExceptUnread(report.diagnostics)).toEqual(['rule_status_undeclared']);
  });
});
