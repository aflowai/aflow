import { describe, expect, it } from 'vitest';
import { validateDataAgainstSchema } from './dataSchemaValidation.js';

describe('validateDataAgainstSchema', () => {
  it('accepts valid data for a simple object schema', () => {
    const result = validateDataAgainstSchema(
      {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
        required: ['user'],
      },
      { user: { name: 'Alice' } },
    );

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports invalid data clearly', () => {
    const result = validateDataAgainstSchema(
      {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                close: { type: 'number' },
              },
              required: ['close'],
            },
          },
        },
        required: ['points'],
      },
      { points: [{ close: '123' }] },
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('data_schema_validation_failed');
  });

  it('reports invalid schemas clearly', () => {
    const result = validateDataAgainstSchema(
      {
        type: 'wat',
      },
      { anything: true },
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('data_schema_invalid');
  });
});
