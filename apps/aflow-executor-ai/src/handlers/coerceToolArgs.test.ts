import { describe, expect, it } from 'vitest';
import { coerceStringifiedToolArgs } from './ai/handlers/coerceToolArgs.js';

/**
 * The observed failure: glm-pro sent draft_patch's `operations` as a JSON
 * string, the platform answered "arguments invalid: /operations: must be
 * array", and the model read that as the tool having failed — then re-sent the
 * opening move it had already applied. A weaker model did the same until the
 * run was failed for repeating itself.
 */
const DRAFT_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    mutationId: { type: 'string' },
    operations: { type: 'array', items: { type: 'object' } },
  },
};

const OPS = [{ op: 'add', path: '/cases/-', value: { title: 'x' } }];

describe('a structured argument sent as a JSON string', () => {
  it('is understood rather than refused', () => {
    const { args, coerced } = coerceStringifiedToolArgs(
      { mutationId: 'm1', operations: JSON.stringify(OPS) },
      DRAFT_PATCH_SCHEMA,
    );
    expect(coerced).toEqual(['operations']);
    expect(args['operations']).toEqual(OPS);
  });

  it('leaves a well-formed call untouched, returning the same object', () => {
    const original = { mutationId: 'm1', operations: OPS };
    const { args, coerced } = coerceStringifiedToolArgs(original, DRAFT_PATCH_SCHEMA);
    expect(coerced).toEqual([]);
    expect(args).toBe(original);
  });

  it('never reinterprets a string the schema actually asked for', () => {
    const { args, coerced } = coerceStringifiedToolArgs(
      { mutationId: '[1,2,3]', operations: OPS },
      DRAFT_PATCH_SCHEMA,
    );
    expect(coerced).toEqual([]);
    expect(args['mutationId']).toBe('[1,2,3]');
  });

  it('leaves a union that admits a string alone, because the intent is ambiguous', () => {
    const schema = { type: 'object', properties: { body: { type: ['string', 'object'] } } };
    const { coerced } = coerceStringifiedToolArgs({ body: '{"a":1}' }, schema);
    expect(coerced).toEqual([]);
  });

  it('does not turn a string into the wrong container', () => {
    // An object where the schema wants an array stays a string, so validation
    // still refuses it — being lenient must not mean being wrong.
    const { coerced } = coerceStringifiedToolArgs(
      { operations: '{"op":"add"}' },
      DRAFT_PATCH_SCHEMA,
    );
    expect(coerced).toEqual([]);
  });

  it('survives a string that only looks like JSON', () => {
    const { coerced } = coerceStringifiedToolArgs(
      { operations: '[not really json' },
      DRAFT_PATCH_SCHEMA,
    );
    expect(coerced).toEqual([]);
  });

  it('is inert on a schema with no properties', () => {
    const original = { operations: JSON.stringify(OPS) };
    expect(coerceStringifiedToolArgs(original, {}).args).toBe(original);
  });
});

describe('what coercion does not cover is at least recorded', () => {
  // A rejected call is never executed and its arguments are not persisted, so
  // a `/operations: must be array` seen in production twice could only be
  // reasoned about from the model's own account of it. Coercion handles the
  // stringified form; anything else must leave evidence rather than a guess.
  it('leaves a single object where an array was wanted for validation to refuse', () => {
    const { coerced } = coerceStringifiedToolArgs(
      { mutationId: 'm1', operations: { op: 'add', path: '', value: {} } as unknown as string },
      DRAFT_PATCH_SCHEMA,
    );
    expect(coerced).toEqual([]);
  });
});
