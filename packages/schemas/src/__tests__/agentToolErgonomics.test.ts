/**
 * Agent tool ergonomics: schema shape hints, input normalization, operation suggestions.
 *
 * Covers: compactShapeFromJsonSchema, normalizeAgentInput, suggestOperations.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { compactShapeFromJsonSchema } from '../catalog/validation.js';
import { normalizeAgentInput } from '../catalog/agentInputNormalizer.js';
import { suggestOperations } from '../catalog/suggestions.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';

// ============================================================================
// compactShapeFromJsonSchema
// ============================================================================

describe('compactShapeFromJsonSchema', () => {
  it('produces compact shape for a simple object schema', () => {
    const schema = z.object({
      apiId: z.string(),
      endpointId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
      timeoutMs: z.number().optional(),
    });
    const jsonSchema = toJsonSchemaSync(schema) as Record<string, unknown>;
    const shape = compactShapeFromJsonSchema(jsonSchema);
    expect(shape).toContain('apiId: string');
    expect(shape).toContain('endpointId?: string');
    expect(shape).toContain('timeoutMs?: number');
    expect(shape).toMatch(/^\{.*\}$/); // wrapped in braces
  });

  it('returns {} for schema without properties', () => {
    expect(compactShapeFromJsonSchema({})).toBe('{}');
  });

  it('renders discriminated-union fields by discriminator values, never "object | object"', () => {
    // "ops: object | object | …" ×23 (e.g. for learner.propose's op union)
    // is useless for self-correction.
    const schema = z.object({
      ops: z.array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('update_task_goal'), taskId: z.string() }),
          z.object({ op: z.literal('add_task'), task: z.record(z.unknown()) }),
          z.object({ op: z.literal('remove_task'), taskId: z.string() }),
        ]),
      ),
    });
    const shape = compactShapeFromJsonSchema(toJsonSchemaSync(schema) as Record<string, unknown>);
    expect(shape).toContain("'update_task_goal'");
    expect(shape).toContain("'add_task'");
    expect(shape).not.toContain('object | object');
  });

  it('dedupes identical union branch labels', () => {
    const shape = compactShapeFromJsonSchema({
      properties: {
        value: { anyOf: [{ type: 'object' }, { type: 'object' }, { type: 'string' }] },
      },
    });
    expect(shape).toBe('{ value?: object | string }');
  });

  it('marks required fields without ? and optional fields with ?', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const jsonSchema = toJsonSchemaSync(schema) as Record<string, unknown>;
    const shape = compactShapeFromJsonSchema(jsonSchema);
    expect(shape).toContain('required: string');
    expect(shape).toContain('optional?: string');
    // required field should NOT have ?
    expect(shape).not.toMatch(/required\?/);
  });

  it('handles array types', () => {
    const schema = z.object({
      items: z.array(z.string()),
    });
    const jsonSchema = toJsonSchemaSync(schema) as Record<string, unknown>;
    const shape = compactShapeFromJsonSchema(jsonSchema);
    expect(shape).toContain('items: string[]');
  });

  it('handles enum types', () => {
    const schema = z.object({
      mode: z.enum(['fast', 'slow']),
    });
    const jsonSchema = toJsonSchemaSync(schema) as Record<string, unknown>;
    const shape = compactShapeFromJsonSchema(jsonSchema);
    expect(shape).toContain('mode:');
    // Zod enums produce type: "string" in JSON Schema, which is correct
    expect(shape).toContain('string');
  });

  it('truncates very wide schemas', () => {
    const fields: Record<string, z.ZodString> = {};
    for (let i = 0; i < 30; i++) {
      fields[`field_with_long_name_${String(i)}`] = z.string();
    }
    const schema = z.object(fields);
    const jsonSchema = toJsonSchemaSync(schema) as Record<string, unknown>;
    const shape = compactShapeFromJsonSchema(jsonSchema);
    expect(shape.length).toBeLessThanOrEqual(310);
    expect(shape).toContain('...');
  });
});

// ============================================================================
// normalizeAgentInput
// ============================================================================

describe('normalizeAgentInput', () => {
  const schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      name: { type: 'string' },
      nested: { type: 'object' },
    },
    required: ['enabled', 'name'],
  };

  it('coerces "true" to true for boolean fields', () => {
    const result = normalizeAgentInput({ enabled: 'true', name: 'test' }, schema);
    expect(result['enabled']).toBe(true);
  });

  it('coerces "false" to false (not true!) for boolean fields', () => {
    const result = normalizeAgentInput({ enabled: 'false', name: 'test' }, schema);
    expect(result['enabled']).toBe(false);
  });

  it('does not coerce arbitrary strings to boolean', () => {
    const result = normalizeAgentInput({ enabled: 'yes', name: 'test' }, schema);
    expect(result['enabled']).toBe('yes'); // stays as string — Zod will reject
  });

  it('coerces numeric strings for integer fields', () => {
    const result = normalizeAgentInput({ count: '42', name: 'test', enabled: true }, schema);
    expect(result['count']).toBe(42);
  });

  it('coerces numeric strings for number fields', () => {
    const result = normalizeAgentInput({ ratio: '3.14', name: 'test', enabled: true }, schema);
    expect(result['ratio']).toBe(3.14);
  });

  it('does not coerce non-numeric strings to numbers', () => {
    const result = normalizeAgentInput({ count: 'abc', name: 'test', enabled: true }, schema);
    expect(result['count']).toBe('abc');
  });

  it('wraps single value in array for array fields', () => {
    const result = normalizeAgentInput({ tags: 'single', name: 'test', enabled: true }, schema);
    expect(result['tags']).toEqual(['single']);
  });

  it('does not double-wrap arrays', () => {
    const result = normalizeAgentInput({ tags: ['a', 'b'], name: 'test', enabled: true }, schema);
    expect(result['tags']).toEqual(['a', 'b']);
  });

  it('leaves string fields untouched', () => {
    const result = normalizeAgentInput({ name: 'hello', enabled: true }, schema);
    expect(result['name']).toBe('hello');
  });

  it('does not mutate the original input', () => {
    const input = { enabled: 'true', name: 'test' };
    const original = { ...input };
    normalizeAgentInput(input, schema);
    expect(input).toEqual(original);
  });

  it('skips null and undefined values', () => {
    const result = normalizeAgentInput({ enabled: null, count: undefined, name: 'test' }, schema);
    expect(result['enabled']).toBeNull();
    expect(result['count']).toBeUndefined();
  });

  it('handles schema without properties', () => {
    const result = normalizeAgentInput({ foo: 'bar' }, { type: 'object' });
    expect(result).toEqual({ foo: 'bar' });
  });
});

// ============================================================================
// suggestOperations
// ============================================================================

describe('suggestOperations', () => {
  it('returns suggestions for matching stepType', () => {
    const suggestions = suggestOperations('api.call.execute');
    expect(suggestions.length).toBeGreaterThan(0);
    // All suggestions should start with 'api.'
    for (const s of suggestions) {
      expect(s).toMatch(/^api\./);
    }
  });

  it('returns suggestions for matching verb', () => {
    const suggestions = suggestOperations('foo.bar.get');
    // 'get' verb exists in many operations
    if (suggestions.length > 0) {
      // At least some should contain .get
      expect(suggestions.some((s) => s.endsWith('.get'))).toBe(true);
    }
  });

  it('returns empty array for completely unknown ID', () => {
    const suggestions = suggestOperations('zzz.qqq.xxx');
    expect(suggestions).toEqual([]);
  });

  it('returns at most 5 suggestions', () => {
    const suggestions = suggestOperations('memory.foo.bar');
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it('only includes agent-facing operations', () => {
    // 'ai.agent.turn' is agentTool: false — should not appear
    const suggestions = suggestOperations('ai.agent.something');
    for (const s of suggestions) {
      expect(s).not.toBe('ai.agent.turn');
    }
  });
});
