import { describe, it, expect } from 'vitest';
import type { ApiEndpoint } from '@aflow/schemas';
import { validateEndpointBody } from '../validateBody.js';

function ep(bodySchema: Record<string, unknown> | null, name = 'body'): ApiEndpoint {
  return {
    endpointId: 'ep',
    name: 'Endpoint',
    method: 'POST',
    pathTemplate: '/x',
    params: bodySchema ? [{ name, location: 'body', required: true, schema: bodySchema }] : [],
    tags: [],
  } as ApiEndpoint;
}

const objSchema = {
  type: 'object',
  required: ['channel'],
  properties: { channel: { type: 'string' }, text: { type: 'string' } },
  additionalProperties: false,
};

describe('validateEndpointBody', () => {
  it('passes a body that matches the schema', () => {
    expect(validateEndpointBody(ep(objSchema), { channel: 'C1', text: 'hi' })).toBeNull();
  });

  it('rejects a body missing a required field', () => {
    const err = validateEndpointBody(ep(objSchema), { text: 'hi' });
    expect(err).not.toBeNull();
    expect(err?.classification).toBe('validation');
    expect(err?.message).toContain('channel');
  });

  it('rejects a body with a wrong-typed field', () => {
    const err = validateEndpointBody(ep(objSchema), { channel: 123 });
    expect(err).not.toBeNull();
  });

  it('rejects an unknown field when additionalProperties is false', () => {
    expect(validateEndpointBody(ep(objSchema), { channel: 'C1', bogus: 1 })).not.toBeNull();
  });

  it('skips when the endpoint declares no body param', () => {
    expect(validateEndpointBody(ep(null), { anything: true })).toBeNull();
  });

  it('skips when the single body param is not named "body" (extractBody wraps it)', () => {
    expect(validateEndpointBody(ep(objSchema, 'payload'), { channel: 'C1' })).toBeNull();
  });

  it('skips an opaque string or binary body (bodySource uploads)', () => {
    expect(validateEndpointBody(ep(objSchema), 'raw-string')).toBeNull();
    expect(validateEndpointBody(ep(objSchema), new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('skips when the body is absent', () => {
    expect(validateEndpointBody(ep(objSchema), undefined)).toBeNull();
  });

  // A definition imported before OpenAPI $refs were inlined still carries one,
  // and Ajv refuses to compile it. That is a defect in the definition, not in
  // the caller's body — but letting the throw escape crashed the whole call
  // with a stack trace pointing at nothing an operator owns.
  it('reports an uncompilable schema as a DEFINITION error, not a body error', () => {
    const unresolvable = { $ref: '#/components/schemas/Order' };
    let err: { code?: string; classification?: string; message?: string } | null = null;
    expect(() => {
      err = validateEndpointBody(ep(unresolvable), { anything: true }) as typeof err;
    }).not.toThrow();
    expect(err).not.toBeNull();
    // Not VALIDATION_ERROR: the caller's body was never evaluated, and no body
    // they could send would fix it.
    expect(err!.code).toBe('API_ENDPOINT_SCHEMA_INVALID');
    expect(err!.classification).toBe('configuration');
    expect(err!.message).toContain('not valid JSON Schema');
  });
});
