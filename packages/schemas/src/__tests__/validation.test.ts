import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validateStepInput,
  detectUnresolvedRefs,
  mapZodErrors,
  mapZodIssuesToFormErrors,
  stripNullsRejectedBySchema,
} from '../catalog/validation.js';
import { getOperation } from '../catalog/registry.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';

// ============================================================================
// detectUnresolvedRefs
// ============================================================================

describe('detectUnresolvedRefs', () => {
  it('returns empty array for clean input', () => {
    expect(detectUnresolvedRefs({ prompt: 'hello', count: 5 })).toEqual([]);
  });

  it('detects ${...} patterns in string values', () => {
    const result = detectUnresolvedRefs({ prompt: '${state.missing}' });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: ['prompt'],
      expression: '${state.missing}',
      message: 'Unresolved reference: ${state.missing}',
    });
  });

  it('detects embedded refs in interpolated strings', () => {
    const result = detectUnresolvedRefs({ text: 'Hello ${state.name}, welcome' });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toEqual(['text']);
  });

  it('detects refs at depth 1 (one level nested)', () => {
    // depth 0 = root object, depth 1 = inner string → within limit
    const result = detectUnresolvedRefs({
      outer: { inner: '${steps.prev.output.data}' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toEqual(['outer', 'inner']);
  });

  it('does NOT detect refs deep inside data payloads (depth >= 2)', () => {
    // This simulates an agent definition being passed to agent.manage.validate —
    // the ${state.xxx} patterns inside step configs are data, not unresolved refs.
    const result = detectUnresolvedRefs({
      definition: {
        steps: [{ config: { prompt: '${state.userPrompt}' } }],
      },
    });
    expect(result).toHaveLength(0);
  });

  it('detects refs in arrays at shallow depth', () => {
    const result = detectUnresolvedRefs({
      items: ['ok', '${state.x}', 'fine'],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toEqual(['items', 1]);
  });

  it('detects multiple unresolved refs at shallow depth', () => {
    const result = detectUnresolvedRefs({
      a: '${state.x}',
      b: '${state.y}',
    });
    expect(result).toHaveLength(2);
  });

  it('leaves a template literal alone: only a known root makes a reference', () => {
    expect(
      detectUnresolvedRefs({
        message: 'count is ${count} and ${String(total)} of ${name}',
        text: 'a `${x}` in prose',
      }),
    ).toEqual([]);
    expect(detectUnresolvedRefs({ text: '${steps.prev.output.data}' })).toHaveLength(1);
    expect(detectUnresolvedRefs({ text: '${state.name}' })).toHaveLength(1);
  });

  it('reads a patch as the diff it is, however many references its lines carry', () => {
    const patch =
      'diff --git a/x.ts b/x.ts\n+const s = `${state.name}`;\n+const t = `${steps.a.output}`;\n';
    expect(detectUnresolvedRefs({ bindingId: 'hb', patch })).toEqual([]);
    expect(detectUnresolvedRefs({ inputs: { patch, branch: 'aflow/x' } })).toEqual([]);
  });

  it("reads a workflow's run inputs as the caller's data", () => {
    expect(
      detectUnresolvedRefs({
        inputs: { note: 'see ${state.summary}', title: '${steps.x.output}' },
      }),
    ).toEqual([]);
    expect(detectUnresolvedRefs({ note: 'see ${state.summary}' })).toHaveLength(1);
  });

  it('ignores non-string, non-object values', () => {
    expect(detectUnresolvedRefs({ num: 42, bool: true, nil: null })).toEqual([]);
  });
});

// ============================================================================
// mapZodErrors
// ============================================================================

describe('mapZodErrors', () => {
  it('maps Zod issues to structured errors', () => {
    const schema = z.object({
      prompt: z.string(),
      temperature: z.number().min(0).max(2),
    });

    const result = schema.safeParse({ temperature: 5 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = mapZodErrors(result.error);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const promptError = errors.find((e) => e.path[0] === 'prompt');
    expect(promptError).toBeDefined();
    expect(promptError!.code).toBe('invalid_type');

    const tempError = errors.find((e) => e.path[0] === 'temperature');
    expect(tempError).toBeDefined();
  });

  it('names the offending keys on an unrecognized_keys issue with a custom strict message', () => {
    const schema = z
      .object({ runId: z.string(), resolution: z.object({ mode: z.string() }) })
      .strict('Allowed keys: runId, resolution.');

    const result = schema.safeParse({
      runId: 'r1',
      resolution: { mode: 'retry_failed_task' },
      wait: 'until_pause',
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = mapZodErrors(result.error);
    const keysError = errors.find((e) => e.code === 'unrecognized_keys');
    expect(keysError).toBeDefined();
    expect(keysError!.message).toBe(
      'Unknown input key(s): "wait". Allowed keys: runId, resolution.',
    );
  });

  it('does not duplicate the key list when the strict message is the Zod default', () => {
    const schema = z.object({ a: z.string() }).strict();

    const result = schema.safeParse({ a: 'x', extra: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = mapZodErrors(result.error);
    const keysError = errors.find((e) => e.code === 'unrecognized_keys');
    expect(keysError).toBeDefined();
    expect(keysError!.message).toBe('Unknown input key(s): "extra".');
  });
});

// ============================================================================
// mapZodIssuesToFormErrors
// ============================================================================

describe('mapZodIssuesToFormErrors', () => {
  it('maps issues to flat field path → message record', () => {
    const schema = z.object({
      name: z.string(),
      nested: z.object({ value: z.number() }),
    });

    const result = schema.safeParse({ nested: { value: 'not-a-number' } });
    expect(result.success).toBe(false);
    if (result.success) return;

    const formErrors = mapZodIssuesToFormErrors(result.error.issues);
    expect(formErrors['name']).toBeDefined();
    expect(formErrors['nested.value']).toBeDefined();
  });

  it('first error wins for duplicate paths', () => {
    const schema = z.object({
      value: z.string().min(5).max(3), // contradictory — will generate 2 errors on short input
    });

    const result = schema.safeParse({ value: 'ab' });
    if (!result.success) {
      const formErrors = mapZodIssuesToFormErrors(result.error.issues);
      // Should have exactly one entry for 'value'
      expect(typeof formErrors['value']).toBe('string');
    }
  });
});

// ============================================================================
// validateStepInput
// ============================================================================

describe('validateStepInput', () => {
  it('returns valid:true for unknown operations (skip validation)', () => {
    const result = validateStepInput('nonexistent.op.foo', { any: 'data' });
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ any: 'data' });
  });

  it('returns valid:true with parsed data for valid input', () => {
    // Use a known operation — ai.text.generate should exist
    const result = validateStepInput('ai.text.generate', {
      prompt: 'Hello world',
    });
    expect(result.valid).toBe(true);
    expect(result.parsed).toBeDefined();
    // parseResult.data should contain at least the prompt field
    expect((result.parsed as Record<string, unknown>)['prompt']).toBe('Hello world');
  });

  it('returns errors for invalid input', () => {
    const result = validateStepInput('ai.text.generate', {
      // temperature must be 0-2; this should fail
      temperature: 999,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errorType).toBe('INPUT_VALIDATION_ERROR');
    // Should include the path to the invalid field
    const tempError = result.errors!.find((e) => e.path.includes('temperature'));
    expect(tempError).toBeDefined();
  });

  it('detects unresolved refs before Zod validation', () => {
    const result = validateStepInput('ai.text.generate', {
      prompt: '${state.missing}',
    });
    expect(result.valid).toBe(false);
    expect(result.errorType).toBe('UNRESOLVED_INPUT_REFERENCE');
    expect(result.unresolvedRefs).toBeDefined();
    expect(result.unresolvedRefs!.length).toBe(1);
    expect(result.unresolvedRefs![0]!.expression).toBe('${state.missing}');
  });

  it('skips validation for operations with skipInputValidation flag', () => {
    // agent.control.run_step has skipInputValidation: true
    const result = validateStepInput('agent.control.run_step', {
      completely: 'arbitrary',
      data: 123,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ completely: 'arbitrary', data: 123 });
  });

  it('uses parseResult.data (Zod transforms applied)', () => {
    // Test with a known operation that has defaults
    const result = validateStepInput('ai.text.generate', {
      prompt: 'test',
    });
    expect(result.valid).toBe(true);
    // parsed should be the Zod-transformed output, not the raw input
    expect(result.parsed).toBeDefined();
  });
});

// ============================================================================
// stripNullsRejectedBySchema
// ============================================================================

describe('stripNullsRejectedBySchema', () => {
  it('strips a null the schema rejects (optional non-nullable param)', () => {
    const input: Record<string, unknown> = { prompt: 'hi', model: null };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: { prompt: { type: 'string' }, model: { type: 'string' } },
    });
    expect(input).toEqual({ prompt: 'hi' });
  });

  it('keeps a null the schema declares nullable (type array form)', () => {
    const input: Record<string, unknown> = { noopReason: null, slot: 'morning' };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        noopReason: { type: ['string', 'null'] },
        slot: { type: 'string' },
      },
    });
    expect(input).toEqual({ noopReason: null, slot: 'morning' });
  });

  it('keeps a null accepted via anyOf and via enum-with-null', () => {
    const input: Record<string, unknown> = { a: null, b: null, c: null };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        b: { enum: ['filled', 'partial', null] },
        c: { type: 'integer' },
      },
    });
    expect(input).toEqual({ a: null, b: null });
  });

  it('strips a null on an undeclared key of a typed object', () => {
    const input: Record<string, unknown> = { prompt: 'hi', invented: null };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: { prompt: { type: 'string' } },
    });
    expect(input).toEqual({ prompt: 'hi' });
  });

  it('leaves an opaque subtree untouched (unknown-typed property)', () => {
    const result = {
      status: 'no_action',
      noopReason: null,
      nested: { alsoNull: null },
    };
    const input: Record<string, unknown> = { result, summary: 'done' };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: { result: {}, summary: { type: 'string' } },
    });
    expect(input['result']).toEqual({
      status: 'no_action',
      noopReason: null,
      nested: { alsoNull: null },
    });
  });

  it('leaves a record subtree untouched (object without properties)', () => {
    const input: Record<string, unknown> = {
      params: { symbol: 'SPY', feed: null, body: { qty: null } },
    };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: { params: { type: 'object', additionalProperties: {} } },
    });
    expect(input['params']).toEqual({ symbol: 'SPY', feed: null, body: { qty: null } });
  });

  it('recurses into typed nested objects', () => {
    const input: Record<string, unknown> = {
      scope: { spaceId: 's1', flowId: null },
    };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          properties: { spaceId: { type: 'string' }, flowId: { type: 'string' } },
        },
      },
    });
    expect(input['scope']).toEqual({ spaceId: 's1' });
  });

  it('strips a rejected null nested inside a union-typed object field', () => {
    const input: Record<string, unknown> = { target: { kind: 'thesis', note: null } };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        target: {
          anyOf: [
            { type: 'object', properties: { kind: { type: 'string' }, note: { type: 'string' } } },
            { type: 'string' },
          ],
        },
      },
    });
    expect(input['target']).toEqual({ kind: 'thesis' });
  });

  it('keeps a nested null that any union object branch accepts', () => {
    const input: Record<string, unknown> = { target: { kind: 'thesis', note: null } };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        target: {
          anyOf: [
            { type: 'object', properties: { kind: { type: 'string' }, note: { type: 'string' } } },
            {
              type: 'object',
              properties: { kind: { type: 'string' }, note: { type: ['string', 'null'] } },
            },
          ],
        },
      },
    });
    expect(input['target']).toEqual({ kind: 'thesis', note: null });
  });

  it('recurses through allOf (intersection) object branches', () => {
    const input: Record<string, unknown> = { merged: { a: 1, b: null } };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        merged: {
          allOf: [
            { type: 'object', properties: { a: { type: 'number' } } },
            { type: 'object', properties: { b: { type: 'string' } } },
          ],
        },
      },
    });
    expect(input['merged']).toEqual({ a: 1 });
  });

  it('a union containing an unconstrained object branch keeps the subtree opaque', () => {
    const input: Record<string, unknown> = { payload: { keep: null } };
    stripNullsRejectedBySchema(input, {
      type: 'object',
      properties: {
        payload: {
          anyOf: [
            { type: 'object', properties: { keep: { type: 'string' } } },
            { type: 'object', additionalProperties: {} },
          ],
        },
      },
    });
    expect(input['payload']).toEqual({ keep: null });
  });

  it('a zod discriminated-union field gets null tolerance inside its branches', () => {
    const schema = toJsonSchemaSync(
      z.object({
        action: z.discriminatedUnion('op', [
          z.object({ op: z.literal('open'), reason: z.string().optional() }),
          z.object({ op: z.literal('close'), qty: z.string().nullable() }),
        ]),
      }),
    );
    const open: Record<string, unknown> = { action: { op: 'open', reason: null } };
    stripNullsRejectedBySchema(open, schema);
    expect(open['action']).toEqual({ op: 'open' });
    const close: Record<string, unknown> = { action: { op: 'close', qty: null } };
    stripNullsRejectedBySchema(close, schema);
    expect(close['action']).toEqual({ op: 'close', qty: null });
  });

  it('the live seam: draft_patch values keep their nulls through the op input schema', () => {
    // A task result reaches its contract through the draft now, so this is the
    // hop where a required null-valued field would be stripped.
    const op = getOperation('agent.control.draft_patch');
    expect(op).toBeDefined();
    const schema = toJsonSchemaSync(op!.inputZod);
    const input: Record<string, unknown> = {
      mutationId: 'm1',
      operations: [{ op: 'add', path: '', value: { proceed: false, noopReason: null } }],
    };
    stripNullsRejectedBySchema(input, schema);
    const ops = input['operations'] as Array<{ value: Record<string, unknown> }>;
    expect(ops[0]!.value['noopReason']).toBeNull();
    // ...and the op's own Zod schema still parses the preserved null.
    expect(op!.inputZod.safeParse(input).success).toBe(true);
  });
});
