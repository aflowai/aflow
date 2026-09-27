/**
 * The schema an endpoint offers the model.
 *
 * A body declared as several parameters is ordinary authoring, and it used to
 * produce a tool the provider rejected outright: each parameter overwrote the
 * last, so only one field survived, and "body" was pushed onto `required` once
 * per parameter — which draft 2020-12 forbids, since those must be unique. The
 * agent got no tools at all, and the error named the JSON Schema draft rather
 * than the endpoint.
 */
import { describe, expect, it } from 'vitest';
import { ApiEndpointSchema } from '../models/apiDefinition.js';
import { deriveEndpointToolSchema } from './integrationToolSpecs.js';

function endpoint(params: unknown[]) {
  return ApiEndpointSchema.parse({
    endpointId: 'createThing',
    name: 'Create thing',
    method: 'POST',
    pathTemplate: '/things/{id}',
    params,
  });
}

describe('deriveEndpointToolSchema — a body declared field by field', () => {
  it('gathers the fields into one body object instead of keeping the last', () => {
    const schema = deriveEndpointToolSchema(
      endpoint([
        { name: 'order_ref', location: 'body', required: true, schema: { type: 'string' } },
        { name: 'amount', location: 'body', required: true, schema: { type: 'number' } },
        { name: 'note', location: 'body', required: false, schema: { type: 'string' } },
      ]),
    );

    const body = (schema['properties'] as Record<string, Record<string, unknown>>)['body'];
    expect(Object.keys(body?.['properties'] as object)).toEqual(['order_ref', 'amount', 'note']);
    expect(body?.['required']).toEqual(['order_ref', 'amount']);
  });

  it('names the body once in `required`, because duplicates are not valid JSON Schema', () => {
    const schema = deriveEndpointToolSchema(
      endpoint([
        { name: 'a', location: 'body', required: true, schema: { type: 'string' } },
        { name: 'b', location: 'body', required: true, schema: { type: 'string' } },
        { name: 'c', location: 'body', required: true, schema: { type: 'string' } },
      ]),
    );

    expect(schema['required']).toEqual(['body']);
  });

  it('leaves the body optional when none of its fields are required', () => {
    const schema = deriveEndpointToolSchema(
      endpoint([{ name: 'note', location: 'body', required: false, schema: { type: 'string' } }]),
    );

    expect(schema['required']).toBeUndefined();
  });

  it('still takes a single object parameter as the whole body', () => {
    // The other authoring shape, unchanged: one parameter whose schema IS the
    // body rather than a field of it.
    const schema = deriveEndpointToolSchema(
      endpoint([
        {
          name: 'payload',
          location: 'body',
          required: true,
          description: 'The whole thing.',
          schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ]),
    );

    const body = (schema['properties'] as Record<string, Record<string, unknown>>)['body'];
    expect(Object.keys(body?.['properties'] as object)).toEqual(['x']);
    expect(body?.['description']).toBe('The whole thing.');
    expect(schema['required']).toEqual(['body']);
  });

  it('keeps path and query parameters alongside the body', () => {
    const schema = deriveEndpointToolSchema(
      endpoint([
        { name: 'id', location: 'path', required: true, schema: { type: 'string' } },
        { name: 'dry_run', location: 'query', required: false, schema: { type: 'boolean' } },
        { name: 'reason', location: 'body', required: true, schema: { type: 'string' } },
      ]),
    );

    expect(Object.keys(schema['properties'] as object)).toEqual(['body', 'id', 'dry_run']);
    // `required` follows the order the parameters were DECLARED in, which is
    // the contract the round-trip test pins — the body is named where its first
    // parameter sits, not hoisted because the schema assembles it first.
    expect(schema['required']).toEqual(['id', 'body']);
  });
});
