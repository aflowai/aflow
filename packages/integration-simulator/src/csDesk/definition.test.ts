import { describe, expect, it } from 'vitest';
import {
  ApiEndpointSchema,
  SimulationSchema,
  SimulationRunContextSchema,
  deriveEndpointBodySchema,
  deriveEndpointToolSchema,
  type ApiEndpoint,
  type Simulation,
} from '@aflow/schemas';
import { contractExample, runLadder, SimulationUnmatchedError } from '../ladder.js';
import { responseSchemaFor, simulationReadiness } from '../readiness.js';
import { compileSchema } from '../schemaCheck.js';
import type { SimulatedRequest, WorldStore } from '../types.js';
import { CS_DESK_API_ID, CS_DESK_DEFINITION, CS_DESK_ENDPOINTS } from './definition.js';
import { HANDOVER_REASONS } from './envelope.js';

/**
 * The desk's contract, before any behaviour exists behind it.
 *
 * Everything here is answerable from the definition alone, which is the point:
 * an endpoint that cannot state a valid response has nothing for a handler to
 * fill in later, and the failure is cheapest to find now.
 */

const endpoints: ApiEndpoint[] = CS_DESK_ENDPOINTS.map((e) => ApiEndpointSchema.parse(e));

function endpointFor(endpointId: string): ApiEndpoint {
  const endpoint = endpoints.find((e) => e.endpointId === endpointId);
  if (!endpoint) throw new Error(`no endpoint "${endpointId}"`);
  return endpoint;
}

function bodySchemaFor(endpointId: string): Record<string, unknown> {
  const schema = deriveEndpointBodySchema(endpointFor(endpointId));
  if (!schema) throw new Error(`${endpointId} derives no body schema`);
  return schema;
}

function accepts(endpointId: string, value: unknown): boolean {
  const compiled = compileSchema(bodySchemaFor(endpointId));
  if (!compiled.ok)
    throw new Error(`${endpointId} body schema does not compile: ${compiled.detail}`);
  return compiled.validate(value);
}

describe('the definition is well formed', () => {
  it('parses every endpoint', () => {
    expect(endpoints).toHaveLength(7);
    expect(endpoints.map((e) => e.endpointId)).toEqual([
      'knowledge_search',
      'orders_select',
      'order_inspect',
      'payments_search',
      'payment_inspect',
      'claim_inspect',
      'handover_start',
    ]);
  });

  it('compiles every declared response schema under the platform validator', () => {
    for (const endpoint of endpoints) {
      for (const [statusClass, schema] of Object.entries(endpoint.responseSchemas ?? {})) {
        const compiled = compileSchema(schema);
        expect(
          compiled.ok,
          `${endpoint.endpointId} ${statusClass}: ${compiled.ok ? '' : compiled.detail}`,
        ).toBe(true);
      }
    }
  });

  it('names an explicit risk tier on every endpoint, since all seven are POST', () => {
    // A POST with no tier derives to `low`, which would let a read be treated
    // as a write. The six reads say `read` and the transfer says what it is.
    for (const endpoint of endpoints) {
      expect(endpoint.method, endpoint.endpointId).toBe('POST');
      expect(endpoint.writeRiskTier, endpoint.endpointId).toBeDefined();
    }
    expect(endpointFor('handover_start').writeRiskTier).toBe('low');
    expect(
      endpoints.filter((e) => e.writeRiskTier === 'read').map((e) => e.endpointId),
    ).toHaveLength(6);
  });

  it('carries each tool input contract whole, as one body parameter', () => {
    for (const endpoint of endpoints) {
      const bodyParams = endpoint.params.filter((p) => p.location === 'body');
      expect(bodyParams, endpoint.endpointId).toHaveLength(1);
      // The executor reads a single body parameter as a FIELD of the body while
      // this derivation reads it as the WHOLE body. Naming it `body` is what
      // makes the two agree, so a caller has one spelling rather than two that
      // differ by a wrapping level.
      expect(bodyParams[0]?.name, endpoint.endpointId).toBe('body');
      // A single body param is passed through verbatim, so the agent's tool
      // schema IS the spec's schema rather than a flattened approximation.
      expect(deriveEndpointToolSchema(endpoint)).toMatchObject({
        properties: { body: bodySchemaFor(endpoint.endpointId) },
        required: ['body'],
      });
    }
  });
});

/**
 * Every suggested next action the source tables emit is replaced by a fact the
 * result already carries, and sixteen of the twenty-seven are the same fact:
 * this assessment requires a human, for this reason. That only works if the
 * reason a read states is a reason the transfer accepts.
 */
describe('the escalation reason is the handover reason', () => {
  function reasonEnum(endpointId: string, pointer: (schema: never) => unknown): string[] {
    const endpoint = endpointFor(endpointId);
    const value = pointer(endpoint as never);
    return value as string[];
  }

  it('reads and the transfer share one enum', () => {
    const success = endpointFor('order_inspect').responseSchemas?.['2xx'] as {
      properties: { escalations: { items: { properties: { reason: { enum: string[] } } } } };
    };
    const stated = success.properties.escalations.items.properties.reason.enum;

    const transfer = bodySchemaFor('handover_start') as {
      properties: { reason: { enum: string[] } };
    };
    const accepted = transfer.properties.reason.enum;

    expect(stated).toEqual(accepted);
    expect(stated).toEqual([...HANDOVER_REASONS]);
  });

  it('offers escalations on every endpoint that can require review', () => {
    for (const endpoint of endpoints) {
      const success = endpoint.responseSchemas?.['2xx'] as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(success.properties), endpoint.endpointId).toContain('escalations');
    }
    void reasonEnum;
  });
});

describe('the input contracts refuse what the source specification refuses', () => {
  it('takes a window search and a cursor page, and refuses both at once', () => {
    expect(
      accepts('payments_search', { occurred_from: '2026-08-01', occurred_to: '2026-08-31' }),
    ).toBe(true);
    expect(accepts('payments_search', { cursor: 'page-2' })).toBe(true);
    expect(
      accepts('payments_search', {
        cursor: 'page-2',
        occurred_from: '2026-08-01',
        occurred_to: '2026-08-31',
      }),
      'a cursor carries its own filters, so a window alongside it names two different searches',
    ).toBe(false);
  });

  it('refuses an amount with no currency', () => {
    // Written as draft-07 `dependencies` rather than `dependentRequired`: the
    // platform compiles with a draft-07 Ajv, which ignores the 2020-12 spelling
    // silently — the failure direction where the contract looks enforced and
    // is not.
    const window = { occurred_from: '2026-08-01', occurred_to: '2026-08-31' };
    expect(accepts('payments_search', { ...window, amount: 50 })).toBe(false);
    expect(accepts('payments_search', { ...window, amount: 50, currency: 'SAR' })).toBe(true);
    expect(accepts('orders_select', { amount: 50 })).toBe(false);
    expect(accepts('orders_select', { amount: 50, currency: 'SAR' })).toBe(true);
  });

  it('refuses a card fragment that is not four digits, and never takes it as identity', () => {
    const window = { occurred_from: '2026-08-01', occurred_to: '2026-08-31' };
    expect(accepts('payments_search', { ...window, last_four: '4242' })).toBe(true);
    expect(accepts('payments_search', { ...window, last_four: '42' })).toBe(false);
    expect(accepts('payments_search', { last_four: '4242' })).toBe(false);
  });

  it('refuses an argument no tool declares', () => {
    expect(accepts('order_inspect', { order_ref: 'ORD-1' })).toBe(true);
    expect(accepts('order_inspect', { order_ref: 'ORD-1', customer_id: 'cus_1' })).toBe(false);
    expect(
      accepts('knowledge_search', { topic: 'refunds', question: 'how long?', language: 'en' }),
    ).toBe(true);
    expect(
      accepts('knowledge_search', { topic: 'warranties', question: 'x', language: 'en' }),
    ).toBe(false);
  });

  it('requires a transfer to state its reason, goal, summary and what was tried', () => {
    const whole = {
      reason: 'technical_investigation',
      customer_goal: 'understand why the payment failed',
      summary: 'three declines on the same card',
      attempted_actions: ['order_inspect', 'payment_inspect'],
    };
    expect(accepts('handover_start', whole)).toBe(true);
    for (const field of Object.keys(whole)) {
      const missing = { ...whole } as Record<string, unknown>;
      delete missing[field];
      expect(accepts('handover_start', missing), `missing ${field}`).toBe(false);
    }
    expect(accepts('handover_start', { ...whole, reason: 'because_i_said_so' })).toBe(false);
  });

  it('lets orders.select open the default scope with no filters at all', () => {
    expect(accepts('orders_select', {})).toBe(true);
  });
});

/**
 * With no rules, no effects and no world, the only thing the definition can
 * produce is the contract example — a minimal synthesis from each endpoint's
 * own success schema. It proves the wiring and nothing else, which is exactly
 * what `contract_ready` claims and is the state the desk ships in before a
 * single handler is written.
 */
describe('every endpoint answers before any behaviour is authored', () => {
  const bareSimulation: Simulation = SimulationSchema.parse({
    simulationId: 'cs-desk',
    name: 'Customer support desk',
    targets: { sourceKind: 'api', integrationId: CS_DESK_API_ID },
  });

  const inertStore: WorldStore = {
    version: () => 1,
    stampOwnership: (mutations) => [...mutations],
    query: () => Promise.resolve([]),
    commit: () => Promise.resolve({ worldVersionAfter: 1, applied: true }),
  };

  it('reports all seven contract-ready, and none world-ready', () => {
    const report = simulationReadiness(CS_DESK_DEFINITION as never, bareSimulation);
    for (const endpoint of report.endpoints) {
      expect(
        endpoint.readiness,
        `${endpoint.endpointId}: ${JSON.stringify(endpoint.diagnostics)}`,
      ).toBe('contract_ready');
      expect(endpoint.declaredStatusClasses, endpoint.endpointId).toEqual(['2xx', '4xx', '5xx']);
    }
    expect(report.contractReadyCount).toBe(7);
    expect(report.worldReadyCount).toBe(0);
    expect(report.notReadyCount).toBe(0);
  });

  it('synthesizes an example inside its own declared contract, for each endpoint', () => {
    for (const endpoint of endpoints) {
      const example = contractExample(endpoint);
      const schema = responseSchemaFor(endpoint, example.status);
      expect(schema, `${endpoint.endpointId} has no schema for ${example.status}`).toBeDefined();
      const compiled = compileSchema(schema as Record<string, unknown>);
      if (!compiled.ok) throw new Error(compiled.detail);
      expect(
        compiled.validate(example.body),
        `${endpoint.endpointId}: ${JSON.stringify(compiled.validate.errors)}`,
      ).toBe(true);
    }
  });

  it('refuses rather than inventing, when the caller holds no model', async () => {
    // The api executor always supplies the generation port, so this is the
    // shape of a test, an inspector or an eval-grade replay — and a refusal is
    // the honest answer there. The contract example is reachable, but only to
    // a caller that asks for it by name.
    const endpoint = endpointFor('order_inspect');
    const request: SimulatedRequest = {
      method: endpoint.method,
      url: `https://simulated.invalid/${CS_DESK_API_ID}${endpoint.pathTemplate}`,
      endpointId: endpoint.endpointId,
      params: {},
      body: { order_ref: 'ORD-1' },
    };
    await expect(
      runLadder({
        simulation: bareSimulation,
        endpoint,
        request,
        context: {
          runContext: SimulationRunContextSchema.parse({
            simulationId: 'cs-desk',
            simulationRevision: 1,
            baselineVersion: 1,
            snapshotRef: 'inline:e30=',
            definitionHash: 'cs_desk_v0_1',
            seed: 'seed-cs-desk',
            clockAnchorMs: 1_780_000_000_000,
          }),
          logicalExecutionId: 'probe-order-inspect',
          ordinal: 0,
          clockMs: 1_780_000_000_000,
          store: inertStore,
        },
      }),
    ).rejects.toThrow(SimulationUnmatchedError);
  });
});
