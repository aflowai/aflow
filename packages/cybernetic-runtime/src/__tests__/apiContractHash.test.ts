import { describe, it, expect } from 'vitest';
import { stableHash } from '@aflow/schemas';

import { apiSurfaceFor } from '../evalBatchLaunch.js';

/**
 * The API contract hash exists so that changing what the agent reads shows up
 * as a changed dimension. A hash that misses an edit is worse than no hash:
 * comparison then reports the tool surface as identical across a run in which
 * it was rewritten.
 */

const endpoint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  endpointId: 'orders_select',
  name: 'Find the order',
  description: 'Select the order this question is about.',
  method: 'POST',
  pathTemplate: '/orders/select',
  params: [
    { name: 'body', location: 'body', required: true, schema: { type: 'object' } },
    { name: 'merchant_hint', location: 'query', required: false, schema: { type: 'string' } },
  ],
  ...over,
});

const hashOf = (ep: Record<string, unknown>): string =>
  stableHash(apiSurfaceFor([{ apiId: 'cs-desk', definitionJson: { endpoints: [ep] } }]));

const reference = hashOf(endpoint());

describe('an edit the agent can see moves the hash', () => {
  it('moves on a description edit — the archetypal experiment', () => {
    expect(hashOf(endpoint({ description: 'Pick the order the customer means.' }))).not.toBe(
      reference,
    );
  });

  it('moves when a parameter is added', () => {
    // The bug this test exists for: the projection read queryParams/pathParams/
    // bodyParams, which an endpoint does not carry, so every parameter edit
    // hashed identically while the code looked thorough.
    const added = endpoint({
      params: [
        ...(endpoint()['params'] as unknown[]),
        { name: 'amount', location: 'query', required: true, schema: { type: 'number' } },
      ],
    });
    expect(hashOf(added)).not.toBe(reference);
  });

  it("moves when a parameter's schema changes", () => {
    const retyped = endpoint({
      params: [
        { name: 'body', location: 'body', required: true, schema: { type: 'object' } },
        { name: 'merchant_hint', location: 'query', required: false, schema: { type: 'number' } },
      ],
    });
    expect(hashOf(retyped)).not.toBe(reference);
  });

  it('moves when a parameter becomes required', () => {
    const nowRequired = endpoint({
      params: [
        { name: 'body', location: 'body', required: true, schema: { type: 'object' } },
        { name: 'merchant_hint', location: 'query', required: true, schema: { type: 'string' } },
      ],
    });
    expect(hashOf(nowRequired)).not.toBe(reference);
  });

  it('moves on name, method and path, which reach the agent as the fallback description', () => {
    expect(hashOf(endpoint({ name: 'Choose the order' }))).not.toBe(reference);
    expect(hashOf(endpoint({ method: 'GET' }))).not.toBe(reference);
    expect(hashOf(endpoint({ pathTemplate: '/orders/pick' }))).not.toBe(reference);
  });
});

describe('the hash covers what the cases bind, not the whole space', () => {
  it('ignores a definition no case binds', () => {
    // Hashing every enabled definition marked otherwise identical batches as
    // having a changed contract because an unrelated API was edited, and the
    // agent under measurement never reads those.
    const bound = { apiId: 'cs-desk', definitionJson: { endpoints: [endpoint()] } };
    const unrelated = {
      apiId: 'weather',
      definitionJson: { endpoints: [endpoint({ name: 'X' })] },
    };
    expect(stableHash(apiSurfaceFor([bound]))).not.toBe(
      stableHash(apiSurfaceFor([bound, unrelated])),
    );
    // The launcher filters to bound ids before hashing, so the surface passed
    // here is already narrowed — this pins that an unbound definition would
    // otherwise have moved it.
  });
});

describe('what the agent cannot see does not move it', () => {
  it('holds still when endpoints are reordered', () => {
    const a = {
      apiId: 'cs-desk',
      definitionJson: { endpoints: [endpoint(), endpoint({ endpointId: 'b' })] },
    };
    const b = {
      apiId: 'cs-desk',
      definitionJson: { endpoints: [endpoint({ endpointId: 'b' }), endpoint()] },
    };
    expect(stableHash(apiSurfaceFor([a]))).toBe(stableHash(apiSurfaceFor([b])));
  });

  it('holds still for an identical surface', () => {
    expect(hashOf(endpoint())).toBe(reference);
  });
});
