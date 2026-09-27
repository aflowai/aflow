import { describe, expect, it } from 'vitest';
import { inferDataSchemaFromData } from './dataSchemaInference.js';

describe('inferDataSchemaFromData', () => {
  it('infers nested object schemas from preview data', () => {
    const result = inferDataSchemaFromData({
      user: {
        name: 'Alice',
        age: 42,
        active: true,
      },
    });

    expect(result.provenance).toBe('data_inferred');
    expect(result.schema).toEqual({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
            active: { type: 'boolean' },
          },
          required: ['name', 'age', 'active'],
        },
      },
      required: ['user'],
    });
  });

  it('uses number (not integer) for all numeric values to avoid false AJV rejections', () => {
    const result = inferDataSchemaFromData({
      results: [
        { c: 303, t: 1770872400000 },
        { c: 303.45, t: 1770958800000 },
      ],
    });

    const items = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const itemProps = (items['results'] as Record<string, unknown>)['items'] as Record<
      string,
      unknown
    >;
    const props = (itemProps as Record<string, unknown>)['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['c']).toEqual({ type: 'number' });
    expect(props['t']).toEqual({ type: 'number' });
  });

  it('infers object arrays by merging item keys', () => {
    const result = inferDataSchemaFromData({
      points: [
        { date: '2026-03-10', close: 123.4 },
        { date: '2026-03-11', close: 124.1, volume: 999 },
      ],
    });

    expect(result.schema).toEqual({
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              close: { type: 'number' },
              volume: { type: 'number' },
            },
            required: ['date', 'close'],
          },
        },
      },
      required: ['points'],
    });
  });
});
