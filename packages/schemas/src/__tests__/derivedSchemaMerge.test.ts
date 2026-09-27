import { describe, expect, it } from 'vitest';
import {
  mergeDerivedPatches,
  DerivedSchemaMergeError,
  type DerivedPatch,
} from '../utils/derivedSchemaMerge.js';

const baseSchema = {
  type: 'object',
  properties: {
    workflow: {
      type: 'object',
      properties: {
        slug: { type: 'string', minLength: 3 },
      },
    },
    evalSuite: {
      type: 'object',
      properties: {
        taskCriteria: {
          type: 'object',
          additionalProperties: { type: 'array' },
        },
      },
    },
  },
} as const;

describe('mergeDerivedPatches — happy paths', () => {
  it('lands an enum patch at propertyNames.enum on a fresh leaf', () => {
    const patch: DerivedPatch = {
      bindingId: 'taskCriteria-keys',
      target: '$.evalSuite.taskCriteria.propertyNames.enum',
      kind: 'enum',
      value: ['design-skill', 'draft-evals', 'validate-and-propose'],
    };
    const { effectiveSchema, hash, pathToBindingId } = mergeDerivedPatches(baseSchema, [patch]);
    const evalSuite = (effectiveSchema as any).properties.evalSuite;
    expect(evalSuite.properties.taskCriteria.propertyNames.enum).toEqual([
      'design-skill',
      'draft-evals',
      'validate-and-propose',
    ]);
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      pathToBindingId['/properties/evalSuite/properties/taskCriteria/propertyNames/enum'],
    ).toBe('taskCriteria-keys');
  });

  it('lands a const patch at $.workflow.slug.const', () => {
    const patch: DerivedPatch = {
      bindingId: 'slug-fixed',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'compose-skill',
    };
    const { effectiveSchema, pathToBindingId } = mergeDerivedPatches(baseSchema, [patch]);
    expect((effectiveSchema as any).properties.workflow.properties.slug.const).toBe(
      'compose-skill',
    );
    expect(pathToBindingId['/properties/workflow/properties/slug/const']).toBe('slug-fixed');
  });

  it('intersects an enum patch with an existing enum (most restrictive wins)', () => {
    const baseWithEnum = {
      type: 'object',
      properties: { slug: { type: 'string', enum: ['a', 'b', 'c'] } },
    };
    const patch: DerivedPatch = {
      bindingId: 'narrow',
      target: '$.slug.enum',
      kind: 'enum',
      value: ['b', 'c', 'd'],
    };
    const { effectiveSchema } = mergeDerivedPatches(baseWithEnum, [patch]);
    expect((effectiveSchema as any).properties.slug.enum).toEqual(['b', 'c']);
  });

  it('tightens lower bound by taking the max', () => {
    const baseWithMin = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 } },
    };
    const patch: DerivedPatch = {
      bindingId: 'tighter-min',
      target: '$.count.minimum',
      kind: 'count',
      value: 5,
    };
    const { effectiveSchema } = mergeDerivedPatches(baseWithMin, [patch]);
    expect((effectiveSchema as any).properties.count.minimum).toBe(5);
  });

  it('tightens upper bound by taking the min', () => {
    const baseWithMax = {
      type: 'object',
      properties: { count: { type: 'integer', maximum: 100 } },
    };
    const patch: DerivedPatch = {
      bindingId: 'tighter-max',
      target: '$.count.maximum',
      kind: 'count',
      value: 50,
    };
    const { effectiveSchema } = mergeDerivedPatches(baseWithMax, [patch]);
    expect((effectiveSchema as any).properties.count.maximum).toBe(50);
  });

  it('lands a numeric const patch on maximum (campaign cap → upper bound)', () => {
    const baseWithSize = {
      type: 'object',
      properties: { sizePct: { type: 'number', exclusiveMinimum: 0 } },
    };
    const patch: DerivedPatch = {
      bindingId: 'position-size-cap',
      target: '$.sizePct.maximum',
      kind: 'const',
      value: 12.5,
    };
    const { effectiveSchema, pathToBindingId } = mergeDerivedPatches(baseWithSize, [patch]);
    expect((effectiveSchema as any).properties.sizePct.maximum).toBe(12.5);
    expect(pathToBindingId['/properties/sizePct/maximum']).toBe('position-size-cap');
  });

  it('lands a numeric const patch on maxItems, tightening an existing bound', () => {
    const baseWithItems = {
      type: 'object',
      properties: { theses: { type: 'array', maxItems: 10 } },
    };
    const patch: DerivedPatch = {
      bindingId: 'theses-per-day-cap',
      target: '$.theses.maxItems',
      kind: 'const',
      value: 3,
    };
    const { effectiveSchema } = mergeDerivedPatches(baseWithItems, [patch]);
    expect((effectiveSchema as any).properties.theses.maxItems).toBe(3);
  });

  it('is idempotent — merging the same patch twice yields identical hash', () => {
    const patch: DerivedPatch = {
      bindingId: 'a',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'compose-skill',
    };
    const r1 = mergeDerivedPatches(baseSchema, [patch]);
    const r2 = mergeDerivedPatches(r1.effectiveSchema, [patch]);
    expect(r1.hash).toBe(r2.hash);
  });

  it('is order-independent within the input array', () => {
    const a: DerivedPatch = {
      bindingId: 'b-second',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'compose-skill',
    };
    const b: DerivedPatch = {
      bindingId: 'a-first',
      target: '$.evalSuite.taskCriteria.propertyNames.enum',
      kind: 'enum',
      value: ['x', 'y'],
    };
    const r1 = mergeDerivedPatches(baseSchema, [a, b]);
    const r2 = mergeDerivedPatches(baseSchema, [b, a]);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.pathToBindingId).toEqual(r2.pathToBindingId);
  });
});

describe('mergeDerivedPatches — typed errors', () => {
  it('throws DERIVED_SCHEMA_EMPTY_ENUM when enum is empty and base has no enum', () => {
    const patch: DerivedPatch = {
      bindingId: 'empty',
      target: '$.evalSuite.taskCriteria.propertyNames.enum',
      kind: 'enum',
      value: [],
    };
    expect(() => mergeDerivedPatches(baseSchema, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_EMPTY_ENUM' }),
    );
  });

  it('throws DERIVED_SCHEMA_EMPTY_ENUM when enum intersection with base is empty', () => {
    const baseEnum = { type: 'object', properties: { x: { type: 'string', enum: ['a', 'b'] } } };
    const patch: DerivedPatch = {
      bindingId: 'no-overlap',
      target: '$.x.enum',
      kind: 'enum',
      value: ['c', 'd'],
    };
    expect(() => mergeDerivedPatches(baseEnum, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_EMPTY_ENUM' }),
    );
  });

  it('throws DERIVED_SCHEMA_CONFLICTING_CONST on const mismatch', () => {
    const baseConst = { type: 'object', properties: { slug: { const: 'fixed' } } };
    const patch: DerivedPatch = {
      bindingId: 'conflict',
      target: '$.slug.const',
      kind: 'const',
      value: 'different',
    };
    expect(() => mergeDerivedPatches(baseConst, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_CONFLICTING_CONST' }),
    );
  });

  it('throws DERIVED_SCHEMA_DUPLICATE_BINDING_ID on duplicate bindingIds', () => {
    const a: DerivedPatch = {
      bindingId: 'same',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'a',
    };
    const b: DerivedPatch = {
      bindingId: 'same',
      target: '$.evalSuite.taskCriteria.propertyNames.enum',
      kind: 'enum',
      value: ['x'],
    };
    expect(() => mergeDerivedPatches(baseSchema, [a, b])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_DUPLICATE_BINDING_ID' }),
    );
  });

  it('throws DERIVED_SCHEMA_UNSUPPORTED_TARGET when binding kind / leaf mismatch', () => {
    const patch: DerivedPatch = {
      bindingId: 'wrong-leaf',
      target: '$.workflow.slug.enum', // const value can't land at enum
      kind: 'const',
      value: 'compose-skill',
    };
    expect(() => mergeDerivedPatches(baseSchema, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_UNSUPPORTED_TARGET' }),
    );
  });

  it('throws DERIVED_SCHEMA_MERGE_CONFLICT when a const patch lands a non-numeric value on a bound leaf', () => {
    const patch: DerivedPatch = {
      bindingId: 'string-bound',
      target: '$.workflow.slug.minimum',
      kind: 'const',
      value: 'compose-skill',
    };
    expect(() => mergeDerivedPatches(baseSchema, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_MERGE_CONFLICT' }),
    );
  });

  it('throws DERIVED_SCHEMA_UNSUPPORTED_TARGET on wildcard segments in target', () => {
    const patch: DerivedPatch = {
      bindingId: 'wild',
      target: '$.workflow.tasks[*].taskId.const',
      kind: 'const',
      value: 'x',
    };
    expect(() => mergeDerivedPatches(baseSchema, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_UNSUPPORTED_TARGET' }),
    );
  });

  it('throws DERIVED_SCHEMA_MERGE_CONFLICT when walking into a non-object', () => {
    const baseNonObject = { type: 'object', properties: { broken: 'not-a-schema' } };
    const patch: DerivedPatch = {
      bindingId: 'conflict',
      target: '$.broken.const',
      kind: 'const',
      value: 'x',
    };
    expect(() => mergeDerivedPatches(baseNonObject, [patch])).toThrow(
      expect.objectContaining({ code: 'DERIVED_SCHEMA_MERGE_CONFLICT' }),
    );
  });
});

describe('mergeDerivedPatches — sidecar attribution', () => {
  it('emits one entry per applied patch keyed by literal schema path', () => {
    const a: DerivedPatch = {
      bindingId: 'binding-a',
      target: '$.evalSuite.taskCriteria.propertyNames.enum',
      kind: 'enum',
      value: ['x', 'y'],
    };
    const b: DerivedPatch = {
      bindingId: 'binding-b',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'fixed',
    };
    const { pathToBindingId } = mergeDerivedPatches(baseSchema, [a, b]);
    expect(pathToBindingId).toEqual({
      '/properties/evalSuite/properties/taskCriteria/propertyNames/enum': 'binding-a',
      '/properties/workflow/properties/slug/const': 'binding-b',
    });
  });

  it('uses literal segments — schema keywords not wrapped with properties', () => {
    const patch: DerivedPatch = {
      bindingId: 'b',
      target: '$.workflow.slug.const',
      kind: 'const',
      value: 'x',
    };
    const { pathToBindingId } = mergeDerivedPatches(baseSchema, [patch]);
    const keys = Object.keys(pathToBindingId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('/properties/workflow/properties/slug/const');
  });
});
