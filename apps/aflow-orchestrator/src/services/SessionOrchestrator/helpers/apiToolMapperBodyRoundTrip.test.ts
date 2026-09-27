import { describe, expect, it } from 'vitest';
import { deriveEndpointToolSchema, type ApiEndpoint } from '@aflow/schemas';
import { synthesizeEndpoints } from '@aflow/cybernetic-runtime';

/**
 * Mirror of `extractBody` from `apps/aflow-executor-api/src/handlers/api/body.ts`,
 * because this package cannot import the executor's. It proves the SYNTHESIS
 * half — a drafted endpoint becomes a tool schema an agent can fill — and
 * nothing about the executor: a mirror stays green while the thing it mirrors
 * regresses. What extraction actually does is held in that package's own
 * `body.test.ts`, against the real function.
 * Kept in lockstep with Half B; if the canonical extractor changes shape,
 * this mirror — and the corresponding assertion below — must change too.
 */
function simulateExtractBody(endpoint: ApiEndpoint, params: Record<string, unknown>): unknown {
  const declaresBody = endpoint.params.some((param) => param.location === 'body');
  if (!declaresBody) return undefined;

  const supplied = params['body'];
  if (supplied !== undefined) return supplied === null ? undefined : supplied;

  const bodyParams: Record<string, unknown> = {};
  let hasBody = false;
  for (const param of endpoint.params) {
    if (param.location === 'body') {
      const value = params[param.name];
      if (value !== undefined && value !== null) {
        bodyParams[param.name] = value;
        hasBody = true;
      }
    }
  }

  return hasBody ? bodyParams : undefined;
}

describe('Plan 148 — body param round trip (synthesis → tool schema → extract)', () => {
  it('agent body call flows verbatim from draft authoring through to body extraction', () => {
    // (1) Author the draft (the bind-capability LLM output).
    const draftEndpoints = [
      {
        method: 'POST' as const,
        path: '/v2/orders',
        summary: 'Submit an order',
        body: {
          contentType: 'application/json' as const,
          description: 'Order request: symbol, qty, side, type, time_in_force',
        },
      },
    ];

    // (2) Synthesize into a canonical ApiEndpoint.
    const [endpoint] = synthesizeEndpoints(draftEndpoints);
    if (!endpoint) throw new Error('synthesis produced no endpoint');
    expect(endpoint.params).toEqual([
      {
        name: 'body',
        location: 'body',
        required: true,
        description: 'Order request: symbol, qty, side, type, time_in_force',
      },
    ]);

    // (3) Map to a virtual tool's input JSON schema. With no canonical body
    // `schema` on this fixture, apiToolMapper falls back to `{ type: 'object' }`
    // but carries the body's `description` onto it so the agent still
    // sees the field guidance.
    const toolSchema = deriveEndpointToolSchema(endpoint);
    expect(toolSchema).toEqual({
      type: 'object',
      properties: {
        body: {
          type: 'object',
          description: 'Order request: symbol, qty, side, type, time_in_force',
        },
      },
      required: ['body'],
    });

    // (4) Simulate the agent's tool call: pass `body` as a top-level arg.
    const agentArgs = {
      body: {
        symbol: 'AAPL',
        qty: '1',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      },
    };
    const requestBody = simulateExtractBody(endpoint, agentArgs);
    // Bytes must be the agent's body value untouched — NOT `{ body: { … } }`.
    expect(requestBody).toEqual(agentArgs.body);
  });

  it('round trip preserves path + body composition (PATCH with both)', () => {
    const draftEndpoints = [
      {
        method: 'PATCH' as const,
        path: '/v2/orders/{orderId}',
        summary: 'Replace an existing order',
        body: {
          contentType: 'application/json' as const,
          description: 'Order patch: qty, limit_price, stop_price, time_in_force',
        },
      },
    ];

    const [endpoint] = synthesizeEndpoints(draftEndpoints);
    if (!endpoint) throw new Error('synthesis produced no endpoint');

    const toolSchema = deriveEndpointToolSchema(endpoint);
    // Path param appears as a top-level required string; body is the opaque
    // object, with its description carried onto it. Agent supplies both.
    expect(toolSchema).toEqual({
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        body: {
          type: 'object',
          description: 'Order patch: qty, limit_price, stop_price, time_in_force',
        },
      },
      required: ['orderId', 'body'],
    });

    const agentArgs = {
      orderId: 'abc-123',
      body: { qty: '2', limit_price: '180.50' },
    };
    expect(simulateExtractBody(endpoint, agentArgs)).toEqual(agentArgs.body);
  });

  it('GET endpoints with no body declaration have no body param in the tool schema', () => {
    const draftEndpoints = [
      {
        method: 'GET' as const,
        path: '/v2/quotes/{symbol}',
        summary: 'Latest quote',
      },
    ];

    const [endpoint] = synthesizeEndpoints(draftEndpoints);
    if (!endpoint) throw new Error('synthesis produced no endpoint');

    const toolSchema = deriveEndpointToolSchema(endpoint);
    expect(toolSchema).toEqual({
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    });
    expect(simulateExtractBody(endpoint, { symbol: 'AAPL' })).toBeUndefined();
  });
});
