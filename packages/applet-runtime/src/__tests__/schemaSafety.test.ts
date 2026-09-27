import {
  APPLET_SCHEMA_DIALECT,
  APPLET_SCHEMA_MAX_BYTES,
  APPLET_SCHEMA_MAX_DEPTH,
  APPLET_SCHEMA_MAX_PATTERN_LENGTH,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { AppletSchemaSafetyError } from '../errors.js';
import { assertAppletSchemaSafe } from '../schemaSafety.js';
import { validateAgainstAppletSchema } from '../schemaValidation.js';

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppletSchemaSafetyError) return err.code;
    throw err;
  }
  return 'no_error';
}

describe('assertAppletSchemaSafe', () => {
  it('accepts a bounded schema using the declared subset', () => {
    expect(() =>
      assertAppletSchemaSafe({
        $schema: APPLET_SCHEMA_DIALECT,
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 100, pattern: '^[a-z]+$' },
          tags: { type: 'array', items: { $ref: '#/$defs/tag' }, maxItems: 10 },
          state: { anyOf: [{ const: 'open' }, { const: 'closed' }] },
        },
        required: ['name'],
        additionalProperties: false,
        $defs: { tag: { type: 'string' } },
      }),
    ).not.toThrow();
  });

  it('refuses a keyword outside the declared subset', () => {
    expect(codeOf(() => assertAppletSchemaSafe({ if: { type: 'string' } }))).toBe(
      'schema_forbidden_keyword',
    );
    expect(
      codeOf(() => assertAppletSchemaSafe({ properties: { a: { unevaluatedProperties: false } } })),
    ).toBe('schema_forbidden_keyword');
  });

  it('keyword-looking property NAMES are data, not keywords', () => {
    expect(() =>
      assertAppletSchemaSafe({
        type: 'object',
        properties: { if: { type: 'string' }, pattern: { type: 'number' } },
      }),
    ).not.toThrow();
  });

  it('refuses a remote $ref and a non-string $ref', () => {
    expect(codeOf(() => assertAppletSchemaSafe({ $ref: 'https://evil.example/x.json' }))).toBe(
      'schema_remote_ref',
    );
    expect(codeOf(() => assertAppletSchemaSafe({ $ref: 42 }))).toBe('schema_remote_ref');
  });

  it('refuses a wrong dialect', () => {
    expect(
      codeOf(() => assertAppletSchemaSafe({ $schema: 'http://json-schema.org/draft-07/schema#' })),
    ).toBe('schema_wrong_dialect');
  });

  it('refuses an over-long pattern, including nested in a subschema', () => {
    const longPattern = 'a'.repeat(APPLET_SCHEMA_MAX_PATTERN_LENGTH + 1);
    expect(codeOf(() => assertAppletSchemaSafe({ pattern: longPattern }))).toBe(
      'schema_pattern_too_long',
    );
    expect(
      codeOf(() => assertAppletSchemaSafe({ items: { allOf: [{ pattern: longPattern }] } })),
    ).toBe('schema_pattern_too_long');
  });

  it('refuses an oversize schema', () => {
    expect(
      codeOf(() => assertAppletSchemaSafe({ description: 'x'.repeat(APPLET_SCHEMA_MAX_BYTES) })),
    ).toBe('schema_too_large');
  });

  it('refuses a schema nested beyond the depth cap', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < APPLET_SCHEMA_MAX_DEPTH + 1; i += 1) {
      node = { items: node };
    }
    expect(codeOf(() => assertAppletSchemaSafe(node))).toBe('schema_too_deep');
  });
});

describe('validateAgainstAppletSchema', () => {
  it('validates data and reports structural failures with paths', () => {
    const schema = {
      type: 'object',
      properties: { amount: { type: 'number', minimum: 0 } },
      required: ['amount'],
      additionalProperties: false,
    };
    const key = `test-${Math.random()}`;
    expect(validateAgainstAppletSchema({ schema, cacheKey: key, data: { amount: 3 } })).toEqual({
      valid: true,
      errors: [],
    });
    const failure = validateAgainstAppletSchema({ schema, cacheKey: key, data: { amount: -1 } });
    expect(failure.valid).toBe(false);
    expect(failure.errors.join(' ')).toContain('/amount');
  });

  it('caches by key: the second call skips re-vetting the (mutated) schema object', () => {
    const schema: Record<string, unknown> = { type: 'object' };
    const key = `cache-${Math.random()}`;
    validateAgainstAppletSchema({ schema, cacheKey: key, data: {} });
    schema['if'] = { type: 'string' };
    expect(() => validateAgainstAppletSchema({ schema, cacheKey: key, data: {} })).not.toThrow();
  });

  it('throws AppletSchemaSafetyError for an unsafe schema', () => {
    expect(() =>
      validateAgainstAppletSchema({
        schema: { $ref: 'https://evil.example/x' },
        cacheKey: `unsafe-${Math.random()}`,
        data: {},
      }),
    ).toThrowError(AppletSchemaSafetyError);
  });

  it('treats format as annotation-only — well-formedness, not domain formats', () => {
    const result = validateAgainstAppletSchema({
      schema: { type: 'string', format: 'no-such-format' },
      cacheKey: `format-${Math.random()}`,
      data: 'anything',
    });
    expect(result.valid).toBe(true);
  });
});
