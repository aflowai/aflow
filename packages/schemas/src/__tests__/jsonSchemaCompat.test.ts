import { describe, it, expect } from 'vitest';
import { jsonSchemaCovers, deepEqual } from '../utils/jsonSchemaCompat.js';

describe('jsonSchemaCovers — primitives', () => {
  it('identical primitive types cover', () => {
    expect(jsonSchemaCovers({ type: 'string' }, { type: 'string' }).covered).toBe(true);
  });

  it('integer covers number (integer ⊆ number)', () => {
    expect(jsonSchemaCovers({ type: 'integer' }, { type: 'number' }).covered).toBe(true);
  });

  it('number does NOT cover integer', () => {
    expect(jsonSchemaCovers({ type: 'number' }, { type: 'integer' }).covered).toBe(false);
  });

  it('string does NOT cover number', () => {
    const r = jsonSchemaCovers({ type: 'string' }, { type: 'number' });
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('number');
  });

  it('supplied type within target type-array covers', () => {
    expect(jsonSchemaCovers({ type: 'number' }, { type: ['number', 'null'] }).covered).toBe(true);
  });

  it('supplied type-array must be a subset of target type-array', () => {
    expect(
      jsonSchemaCovers({ type: ['number', 'string'] }, { type: ['number', 'null'] }).covered,
    ).toBe(false);
    expect(
      jsonSchemaCovers({ type: ['number', 'null'] }, { type: ['number', 'null'] }).covered,
    ).toBe(true);
  });

  it('format constraint: supplied must declare the same format', () => {
    expect(
      jsonSchemaCovers({ type: 'string', format: 'uuid' }, { type: 'string', format: 'uuid' })
        .covered,
    ).toBe(true);
    const r = jsonSchemaCovers({ type: 'string' }, { type: 'string', format: 'uuid' });
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('uuid');
  });

  it('uuid-format supplied covers an unformatted string target', () => {
    expect(jsonSchemaCovers({ type: 'string', format: 'uuid' }, { type: 'string' }).covered).toBe(
      true,
    );
  });
});

describe('jsonSchemaCovers — untyped target', () => {
  it('empty target accepts anything', () => {
    expect(jsonSchemaCovers({ type: 'string' }, {}).covered).toBe(true);
    expect(jsonSchemaCovers({ type: 'object', properties: {} }, {}).covered).toBe(true);
  });

  it('untyped supplied does NOT cover a constrained target', () => {
    const r = jsonSchemaCovers(
      {},
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
    );
    expect(r.covered).toBe(false);
  });
});

describe('jsonSchemaCovers — objects', () => {
  const target = {
    type: 'object',
    required: ['id', 'kind'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
    },
  };

  it('covers when every required field is present-and-required', () => {
    const supplied = {
      type: 'object',
      required: ['id', 'kind'],
      properties: { id: { type: 'string' }, kind: { type: 'string' } },
    };
    expect(jsonSchemaCovers(supplied, target).covered).toBe(true);
  });

  it('rejects when a required field is missing from supplied.required', () => {
    const supplied = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, kind: { type: 'string' } },
    };
    const r = jsonSchemaCovers(supplied, target);
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('kind');
  });

  it('rejects when a required field is absent from supplied.properties', () => {
    const supplied = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    };
    const r = jsonSchemaCovers(supplied, target);
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('kind');
  });

  it('recurses into shared properties (incompatible nested type rejects)', () => {
    const supplied = {
      type: 'object',
      required: ['id', 'kind'],
      properties: { id: { type: 'number' }, kind: { type: 'string' } },
    };
    const r = jsonSchemaCovers(supplied, target);
    expect(r.covered).toBe(false);
  });
});

describe('jsonSchemaCovers — arrays (the kind bug shape)', () => {
  const learningsTarget = {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'kind'],
      properties: { id: { type: 'string' }, kind: { type: 'string' } },
    },
  };

  it('rejects array items missing a required nested field', () => {
    const supplied = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, kind: { type: 'string' } },
      },
    };
    const r = jsonSchemaCovers(supplied, learningsTarget);
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('items');
    expect(r.gap).toContain('kind');
  });

  it('covers when array items include every required nested field', () => {
    const supplied = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind'],
        properties: { id: { type: 'string' }, kind: { type: 'string' } },
      },
    };
    expect(jsonSchemaCovers(supplied, learningsTarget).covered).toBe(true);
  });
});

describe('jsonSchemaCovers — enums (review High-1)', () => {
  const enumTarget = { type: 'string', enum: ['a', 'b', 'c'] };

  it('a bare string does NOT cover an enum target', () => {
    const r = jsonSchemaCovers({ type: 'string' }, enumTarget);
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('enum');
  });

  it('an enum subset covers', () => {
    expect(jsonSchemaCovers({ type: 'string', enum: ['a', 'b'] }, enumTarget).covered).toBe(true);
  });

  it('an enum superset does NOT cover', () => {
    expect(jsonSchemaCovers({ type: 'string', enum: ['a', 'd'] }, enumTarget).covered).toBe(false);
  });

  it('a const within the enum covers', () => {
    expect(jsonSchemaCovers({ const: 'b' }, enumTarget).covered).toBe(true);
  });

  it('a const outside the enum does NOT cover', () => {
    expect(jsonSchemaCovers({ const: 'z' }, enumTarget).covered).toBe(false);
  });
});

describe('jsonSchemaCovers — const target', () => {
  it('matching const covers', () => {
    expect(jsonSchemaCovers({ const: true }, { const: true }).covered).toBe(true);
  });
  it('mismatched const does NOT cover', () => {
    expect(jsonSchemaCovers({ const: false }, { const: true }).covered).toBe(false);
  });
});

describe('jsonSchemaCovers — combinators', () => {
  it('target anyOf: covered iff supplied covers ≥1 branch', () => {
    const target = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(jsonSchemaCovers({ type: 'number' }, target).covered).toBe(true);
    expect(jsonSchemaCovers({ type: 'boolean' }, target).covered).toBe(false);
  });

  it('identical anyOf-vs-anyOf covers (every supplied branch lands in the union)', () => {
    const u = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(jsonSchemaCovers(u, u).covered).toBe(true);
  });

  it('supplied anyOf: covered iff EVERY branch covers target', () => {
    const target = { type: 'number' };
    expect(
      jsonSchemaCovers({ anyOf: [{ type: 'integer' }, { type: 'number' }] }, target).covered,
    ).toBe(true);
    expect(
      jsonSchemaCovers({ anyOf: [{ type: 'number' }, { type: 'string' }] }, target).covered,
    ).toBe(false);
  });

  it('target allOf: covered iff supplied covers ALL branches', () => {
    const target = {
      allOf: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
      ],
    };
    const supplied = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    };
    expect(jsonSchemaCovers(supplied, target).covered).toBe(true);
    const missingB = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    expect(jsonSchemaCovers(missingB, target).covered).toBe(false);
  });

  it('supplied allOf (base ∧ invariant) covers via the base', () => {
    const supplied = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      allOf: [{ properties: { a: { minLength: 1 } } }],
    };
    const target = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    expect(jsonSchemaCovers(supplied, target).covered).toBe(true);
  });

  it('target oneOf is uncheckable (NOT treated as anyOf)', () => {
    const r = jsonSchemaCovers(
      { type: 'string' },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
    );
    expect(r.covered).toBe(false);
    expect(r.uncheckable).toBe(true);
  });

  it('target not/if/then is uncheckable', () => {
    expect(jsonSchemaCovers({ type: 'string' }, { not: { type: 'number' } }).uncheckable).toBe(
      true,
    );
  });
});

describe('jsonSchemaCovers — scalar bounds (review Finding 3)', () => {
  it('a looser string (no minLength) does NOT cover minLength', () => {
    const r = jsonSchemaCovers({ type: 'string' }, { type: 'string', minLength: 1 });
    expect(r.covered).toBe(false);
    expect(r.gap).toContain('minLength');
  });

  it('an equal-or-tighter string covers a minLength target', () => {
    expect(
      jsonSchemaCovers({ type: 'string', minLength: 1 }, { type: 'string', minLength: 1 }).covered,
    ).toBe(true);
    expect(
      jsonSchemaCovers({ type: 'string', minLength: 2 }, { type: 'string', minLength: 1 }).covered,
    ).toBe(true);
  });

  it('a looser string (no maxLength) does NOT cover maxLength', () => {
    expect(jsonSchemaCovers({ type: 'string' }, { type: 'string', maxLength: 10 }).covered).toBe(
      false,
    );
    expect(
      jsonSchemaCovers({ type: 'string', maxLength: 5 }, { type: 'string', maxLength: 10 }).covered,
    ).toBe(true);
    expect(
      jsonSchemaCovers({ type: 'string', maxLength: 20 }, { type: 'string', maxLength: 10 })
        .covered,
    ).toBe(false);
  });

  it('number range bounds are subset-checked', () => {
    expect(jsonSchemaCovers({ type: 'number' }, { type: 'number', minimum: 0 }).covered).toBe(
      false,
    );
    expect(
      jsonSchemaCovers({ type: 'number', minimum: 0 }, { type: 'number', minimum: 0 }).covered,
    ).toBe(true);
    expect(
      jsonSchemaCovers({ type: 'number', maximum: 5 }, { type: 'number', maximum: 10 }).covered,
    ).toBe(true);
    expect(
      jsonSchemaCovers({ type: 'number', maximum: 20 }, { type: 'number', maximum: 10 }).covered,
    ).toBe(false);
  });

  it('pattern requires the same declared pattern', () => {
    expect(jsonSchemaCovers({ type: 'string' }, { type: 'string', pattern: '^x' }).covered).toBe(
      false,
    );
    expect(
      jsonSchemaCovers({ type: 'string', pattern: '^x' }, { type: 'string', pattern: '^x' })
        .covered,
    ).toBe(true);
  });

  it('array minItems is subset-checked even with loose items', () => {
    const target = { type: 'array', minItems: 1, items: {} };
    expect(jsonSchemaCovers({ type: 'array', items: {} }, target).covered).toBe(false);
    expect(jsonSchemaCovers({ type: 'array', minItems: 1, items: {} }, target).covered).toBe(true);
  });

  it('array maxItems + uniqueItems are subset-checked', () => {
    expect(
      jsonSchemaCovers({ type: 'array', items: {} }, { type: 'array', maxItems: 3, items: {} })
        .covered,
    ).toBe(false);
    expect(
      jsonSchemaCovers(
        { type: 'array', items: {} },
        { type: 'array', uniqueItems: true, items: {} },
      ).covered,
    ).toBe(false);
    expect(
      jsonSchemaCovers(
        { type: 'array', uniqueItems: true, items: {} },
        { type: 'array', uniqueItems: true, items: {} },
      ).covered,
    ).toBe(true);
  });
});

describe('jsonSchemaCovers — $ref is uncheckable (review)', () => {
  it('a $ref target is flagged uncheckable, not silently covered', () => {
    const r = jsonSchemaCovers({ type: 'string' }, { $ref: '#/$defs/Foo' });
    expect(r.covered).toBe(false);
    expect(r.uncheckable).toBe(true);
  });

  it('a $ref supplied against a constrained target is uncheckable', () => {
    const r = jsonSchemaCovers({ $ref: '#/$defs/Foo' }, { type: 'object', required: ['a'] });
    expect(r.covered).toBe(false);
    expect(r.uncheckable).toBe(true);
  });

  it('an accept-all target still covers a $ref supplied', () => {
    expect(jsonSchemaCovers({ $ref: '#/$defs/Foo' }, {}).covered).toBe(true);
  });
});

describe('jsonSchemaCovers — presence-only required fields (review)', () => {
  it('a required field without a property schema is covered by presence alone', () => {
    const target = { type: 'object', required: ['r'] }; // no properties.r
    const supplied = { type: 'object', required: ['r'] };
    expect(jsonSchemaCovers(supplied, target).covered).toBe(true);
  });

  it('still demands the supplied property when the target constrains the field shape', () => {
    const target = { type: 'object', required: ['r'], properties: { r: { type: 'string' } } };
    const supplied = { type: 'object', required: ['r'] }; // no properties.r
    expect(jsonSchemaCovers(supplied, target).covered).toBe(false);
  });
});

describe('jsonSchemaCovers — exclusive vs inclusive bounds (review)', () => {
  it('exclusiveMinimum target is NOT covered by an inclusive minimum at the same value', () => {
    expect(
      jsonSchemaCovers({ type: 'number', minimum: 0 }, { type: 'number', exclusiveMinimum: 0 })
        .covered,
    ).toBe(false);
  });

  it('exclusiveMinimum target IS covered by an exclusive minimum at the same value', () => {
    expect(
      jsonSchemaCovers(
        { type: 'number', exclusiveMinimum: 0 },
        { type: 'number', exclusiveMinimum: 0 },
      ).covered,
    ).toBe(true);
  });

  it('inclusive minimum target is covered by an exclusive minimum at the same value (no false positive)', () => {
    expect(
      jsonSchemaCovers({ type: 'number', exclusiveMinimum: 5 }, { type: 'number', minimum: 5 })
        .covered,
    ).toBe(true);
  });

  it('exclusiveMaximum target is NOT covered by an inclusive maximum at the same value', () => {
    expect(
      jsonSchemaCovers({ type: 'number', maximum: 10 }, { type: 'number', exclusiveMaximum: 10 })
        .covered,
    ).toBe(false);
  });
});

describe('jsonSchemaCovers — open producer omitting a constrained property (review)', () => {
  const target = { type: 'object', properties: { p: { type: 'string' } } }; // p optional + constrained

  it('an OPEN supplied that omits the constrained property is NOT covered', () => {
    expect(jsonSchemaCovers({ type: 'object' }, target).covered).toBe(false);
  });

  it('a CLOSED supplied (additionalProperties:false) that omits it IS covered', () => {
    expect(jsonSchemaCovers({ type: 'object', additionalProperties: false }, target).covered).toBe(
      true,
    );
  });

  it('a supplied that declares the property (compatibly) IS covered', () => {
    expect(
      jsonSchemaCovers({ type: 'object', properties: { p: { type: 'string' } } }, target).covered,
    ).toBe(true);
  });
});

describe('deepEqual', () => {
  it('handles nested objects and arrays', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });
  it('is key-order insensitive for objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});
