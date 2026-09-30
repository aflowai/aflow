import { describe, it, expect, vi } from 'vitest';
import {
  isStateRef,
  normalizeMangledRef,
  resolveStateRef,
  resolveOutputRef,
  resolveRefsRecursive,
  applyJsonPointer,
  StateRefError,
  TOOL_OUTPUT_INDEX_KEY,
} from '../stateRefResolver.js';
import type { PayloadRetriever, RuntimeStateVariables } from '../stateRefResolver.js';

// ============================================================================
// Helpers
// ============================================================================

function makeState(variables: Record<string, unknown>): RuntimeStateVariables {
  return { variables };
}

function inlineVar(value: unknown) {
  return { ref: { kind: 'inline', value } };
}

function refVar(payloadRef: string) {
  return { ref: { kind: 'ref', payloadRef } };
}

const noopPayloadStore: PayloadRetriever = {
  retrieve: vi.fn(async () => undefined),
};

function payloadStoreWith(data: Record<string, unknown>): PayloadRetriever {
  return {
    retrieve: vi.fn(async (ref: string) => data[ref]),
  };
}

// ============================================================================
// isStateRef
// ============================================================================

describe('isStateRef', () => {
  it('detects valid $ref object', () => {
    expect(isStateRef({ $ref: 'state.result' })).toBe(true);
  });

  it('detects $ref with pointer', () => {
    expect(isStateRef({ $ref: 'state.result/data/items/0' })).toBe(true);
  });

  it('rejects non-state $ref', () => {
    expect(isStateRef({ $ref: 'other.thing' })).toBe(false);
  });

  it('rejects object with extra keys', () => {
    expect(isStateRef({ $ref: 'state.result', extra: true })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isStateRef('state.result')).toBe(false);
    expect(isStateRef(null)).toBe(false);
    expect(isStateRef(42)).toBe(false);
    expect(isStateRef([{ $ref: 'state.result' }])).toBe(false);
  });

  it('rejects $ref with non-string value', () => {
    expect(isStateRef({ $ref: 123 })).toBe(false);
  });

  it('detects output.* $ref', () => {
    expect(isStateRef({ $ref: 'output.call_abc123' })).toBe(true);
  });

  it('detects output.* $ref with pointer', () => {
    expect(isStateRef({ $ref: 'output.call_abc123/data/items' })).toBe(true);
  });
});

// ============================================================================
// normalizeMangledRef
// ============================================================================

describe('normalizeMangledRef', () => {
  it('passes through a clean $ref object', () => {
    expect(normalizeMangledRef({ $ref: 'output.call_abc/data' })).toEqual({
      $ref: 'output.call_abc/data',
    });
  });

  it('repairs backtick-wrapped key (Gemini flash variant that caused the submit_output loop)', () => {
    expect(normalizeMangledRef({ '`$ref`': 'output.call_abc/data' })).toEqual({
      $ref: 'output.call_abc/data',
    });
  });

  it('repairs quote and guillemet wrapped keys', () => {
    expect(normalizeMangledRef({ '"$ref"': 'state.result' })).toEqual({ $ref: 'state.result' });
    expect(normalizeMangledRef({ '«$ref»': 'state.result' })).toEqual({ $ref: 'state.result' });
    expect(normalizeMangledRef({ "'$ref'": 'state.result' })).toEqual({ $ref: 'state.result' });
  });

  it('returns null when the value is not a real state./output. ref', () => {
    // Key normalizes to $ref but the value is not a ref string — leave untouched.
    expect(normalizeMangledRef({ '`$ref`': 'just some data' })).toBeNull();
  });

  it('returns null for ordinary single-key data objects', () => {
    expect(normalizeMangledRef({ price: 'output.call_abc' })).toBeNull();
    expect(normalizeMangledRef({ a$ref: 'state.result' })).toBeNull();
  });

  it('returns null for multi-key objects, arrays, and primitives', () => {
    expect(normalizeMangledRef({ $ref: 'state.result', extra: 1 })).toBeNull();
    expect(normalizeMangledRef([{ $ref: 'state.result' }])).toBeNull();
    expect(normalizeMangledRef('state.result')).toBeNull();
    expect(normalizeMangledRef(null)).toBeNull();
  });
});

// ============================================================================
// applyJsonPointer
// ============================================================================

describe('applyJsonPointer', () => {
  it('returns root for empty pointer', async () => {
    expect(await applyJsonPointer({ a: 1 }, '', 'x')).toEqual({ a: 1 });
  });

  it('resolves object key', async () => {
    expect(await applyJsonPointer({ data: { items: [1, 2] } }, '/data', 'x')).toEqual({
      items: [1, 2],
    });
  });

  it('resolves nested path', async () => {
    expect(await applyJsonPointer({ data: { items: [1, 2] } }, '/data/items/0', 'x')).toBe(1);
  });

  it('resolves array index', async () => {
    expect(await applyJsonPointer([10, 20, 30], '/1', 'x')).toBe(20);
  });

  it('handles RFC 6901 escape sequences (~0 → ~, ~1 → /)', async () => {
    const obj = { 'a/b': { 'c~d': 42 } };
    expect(await applyJsonPointer(obj, '/a~1b/c~0d', 'x')).toBe(42);
  });

  it('returns error for missing key', async () => {
    const result = await applyJsonPointer({ a: 1 }, '/foo/bar', 'result');
    expect(result).toHaveProperty('code', 'STATE_REF_POINTER_ERROR');
    expect((result as { message: string }).message).toContain("key 'foo' not found");
  });

  it('returns error for array out of bounds', async () => {
    const result = await applyJsonPointer({ items: [1, 2, 3] }, '/items/5', 'result');
    expect(result).toHaveProperty('code', 'STATE_REF_POINTER_ERROR');
    expect((result as { message: string }).message).toContain('index 5 out of bounds (length 3)');
  });

  it('rejects prototype pollution keys', async () => {
    const result = await applyJsonPointer({}, '/__proto__/polluted', 'result');
    expect(result).toHaveProperty('code', 'INPUT_REF_PROTOTYPE_POLLUTION');
    expect((result as { message: string }).message).toContain('__proto__');
  });

  it('rejects constructor key', async () => {
    const result = await applyJsonPointer({}, '/constructor', 'result');
    expect(result).toHaveProperty('code', 'INPUT_REF_PROTOTYPE_POLLUTION');
  });

  it('returns error for traversing non-object', async () => {
    const result = await applyJsonPointer({ a: 42 }, '/a/b', 'result');
    expect(result).toHaveProperty('code', 'STATE_REF_POINTER_ERROR');
    expect((result as { message: string }).message).toContain('cannot traverse number');
  });

  it('follows <field>Ref sibling (e.g., data → dataRef)', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/body.json': 'full CSV data 460KB' });
    const output = { data: 'truncated preview', dataRef: 'gs://bucket/body.json' };
    const result = await applyJsonPointer(output, '/data', 'test', ps);
    expect(result).toBe('full CSV data 460KB');
  });

  it('follows <field>Ref and applies remaining pointer', async () => {
    const ps = payloadStoreWith({
      'gs://bucket/body.json': { items: [{ name: 'Alice' }, { name: 'Bob' }] },
    });
    const output = { data: '{ truncated }', dataRef: 'gs://bucket/body.json' };
    const result = await applyJsonPointer(output, '/data/items/1/name', 'test', ps);
    expect(result).toBe('Bob');
  });

  it('returns raw data from PayloadStore without unwrapping', async () => {
    // Data is stored raw — no envelope unwrap. Objects with kind+data
    // keys are returned as-is (could be legitimate API response data).
    const ps = payloadStoreWith({
      'gs://bucket/body.json': { kind: 'user', data: { id: 1 } },
    });
    const output = { data: 'preview', dataRef: 'gs://bucket/body.json' };
    const result = await applyJsonPointer(output, '/data', 'test', ps);
    expect(result).toEqual({ kind: 'user', data: { id: 1 } });
  });

  it('follows dataRef sibling when data field is missing', async () => {
    // Compute output: data is truncated/missing, full data in dataRef (stored as plain string)
    const ps = payloadStoreWith({ 'gs://bucket/body.json': 'full stdout output' });
    const output = { exitCode: 0, dataRef: 'gs://bucket/body.json' };
    const result = await applyJsonPointer(output, '/data', 'test', ps);
    expect(result).toBe('full stdout output');
  });

  it('dereferences direct PayloadRef string values (outputFiles)', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/file.csv': 'CSV file contents' });
    const output = { outputFiles: { 'submission.csv': 'gs://bucket/file.csv' } };
    const result = await applyJsonPointer(output, '/outputFiles/submission.csv', 'test', ps);
    expect(result).toBe('CSV file contents');
  });

  it('falls back to inline value when sibling ref deref fails', async () => {
    const failStore: PayloadRetriever = {
      retrieve: vi.fn(async () => {
        throw new Error('network error');
      }),
    };
    const output = { body: 'inline preview', bodyRef: 'gs://bucket/bad.json' };
    const result = await applyJsonPointer(output, '/body', 'test', failStore);
    expect(result).toBe('inline preview');
  });

  it('works without payloadStore (backward compat)', async () => {
    const output = { body: 'inline preview', bodyRef: 'gs://bucket/body.json' };
    const result = await applyJsonPointer(output, '/body', 'test');
    expect(result).toBe('inline preview');
  });
});

// ============================================================================
// resolveStateRef
// ============================================================================

describe('resolveStateRef', () => {
  it('resolves inline variable', async () => {
    const state = makeState({ result: inlineVar({ rows: [1, 2, 3] }) });
    const resolved = await resolveStateRef('state.result', state, noopPayloadStore);
    expect(resolved).toEqual({ rows: [1, 2, 3] });
  });

  it('resolves inline variable with pointer', async () => {
    const state = makeState({ result: inlineVar({ rows: [{ a: 1 }, { a: 2 }] }) });
    const resolved = await resolveStateRef('state.result/rows/0', state, noopPayloadStore);
    expect(resolved).toEqual({ a: 1 });
  });

  it('resolves PayloadStore-backed variable', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/data.json': { big: 'data' } });
    const state = makeState({ result: refVar('gs://bucket/data.json') });
    const resolved = await resolveStateRef('state.result', state, ps);
    expect(resolved).toEqual({ big: 'data' });
  });

  it('resolves PayloadStore-backed variable with pointer', async () => {
    const ps = payloadStoreWith({
      'gs://bucket/data.json': { rows: [{ name: 'Alice' }, { name: 'Bob' }] },
    });
    const state = makeState({ result: refVar('gs://bucket/data.json') });
    const resolved = await resolveStateRef('state.result/rows/1/name', state, ps);
    expect(resolved).toBe('Bob');
  });

  it('returns error for missing variable', async () => {
    const state = makeState({});
    const result = await resolveStateRef('state.nonexistent', state, noopPayloadStore);
    expect(result).toHaveProperty('code', 'STATE_REF_NOT_FOUND');
    expect((result as { message: string }).message).toContain("'nonexistent'");
  });

  it('returns error when no runtime state', async () => {
    const result = await resolveStateRef('state.foo', undefined, noopPayloadStore);
    expect(result).toHaveProperty('code', 'STATE_REF_NOT_FOUND');
  });
});

// ============================================================================
// resolveRefsRecursive
// ============================================================================

describe('resolveRefsRecursive', () => {
  // Test 1: Object-form ref resolves correctly
  it('resolves $ref object', async () => {
    const state = makeState({ result: inlineVar({ rows: [1, 2, 3] }) });
    const input = { data: { $ref: 'state.result' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: { rows: [1, 2, 3] } });
  });

  // Test 2: Object-form ref with JSON Pointer
  it('resolves $ref with JSON Pointer', async () => {
    const state = makeState({ result: inlineVar({ rows: [{ a: 1 }, { a: 2 }] }) });
    const input = { data: { $ref: 'state.result/rows/0' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: { a: 1 } });
  });

  // Test 3: String-form ref (full replacement, preserves type)
  it('resolves ${state.*} full ref preserving type', async () => {
    const state = makeState({ result: inlineVar({ rows: [1, 2, 3] }) });
    const input = { data: '${state.result}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: { rows: [1, 2, 3] } });
  });

  // Test 4: String-form ref with pointer (interpolation)
  it('resolves ${state.*/pointer} in string interpolation', async () => {
    const state = makeState({ result: inlineVar({ summary: 'Q1 revenue up 20%' }) });
    const input = { prompt: 'Summarize: ${state.result/summary}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ prompt: 'Summarize: Q1 revenue up 20%' });
  });

  // Test 5: Missing variable fails clearly
  it('throws StateRefError for missing variable', async () => {
    const state = makeState({});
    const input = { data: { $ref: 'state.nonexistent' } };
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      StateRefError,
    );
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      "State variable 'nonexistent' not found",
    );
  });

  // Test 6: Invalid pointer fails clearly
  it('throws StateRefError for invalid pointer', async () => {
    const state = makeState({ result: inlineVar({ rows: [] }) });
    const input = { data: { $ref: 'state.result/foo/bar' } };
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      StateRefError,
    );
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      /could not be resolved in variable 'result'/,
    );
  });

  // Test 8: Large PayloadStore-backed variable
  it('resolves PayloadStore-backed variable via $ref', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/big.json': { large: 'dataset' } });
    const state = makeState({ result: refVar('gs://bucket/big.json') });
    const input = { data: { $ref: 'state.result' } };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({ data: { large: 'dataset' } });
  });

  // Test 9: Prototype pollution rejected
  it('throws on prototype pollution in pointer', async () => {
    const state = makeState({ result: inlineVar({ safe: true }) });
    const input = { data: { $ref: 'state.result/__proto__/polluted' } };
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      'Forbidden key in pointer: __proto__',
    );
  });

  // Test 10: No recursive re-parsing (data-not-magic)
  it('does NOT recursively resolve refs inside resolved values', async () => {
    const state = makeState({
      result: inlineVar({
        nested: { $ref: 'state.secret' },
        text: '${state.other}',
      }),
      secret: inlineVar('should not appear'),
      other: inlineVar('should not appear either'),
    });
    const input = { data: { $ref: 'state.result' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    // The resolved value should contain the literal $ref and ${state.*} as data
    expect(resolved).toEqual({
      data: {
        nested: { $ref: 'state.secret' },
        text: '${state.other}',
      },
    });
  });

  // Test 11: JSON Pointer escape sequences
  it('handles RFC 6901 escape sequences in $ref pointer', async () => {
    const state = makeState({ result: inlineVar({ 'a/b': { 'c~d': 42 } }) });
    const input = { data: { $ref: 'state.result/a~1b/c~0d' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: 42 });
  });

  // Test 12: Multiple refs in one input object
  it('resolves multiple refs independently', async () => {
    const state = makeState({
      x: inlineVar({ hello: 'world' }),
      y: inlineVar({ items: ['a', 'b'] }),
    });
    const input = {
      a: { $ref: 'state.x' },
      b: { $ref: 'state.y/items/1' },
      c: 'literal',
    };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({
      a: { hello: 'world' },
      b: 'b',
      c: 'literal',
    });
  });

  // Test 13: Interpolation stringifies non-string values
  it('stringifies non-string values in interpolation', async () => {
    const state = makeState({ result: inlineVar({ count: 42 }) });
    const input = { prompt: 'There are ${state.result/count} items' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ prompt: 'There are 42 items' });
  });

  it('JSON.stringifies objects in interpolation', async () => {
    const state = makeState({ result: inlineVar({ data: { a: 1 } }) });
    const input = { prompt: 'Data: ${state.result/data}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ prompt: 'Data: {"a":1}' });
  });

  // Non-state refs are passed through
  it('passes through non-state $ref objects', async () => {
    const state = makeState({});
    const input = { data: { $ref: 'other.thing' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: { $ref: 'other.thing' } });
  });

  it('passes through $ref objects with extra keys', async () => {
    const state = makeState({});
    const input = { data: { $ref: 'state.result', extra: true } };
    // Extra keys means it's not a state ref — passes through
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: { $ref: 'state.result', extra: true } });
  });

  // Nested arrays with refs
  it('resolves refs inside arrays', async () => {
    const state = makeState({ x: inlineVar(42) });
    const input = { items: [{ $ref: 'state.x' }, 'literal', { nested: { $ref: 'state.x' } }] };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ items: [42, 'literal', { nested: 42 }] });
  });

  // Full ${state.*} ref (preserve type)
  it('preserves type for full ${state.*} string ref', async () => {
    const state = makeState({ count: inlineVar(42) });
    const input = { value: '${state.count}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ value: 42 });
  });

  // Non-state ${...} refs are left alone
  it('leaves non-state ${...} refs untouched', async () => {
    const state = makeState({});
    const input = { value: '${input.field}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ value: '${input.field}' });
  });

  // ${state.*} full ref with pointer
  it('resolves ${state.*/pointer} as full ref preserving type', async () => {
    const state = makeState({ result: inlineVar({ count: 42 }) });
    const input = { value: '${state.result/count}' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ value: 42 });
  });

  // Output refs
  it('resolves output.* $ref via tool output index', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/step-abc/output': { generated: true } });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_abc123: 'gs://bucket/step-abc/output' }),
    });
    const input = { data: { $ref: 'output.call_abc123' } };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({ data: { generated: true } });
  });

  it('resolves output.* $ref with JSON Pointer', async () => {
    const ps = payloadStoreWith({
      'gs://bucket/step-abc/output': { items: [{ name: 'Alice' }, { name: 'Bob' }] },
    });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_abc123: 'gs://bucket/step-abc/output' }),
    });
    const input = { data: { $ref: 'output.call_abc123/items/1/name' } };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({ data: 'Bob' });
  });

  it('throws for missing tool output', async () => {
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({}),
    });
    const input = { data: { $ref: 'output.call_missing' } };
    await expect(resolveRefsRecursive(input, state, noopPayloadStore)).rejects.toThrow(
      StateRefError,
    );
  });

  it('resolves mangled "$ref" key (Gemini double-escape)', async () => {
    const state = makeState({ result: inlineVar({ items: [1, 2, 3] }) });
    // Gemini emits '"$ref"' with literal quote chars in the key
    const input = { data: { '"$ref"': 'state.result/items/0' } };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: 1 });
  });

  it('resolves backtick-mangled $ref key nested deep (the submit_output fileContent bug)', async () => {
    // Reproduces the Kaggle Runner failure: Gemini flash emitted the key as
    // `$ref` (backticks), which bypassed isStateRef so the raw object reached
    // schema validation as "must be string". The deep nesting mirrors
    // result.submissionPayload.fileContent.
    const ps = payloadStoreWith({ 'gs://bucket/submission': 'PassengerId,Survived\n1,0\n' });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_compute: 'gs://bucket/submission' }),
    });
    const input = {
      result: {
        submit: true,
        submissionPayload: {
          message: 'ensemble',
          fileContent: { '`$ref`': 'output.call_compute' },
        },
      },
    };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({
      result: {
        submit: true,
        submissionPayload: { message: 'ensemble', fileContent: 'PassengerId,Survived\n1,0\n' },
      },
    });
  });

  it('resolves stringified $ref object (Gemini defensive)', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/out': { items: [1, 2, 3] } });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_abc: 'gs://bucket/out' }),
    });
    // Model emitted the $ref as a string instead of a JSON object
    const input = { data: '{ "$ref": "output.call_abc/items/1" }' };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({ data: 2 });
  });

  it('resolves stringified state $ref object', async () => {
    const state = makeState({ result: inlineVar({ count: 42 }) });
    const input = { data: '{ "$ref": "state.result/count" }' };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect(resolved).toEqual({ data: 42 });
  });

  describe('a reference nested in a run input', () => {
    const commissionOutput = { patch: 'diff --git a/x b/x\n', summary: 'one file' };
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_commission: 'gs://bucket/commission' }),
    });
    const ps = payloadStoreWith({ 'gs://bucket/commission': commissionOutput });

    it('resolves in place, leaving the containing argument an object', async () => {
      const input = {
        slug: 'publish',
        inputs: { patch: { $ref: 'output.call_commission/patch' }, repository: 'aflowai/aflow' },
      };
      const resolved = await resolveRefsRecursive(input, state, ps);
      expect(resolved).toEqual({
        slug: 'publish',
        inputs: { patch: commissionOutput.patch, repository: 'aflowai/aflow' },
      });
    });

    it('resolves in place when the model stringified the containing argument', async () => {
      const input = {
        slug: 'publish',
        inputs: JSON.stringify({ patch: { $ref: 'output.call_commission/patch' } }),
      };
      const resolved = await resolveRefsRecursive(input, state, ps);
      expect(resolved).toEqual({ slug: 'publish', inputs: { patch: commissionOutput.patch } });
    });

    it('replaces the whole argument when the whole argument is the reference', async () => {
      const input = { slug: 'publish', inputs: { $ref: 'output.call_commission/patch' } };
      const resolved = await resolveRefsRecursive(input, state, ps);
      expect(resolved).toEqual({ slug: 'publish', inputs: commissionOutput.patch });
    });

    it('leaves a JSON string that holds no reference as a string', async () => {
      const input = { note: '{"$ref": "state.x", "other": 1}' };
      const resolved = await resolveRefsRecursive(input, makeState({}), noopPayloadStore);
      expect(resolved).toEqual(input);
    });
  });

  // Deep ${state.xxx} strings inside data payloads should NOT be resolved
  it('does NOT resolve ${state.xxx} strings deep inside nested data payloads', async () => {
    const state = makeState({ prompt: inlineVar('hello') });
    // Simulates agent.manage.validate input: an agent definition with ${state.xxx}
    // in step configs — these should pass through as literal data, not be resolved
    // against the current run's state.
    const input = {
      operationId: 'agent.manage.validate',
      inputs: {
        definition: {
          steps: [
            {
              stepId: 'agent',
              config: {
                prompt: '${state.userPrompt}',
                context: { ops: '${state.operations}' },
              },
            },
          ],
        },
      },
    };
    // Should NOT throw — the deep ${state.xxx} patterns are data, not refs
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    // The deep values should be preserved as-is
    const def = (resolved as Record<string, unknown>)['inputs'] as Record<string, unknown>;
    const defInner = def['definition'] as Record<string, unknown>;
    const steps = defInner['steps'] as Array<Record<string, unknown>>;
    const config = steps[0]!['config'] as Record<string, unknown>;
    expect(config['prompt']).toBe('${state.userPrompt}');
    expect((config['context'] as Record<string, unknown>)['ops']).toBe('${state.operations}');
  });

  // But $ref objects SHOULD still resolve at any depth
  it('resolves $ref objects at any nesting depth', async () => {
    const state = makeState({ data: inlineVar({ value: 42 }) });
    const input = {
      outer: {
        inner: {
          deep: {
            ref: { $ref: 'state.data/value' },
          },
        },
      },
    };
    const resolved = await resolveRefsRecursive(input, state, noopPayloadStore);
    expect((resolved as Record<string, unknown>)['outer']).toEqual({
      inner: { deep: { ref: 42 } },
    });
  });

  it('resolves $ref inside nested record values (files-like structure)', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/step-abc/output': { data: 'CSV data here' } });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_abc: 'gs://bucket/step-abc/output' }),
    });
    const input = {
      operationId: 'compute.sandbox.exec',
      inputs: {
        code: 'print("hello")',
        files: {
          '/tmp/data.csv': { $ref: 'output.call_abc/data' },
        },
      },
    };
    const resolved = await resolveRefsRecursive(input, state, ps);
    const resolvedInputs = (resolved as Record<string, unknown>)['inputs'] as Record<
      string,
      unknown
    >;
    const resolvedFiles = resolvedInputs['files'] as Record<string, unknown>;
    expect(resolvedFiles['/tmp/data.csv']).toBe('CSV data here');
  });

  it('mixes state.* and output.* refs in one object', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/out1': { score: 95 } });
    const state = makeState({
      result: inlineVar({ name: 'Test' }),
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_1: 'gs://bucket/out1' }),
    });
    const input = {
      name: { $ref: 'state.result/name' },
      score: { $ref: 'output.call_1/score' },
    };
    const resolved = await resolveRefsRecursive(input, state, ps);
    expect(resolved).toEqual({ name: 'Test', score: 95 });
  });
});

// ============================================================================
// resolveOutputRef
// ============================================================================

describe('resolveOutputRef', () => {
  it('resolves tool output from index', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/out': { data: 'hello' } });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_xyz: 'gs://bucket/out' }),
    });
    const result = await resolveOutputRef('output.call_xyz', state, ps);
    expect(result).toEqual({ data: 'hello' });
  });

  it('resolves with pointer', async () => {
    const ps = payloadStoreWith({ 'gs://bucket/out': { items: [10, 20, 30] } });
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_xyz: 'gs://bucket/out' }),
    });
    const result = await resolveOutputRef('output.call_xyz/items/2', state, ps);
    expect(result).toBe(30);
  });

  it('returns error for missing output index', async () => {
    const state = makeState({});
    const result = await resolveOutputRef('output.call_xyz', state, noopPayloadStore);
    expect(result).toHaveProperty('code', 'STATE_REF_NOT_FOUND');
  });

  it('returns error for missing tool call in index', async () => {
    const state = makeState({
      [TOOL_OUTPUT_INDEX_KEY]: inlineVar({ call_other: 'gs://ref' }),
    });
    const result = await resolveOutputRef('output.call_missing', state, noopPayloadStore);
    expect(result).toHaveProperty('code', 'STATE_REF_NOT_FOUND');
  });

  it('returns error when no runtime state', async () => {
    const result = await resolveOutputRef('output.call_xyz', undefined, noopPayloadStore);
    expect(result).toHaveProperty('code', 'STATE_REF_NOT_FOUND');
  });
});
