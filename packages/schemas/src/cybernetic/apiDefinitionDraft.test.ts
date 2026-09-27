import { describe, it, expect } from 'vitest';
import {
  ApiDefinitionDraftSchema,
  ApiEndpointDraftBodySchema,
  ApiEndpointDraftResponseSchema,
} from './stagedChange.js';

const endpoint = { path: '/v1/things', method: 'GET' as const, endpointId: 'list_things' };

describe('ApiDefinitionDraftSchema — callMode subtype refinements', () => {
  it('accepts a valid direct_url draft (no endpoints, auth none)', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'Blob',
      baseUrl: 'https://example.com',
      authKind: 'none',
      callMode: 'direct_url',
      endpoints: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a direct_url draft that declares endpoints', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'Blob',
      baseUrl: 'https://example.com',
      authKind: 'none',
      callMode: 'direct_url',
      endpoints: [endpoint],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a direct_url draft with non-none auth', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'Blob',
      baseUrl: 'https://example.com',
      authKind: 'bearer',
      callMode: 'direct_url',
      endpoints: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an endpoint-mode draft with zero endpoints', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'API',
      baseUrl: 'https://example.com',
      authKind: 'bearer',
      endpoints: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an endpoint whose path is a full URL (signed cross-host URL anti-pattern, P2.3)', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'Kaggle',
      baseUrl: 'https://www.kaggle.com',
      authKind: 'bearer',
      endpoints: [
        { path: 'https://storage.googleapis.com/upload/{bucket}', method: 'PUT' as const },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts an endpoint-mode draft with at least one endpoint (callMode defaults to endpoint)', () => {
    const r = ApiDefinitionDraftSchema.safeParse({
      name: 'API',
      baseUrl: 'https://example.com',
      authKind: 'bearer',
      endpoints: [endpoint],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.callMode).toBe('endpoint');
  });
});

/**
 * The bind-capability path lowers a draft STRAIGHT into a stored definition —
 * no spec travels with it, and the OpenAPI importer's ref inlining never runs.
 * A `$ref` that survives authoring reaches Ajv, which refuses to compile it, so
 * every call to the endpoint fails with API_ENDPOINT_SCHEMA_INVALID.
 *
 * Catching it here turns a runtime failure nobody can act on into a
 * submit_output error the Runner can fix on its next attempt.
 */
describe('draft schemas must be self-contained', () => {
  const selfContained = { type: 'object', properties: { id: { type: 'string' } } };

  it('accepts a schema that carries its own shape', () => {
    expect(ApiEndpointDraftBodySchema.safeParse({ schema: selfContained }).success).toBe(true);
    expect(ApiEndpointDraftResponseSchema.safeParse({ schema: selfContained }).success).toBe(true);
  });

  it('accepts a recursive schema pointing at its own $defs', () => {
    const recursive = {
      type: 'object',
      properties: { child: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object' } },
    };
    expect(ApiEndpointDraftResponseSchema.safeParse({ schema: recursive }).success).toBe(true);
  });

  it('rejects a $ref into a spec the draft does not carry, and says why', () => {
    const r = ApiEndpointDraftBodySchema.safeParse({
      schema: { $ref: '#/components/schemas/Order' },
    });
    expect(r.success).toBe(false);
    const message = r.success ? '' : r.error.issues[0]!.message;
    expect(message).toContain('#/components/schemas/Order');
    expect(message).toContain('$defs');
  });

  // A `#/$defs/` prefix is a promise, not proof — `#/$defs/Missing` names
  // nothing and fails Ajv exactly like a pointer into a spec.
  it('rejects a $defs pointer whose target is not there', () => {
    const r = ApiEndpointDraftResponseSchema.safeParse({
      schema: { type: 'object', properties: { child: { $ref: '#/$defs/Missing' } } },
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]!.message).toContain('#/$defs/Missing');
  });

  // A JSON Pointer is not just a name — Ajv resolves deeper paths and escapes,
  // so rejecting them would refuse schemas that work.
  it('accepts a deeper $defs pointer and one using ~1 escapes', () => {
    const deep = ApiEndpointDraftResponseSchema.safeParse({
      schema: {
        type: 'object',
        properties: { id: { $ref: '#/$defs/Node/properties/id' } },
        $defs: { Node: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    });
    expect(deep.success).toBe(true);

    const escaped = ApiEndpointDraftResponseSchema.safeParse({
      schema: {
        type: 'object',
        properties: { x: { $ref: '#/$defs/a~1b' } },
        $defs: { 'a/b': { type: 'string' } },
      },
    });
    expect(escaped.success).toBe(true);
  });

  it('finds a nested ref, not only one at the root', () => {
    const r = ApiEndpointDraftResponseSchema.safeParse({
      schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } },
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]!.message).toContain('properties.order');
  });
});

/**
 * Self-containment is about `$ref`s; it says nothing about whether a schema is
 * VALID. `{ "type": "not-a-type" }` carries no reference and still will not
 * compile, so the draft rule alone cannot keep the from-a-brief path from
 * producing an endpoint no world can answer — the proposal-time compile guard
 * in capabilityBinding is what closes that, for responses as well as bodies.
 */
describe('self-containment is not compilability', () => {
  it('accepts a malformed-but-self-contained schema, by design', () => {
    const r = ApiEndpointDraftResponseSchema.safeParse({ schema: { type: 'not-a-type' } });
    expect(r.success).toBe(true);
  });
});
