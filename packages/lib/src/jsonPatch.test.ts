/**
 * Tests for the shared RFC 6902 JSON Patch applier.
 *
 * Covers:
 *   - Each of the six ops (add, remove, replace, move, copy, test).
 *   - Path escapes (~0 → ~, ~1 → /) and array indices.
 *   - Input immutability (the original doc must never be mutated).
 *   - Error classification — JsonPatchError with `kind` for malformed vs
 *     post-validation failure.
 */
import { describe, it, expect } from 'vitest';
import { applyJsonPatch, JsonPatchError } from './jsonPatch.js';

describe('applyJsonPatch - op coverage', () => {
  it('add creates a new field', () => {
    const result = applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('remove deletes a field', () => {
    const result = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }]);
    expect(result).toEqual({ a: 1 });
  });

  it('replace updates a field', () => {
    const result = applyJsonPatch({ budget: { maxRuns: 20 } }, [
      { op: 'replace', path: '/budget/maxRuns', value: 30 },
    ]);
    expect(result).toEqual({ budget: { maxRuns: 30 } });
  });

  it('move relocates a field', () => {
    const result = applyJsonPatch({ a: 1, b: 2 }, [{ op: 'move', from: '/a', path: '/c' }]);
    expect(result).toEqual({ b: 2, c: 1 });
  });

  it('copy duplicates a field', () => {
    const result = applyJsonPatch({ a: 1 }, [{ op: 'copy', from: '/a', path: '/b' }]);
    expect(result).toEqual({ a: 1, b: 1 });
  });

  it('test passes when values match', () => {
    const result = applyJsonPatch({ status: 'draft' }, [
      { op: 'test', path: '/status', value: 'draft' },
    ]);
    expect(result).toEqual({ status: 'draft' });
  });

  it('test fails when values differ', () => {
    expect(() =>
      applyJsonPatch({ status: 'draft' }, [{ op: 'test', path: '/status', value: 'approved' }]),
    ).toThrow(JsonPatchError);
  });
});

describe('applyJsonPatch - RFC 6902 path semantics', () => {
  it('handles escape characters in paths (~0 for ~, ~1 for /)', () => {
    const result = applyJsonPatch({ 'slash/key': 1, 'tilde~key': 2 }, [
      { op: 'replace', path: '/slash~1key', value: 10 },
      { op: 'replace', path: '/tilde~0key', value: 20 },
    ]);
    expect(result).toEqual({ 'slash/key': 10, 'tilde~key': 20 });
  });

  it('supports array indices', () => {
    const result = applyJsonPatch({ tasks: [{ id: 'a' }, { id: 'b' }] }, [
      { op: 'replace', path: '/tasks/0/id', value: 'z' },
    ]);
    expect(result).toEqual({ tasks: [{ id: 'z' }, { id: 'b' }] });
  });

  it('supports the `-` token to append to arrays', () => {
    const result = applyJsonPatch({ tags: ['x'] }, [{ op: 'add', path: '/tags/-', value: 'y' }]);
    expect(result).toEqual({ tags: ['x', 'y'] });
  });
});

describe('applyJsonPatch - immutability and errors', () => {
  it('does not mutate the input document', () => {
    const input = { budget: { maxRuns: 20 } };
    const snapshot = JSON.parse(JSON.stringify(input));
    applyJsonPatch(input, [{ op: 'replace', path: '/budget/maxRuns', value: 30 }]);
    expect(input).toEqual(snapshot);
  });

  it('throws JsonPatchError for unknown op', () => {
    let caught: unknown;
    try {
      applyJsonPatch(
        { a: 1 },
        // @ts-expect-error intentionally invalid op
        [{ op: 'merge', path: '/a', value: 2 }],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonPatchError);
    expect((caught as JsonPatchError).kind).toBe('invalid_op');
  });

  it('throws JsonPatchError for missing from on move/copy', () => {
    let caught: unknown;
    try {
      applyJsonPatch({ a: 1 }, [{ op: 'move', path: '/b' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonPatchError);
  });

  it('throws JsonPatchError for nonexistent path on remove', () => {
    let caught: unknown;
    try {
      applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/does-not-exist' }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonPatchError);
  });
});

describe('applyJsonPatch - typical workflow edits', () => {
  it('bumps the run budget in a workflow doc', () => {
    const workflow = {
      slug: 'my-workflow',
      status: 'approved',
      budget: { maxRuns: 20 },
      tasks: [{ id: 't1', type: 'agent' }],
    };
    const result = applyJsonPatch(workflow, [
      { op: 'replace', path: '/budget/maxRuns', value: 30 },
    ]);
    expect(result).toEqual({
      slug: 'my-workflow',
      status: 'approved',
      budget: { maxRuns: 30 },
      tasks: [{ id: 't1', type: 'agent' }],
    });
  });

  it('flips status to abandoned', () => {
    const workflow = { slug: 'my-workflow', status: 'approved' as const };
    const result = applyJsonPatch(workflow, [
      { op: 'replace', path: '/status', value: 'abandoned' },
    ]);
    expect(result).toEqual({ slug: 'my-workflow', status: 'abandoned' });
  });

  it('applies multiple ops atomically', () => {
    const workflow = {
      status: 'draft',
      budget: { maxRuns: 10 },
    };
    const result = applyJsonPatch(workflow, [
      { op: 'replace', path: '/status', value: 'approved' },
      { op: 'replace', path: '/budget/maxRuns', value: 50 },
    ]);
    expect(result).toEqual({ status: 'approved', budget: { maxRuns: 50 } });
  });
});
