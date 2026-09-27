import { describe, it, expect } from 'vitest';
import { classify, isValid } from '../SchemaForm.js';

describe('SchemaForm.classify — supported subset', () => {
  it('classifies primitive string/number/integer/boolean schemas verbatim', () => {
    expect(classify({ type: 'string' })).toEqual({ kind: 'primitive', type: 'string' });
    expect(classify({ type: 'number' })).toEqual({ kind: 'primitive', type: 'number' });
    expect(classify({ type: 'integer' })).toEqual({ kind: 'primitive', type: 'integer' });
    expect(classify({ type: 'boolean' })).toEqual({ kind: 'primitive', type: 'boolean' });
  });

  it('classifies enum schemas regardless of declared type (enum trumps type)', () => {
    const c = classify({ type: 'string', enum: ['sales', 'returns'] });
    expect(c).toEqual({ kind: 'enum', values: ['sales', 'returns'] });
  });

  it('classifies a flat object with primitive properties', () => {
    const c = classify({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        count: { type: 'integer' },
        active: { type: 'boolean' },
      },
      required: ['name'],
    });
    expect(c.kind).toBe('object');
    if (c.kind === 'object') {
      expect(c.fields).toHaveLength(3);
      const nameField = c.fields.find((f) => f.key === 'name');
      expect(nameField?.required).toBe(true);
      expect(nameField?.description).toBe('Display name');
      expect(nameField?.classification).toEqual({ kind: 'primitive', type: 'string' });
      expect(c.fields.find((f) => f.key === 'count')?.required).toBe(false);
    }
  });

  it('classifies an array of primitives', () => {
    const c = classify({ type: 'array', items: { type: 'string' } });
    expect(c.kind).toBe('array');
    if (c.kind === 'array') {
      expect(c.itemClass).toEqual({ kind: 'primitive', type: 'string' });
    }
  });

  it('classifies an array of enum values', () => {
    const c = classify({ type: 'array', items: { enum: ['a', 'b', 'c'] } });
    expect(c.kind).toBe('array');
    if (c.kind === 'array') {
      expect(c.itemClass.kind).toBe('enum');
    }
  });
});

describe('SchemaForm.classify — fallback boundary', () => {
  // These are the cases the schema author has to know fall through
  // to raw JSON. The reasons surface to the operator so a future
  // edit that quietly changes a boundary is visible.

  it('falls back on nested objects (object inside object)', () => {
    const c = classify({
      type: 'object',
      properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } },
    });
    expect(c.kind).toBe('unsupported');
    if (c.kind === 'unsupported') {
      expect(c.reason).toMatch(/nested object/);
    }
  });

  it('falls back on nested arrays inside object', () => {
    const c = classify({
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'string' } } },
    });
    expect(c.kind).toBe('unsupported');
    if (c.kind === 'unsupported') {
      expect(c.reason).toMatch(/nested array/);
    }
  });

  it('falls back on discriminated unions (oneOf / anyOf / allOf)', () => {
    const c = classify({
      type: 'object',
      properties: { name: { type: 'string' } },
      oneOf: [{ required: ['name'] }],
    });
    expect(c.kind).toBe('unsupported');
    if (c.kind === 'unsupported') {
      expect(c.reason).toMatch(/discriminated union/);
    }
  });

  it('falls back on tuple-shaped arrays (items as array)', () => {
    const c = classify({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
    expect(c.kind).toBe('unsupported');
    if (c.kind === 'unsupported') {
      expect(c.reason).toMatch(/tuple/);
    }
  });

  it('falls back on objects with no properties (empty / opaque)', () => {
    expect(classify({ type: 'object' }).kind).toBe('unsupported');
    expect(classify({ type: 'object', properties: {} }).kind).toBe('unsupported');
  });

  it('falls back on declared-but-unrenderable types (e.g. null)', () => {
    expect(classify({ type: 'null' }).kind).toBe('unsupported');
  });
});

describe('SchemaForm.classify — typeless leaf degrades to string', () => {
  // A field the author left untyped is unknowable, but it must not drag an
  // otherwise-renderable form into the raw-JSON fallback. We render it as a
  // freeform string; server-side validation still gates the value.

  it('renders an under-specified (typeless) schema as a freeform string', () => {
    expect(classify({})).toEqual({ kind: 'primitive', type: 'string' });
    expect(classify({ description: 'optional target to aim for' })).toEqual({
      kind: 'primitive',
      type: 'string',
    });
  });

  it('renders typed fields and degrades only the typeless property (no whole-form collapse)', () => {
    const c = classify({
      type: 'object',
      properties: {
        competitionSlug: { type: 'string', description: 'Competition slug' },
        scoreMetricName: { type: 'string', description: 'Score metric' },
        scoreDirection: { type: 'string', enum: ['maximize', 'minimize'] },
        targetScore: { description: 'optional target to aim for' },
      },
      required: ['competitionSlug', 'scoreMetricName', 'scoreDirection'],
    });
    expect(c.kind).toBe('object');
    if (c.kind === 'object') {
      expect(c.fields).toHaveLength(4);
      const target = c.fields.find((f) => f.key === 'targetScore');
      expect(target?.required).toBe(false);
      expect(target?.classification).toEqual({ kind: 'primitive', type: 'string' });
      expect(c.fields.find((f) => f.key === 'scoreDirection')?.classification.kind).toBe('enum');
    }
  });
});

describe('SchemaForm.isValid — submit gating', () => {
  it('approves a populated required object', () => {
    const c = classify({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    });
    expect(isValid(c, { name: 'Karim' })).toBe(true);
    expect(isValid(c, { name: 'Karim', age: 30 })).toBe(true);
  });

  it('rejects a missing required field', () => {
    const c = classify({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(isValid(c, {})).toBe(false);
    expect(isValid(c, { name: '' })).toBe(false);
    expect(isValid(c, undefined)).toBe(false);
  });

  it('rejects a populated field that fails its type', () => {
    const c = classify({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    });
    expect(isValid(c, { count: 'not a number' })).toBe(false);
    expect(isValid(c, { count: 1.5 })).toBe(false); // integer rejects fractional
    expect(isValid(c, { count: 3 })).toBe(true);
  });

  it('treats enum membership as the validity check', () => {
    const c = classify({ enum: ['sales', 'returns', 'inventory'] });
    expect(isValid(c, 'sales')).toBe(true);
    expect(isValid(c, 'something else')).toBe(false);
    expect(isValid(c, undefined)).toBe(false);
  });

  it('approves arrays whose items all match their item class', () => {
    const c = classify({ type: 'array', items: { type: 'string' } });
    expect(isValid(c, ['a', 'b'])).toBe(true);
    expect(isValid(c, [])).toBe(true);
    expect(isValid(c, ['a', 42])).toBe(false);
  });

  it('approves parsed payloads on the fallback path; rejects empty + mid-parse strings', () => {
    // The fallback textarea (`<UnsupportedFallback>`) only flushes to
    // `onChange` when JSON.parse succeeds, so `value` is never a raw
    // mid-parse string from that code path. Validity:
    //   - `undefined` (empty textarea)                 → invalid
    //     (operator hasn't typed anything yet — sending an empty
    //     payload is almost never the intent and gives a friendlier
    //     "Submit is greyed out" affordance than a server 400)
    //   - typeof === 'string' (someone forced a string in)
    //                                                  → invalid
    //     (real schemas that expect a string classify as `primitive`,
    //     not `unsupported` — so a string here is a defect, not data)
    //   - parsed object / array / primitive            → valid
    //     (server-side validates the payload shape)
    const c = classify({ type: 'object' }); // unsupported (no properties)
    expect(isValid(c, undefined)).toBe(false);
    expect(isValid(c, 'still typing...')).toBe(false);
    expect(isValid(c, { anything: 'goes' })).toBe(true);
    expect(isValid(c, [1, 2, 3])).toBe(true);
    expect(isValid(c, 42)).toBe(true);
    expect(isValid(c, true)).toBe(true);
  });
});
