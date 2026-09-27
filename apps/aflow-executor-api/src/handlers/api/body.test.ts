import { describe, it, expect } from 'vitest';
import { ApiEndpointSchema, type ApiEndpoint } from '@aflow/schemas';
import { extractBody } from './body.js';
import { validateEndpointBody } from './validateBody.js';

function endpoint(params: ApiEndpoint['params']): ApiEndpoint {
  return {
    endpointId: 'post_v2_orders',
    name: 'Submit order',
    method: 'POST',
    pathTemplate: '/v2/orders',
    params,
    tags: [],
  };
}

describe('extractBody', () => {
  // ==========================================================================

  it('passes the agent body through verbatim for the single-body-param shape', () => {
    const ep = endpoint([{ name: 'body', location: 'body', required: true }]);
    const orderRequest = {
      symbol: 'AAPL',
      qty: '1',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    };
    expect(extractBody(ep, { body: orderRequest })).toEqual(orderRequest);
  });

  it('returns undefined when the agent omits the body arg', () => {
    const ep = endpoint([{ name: 'body', location: 'body', required: true }]);
    expect(extractBody(ep, {})).toBeUndefined();
  });

  it('passes a primitive body value through (e.g., raw JSON array)', () => {
    const ep = endpoint([{ name: 'body', location: 'body', required: true }]);
    expect(extractBody(ep, { body: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(extractBody(ep, { body: 'just-a-string' })).toBe('just-a-string');
  });

  it('returns undefined when there are no body params on the endpoint (GET endpoint)', () => {
    const ep: ApiEndpoint = {
      endpointId: 'get_quote',
      name: 'Get quote',
      method: 'GET',
      pathTemplate: '/v1/quote',
      params: [{ name: 'symbol', location: 'query', required: true }],
      tags: [],
    };
    expect(extractBody(ep, { symbol: 'AAPL' })).toBeUndefined();
  });

  it('ignores path and query params when assembling the body', () => {
    const ep = endpoint([
      { name: 'orderId', location: 'path', required: true },
      { name: 'preview', location: 'query', required: false },
      { name: 'body', location: 'body', required: true },
    ]);
    expect(
      extractBody(ep, {
        orderId: 'abc-123',
        preview: 'true',
        body: { qty: '2' },
      }),
    ).toEqual({ qty: '2' });
  });

  // ==========================================================================
  // Legacy multi-named-body-param case — kept for backwards compatibility with

  it('collects multiple named body params into an object (legacy hand-authored case)', () => {
    const ep = endpoint([
      { name: 'foo', location: 'body', required: true },
      { name: 'bar', location: 'body', required: false },
    ]);
    expect(extractBody(ep, { foo: 1, bar: 'two' })).toEqual({ foo: 1, bar: 'two' });
  });

  it('omits undefined body fields from the assembled object', () => {
    const ep = endpoint([
      { name: 'foo', location: 'body', required: true },
      { name: 'bar', location: 'body', required: false },
    ]);
    expect(extractBody(ep, { foo: 1 })).toEqual({ foo: 1 });
  });
});

describe('extractBody — a body declared field by field', () => {
  const claimEndpoint = ApiEndpointSchema.parse({
    endpointId: 'openClaim',
    name: 'Open claim',
    method: 'POST',
    pathTemplate: '/claims',
    params: [
      { name: 'reason', location: 'body', required: true, schema: { type: 'string' } },
      { name: 'detail', location: 'body', required: true, schema: { type: 'string' } },
      { name: 'confirmed', location: 'body', required: true, schema: { type: 'boolean' } },
    ],
  });

  it('takes the nested envelope the tool schema asks the model for', () => {
    // The tool schema advertises one `body` property whichever way the fields
    // were declared, so this is what the model sends. Reading only
    // `params[fieldName]` left a live write with no body at all.
    const sent = { reason: 'damaged', detail: 'dented', confirmed: true };
    expect(extractBody(claimEndpoint, { body: sent })).toEqual(sent);
  });

  it('still accepts the fields flat, for a caller composing the call itself', () => {
    expect(
      extractBody(claimEndpoint, { reason: 'damaged', detail: 'dented', confirmed: true }),
    ).toEqual({ reason: 'damaged', detail: 'dented', confirmed: true });
  });

  it('does not swallow siblings when one field is itself named body', () => {
    // The two shapes are ambiguous here, and preferring the envelope dropped
    // `title` on the floor.
    const endpoint = ApiEndpointSchema.parse({
      endpointId: 'postNote',
      name: 'Post note',
      method: 'POST',
      pathTemplate: '/notes',
      params: [
        { name: 'body', location: 'body', required: true, schema: { type: 'string' } },
        { name: 'title', location: 'body', required: true, schema: { type: 'string' } },
      ],
    });

    expect(extractBody(endpoint, { body: 'text', title: 'T' })).toEqual({
      body: 'text',
      title: 'T',
    });
  });
});

describe('validateEndpointBody — the shapes the tool schema advertises', () => {
  const claimEndpoint = ApiEndpointSchema.parse({
    endpointId: 'openClaim',
    name: 'Open claim',
    method: 'POST',
    pathTemplate: '/claims',
    params: [
      { name: 'reason', location: 'body', required: true, schema: { type: 'string' } },
      { name: 'detail', location: 'body', required: true, schema: { type: 'string' } },
      { name: 'confirmed', location: 'body', required: true, schema: { type: 'boolean' } },
    ],
  });

  it('accepts a body carrying every required field', () => {
    expect(
      validateEndpointBody(claimEndpoint, {
        reason: 'damaged',
        detail: 'dented',
        confirmed: true,
      }),
    ).toBeNull();
  });

  it('refuses a multi-field body missing a required field', () => {
    // Marked required for the model and unchecked for everyone else was the
    // gap: a raw `api.http.call` could send half a write.
    const err = validateEndpointBody(claimEndpoint, { reason: 'damaged' });
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/detail|confirmed/);
  });

  it('refuses a wrongly typed field', () => {
    const err = validateEndpointBody(claimEndpoint, {
      reason: 'damaged',
      detail: 'dented',
      confirmed: 'yes',
    });
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/confirmed/);
  });
});
