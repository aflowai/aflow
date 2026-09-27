/**
 * The sample a schema is proved satisfiable by.
 *
 * Conformance validates what this returns against the schema it came from, so
 * a sample outside the schema's own bounds is not a near miss — it is the gate
 * reporting a valid action as unsatisfiable and refusing to publish the applet
 * that declared it.
 */
import { describe, expect, it } from 'vitest';
import { synthesizeMinimalAppletValue, UnsatisfiableSampleError } from '../sampleValue.js';

function sample(node: Record<string, unknown>): unknown {
  return synthesizeMinimalAppletValue(node, node);
}

describe('a synthesized number lands inside every bound the schema names', () => {
  it('stays under a ceiling that sits below zero', () => {
    // Zero is the natural starting point and is outside this window entirely.
    expect(sample({ type: 'number', maximum: -1 })).toBeLessThanOrEqual(-1);
  });

  it('clears an exclusive floor without overshooting a nearby ceiling', () => {
    const value = sample({ type: 'number', exclusiveMinimum: 0, maximum: 0.5 }) as number;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0.5);
  });

  it('steps a whole integer past an exclusive floor', () => {
    expect(sample({ type: 'integer', exclusiveMinimum: 0, maximum: 30 })).toBe(1);
  });

  it('stays strictly under an exclusive ceiling', () => {
    const value = sample({ type: 'integer', minimum: 0, exclusiveMaximum: 1 }) as number;
    expect(value).toBeLessThan(1);
  });

  it('lands on a required multiple inside the window', () => {
    expect(sample({ type: 'number', multipleOf: 5, minimum: 3, maximum: 12 })).toBe(5);
  });

  it('reports a window that encloses no number as unsatisfiable', () => {
    expect(() => sample({ type: 'number', multipleOf: 5, minimum: 3, maximum: 4 })).toThrow(
      UnsatisfiableSampleError,
    );
    expect(() => sample({ type: 'integer', exclusiveMinimum: 0, maximum: 0 })).toThrow(
      UnsatisfiableSampleError,
    );
  });

  it('still answers a schema that names no bound at all', () => {
    expect(sample({ type: 'number' })).toBe(0);
    expect(sample({ type: 'integer' })).toBe(0);
  });
});
