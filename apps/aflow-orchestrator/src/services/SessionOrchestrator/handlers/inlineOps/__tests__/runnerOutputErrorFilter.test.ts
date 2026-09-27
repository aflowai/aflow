import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { z } from 'zod';
import { toJsonSchemaSync } from '@aflow/schemas';

interface AjvErr {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}
interface AjvValidate {
  (data: unknown): boolean;
  errors?: AjvErr[] | null;
}
interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidate;
}
type AjvCtor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const Ajv: AjvCtor =
  (AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor);

const ajv = new Ajv({ allErrors: true, strict: false });

// The runnerOutput.ts helpers aren't exported — re-implement the surface
// minimally for the test by importing the file's filter via a dynamic
// import. Since the file co-locates the helper with the inline handler,
// expose it through a small shim.
import {
  __testing_filterAnyOfBranchErrors,
  __testing_formatAjvError,
  __testing_findUnresolvedRef,
} from '../runnerOutput.js';

const TaggedUnion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent'),
    kind: z.enum(['fetcher', 'transformer']),
    goal: z.string().min(1),
  }),
  z.object({
    type: z.literal('operation'),
    operationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('human'),
    pauseInstruction: z.string().min(1).max(500),
  }),
]);

const Wrapper = z.object({
  tasks: z.array(TaggedUnion).min(1),
});

const schema = toJsonSchemaSync(Wrapper) as Record<string, unknown>;
const validate = ajv.compile(schema);

describe('runnerOutput.ts — anyOf branch error filtering', () => {
  it('keeps only the human-branch errors when the data is clearly a human task', () => {
    const data = {
      tasks: [
        // Human task missing pauseInstruction — the relevant signal. The
        // agent and operation branches will also complain (missing kind,
        // missing operationId) but those errors don't apply because the
        // user picked human.
        { type: 'human' },
      ],
    };
    expect(validate(data)).toBe(false);
    const filtered = __testing_filterAnyOfBranchErrors(validate.errors ?? [], schema, data);

    // The surviving errors must reference fields the human branch
    // actually requires — pauseInstruction. They must NOT reference
    // `kind` (agent branch) or `operationId` (operation branch).
    const fieldsMentioned = filtered
      .map((e) => String(e.params?.['missingProperty'] ?? e.params?.['additionalProperty'] ?? ''))
      .filter(Boolean);
    expect(fieldsMentioned).toContain('pauseInstruction');
    expect(fieldsMentioned).not.toContain('kind');
    expect(fieldsMentioned).not.toContain('operationId');
    expect(fieldsMentioned).not.toContain('goal');
  });

  it('keeps only the agent-branch errors for a malformed agent task', () => {
    const data = {
      tasks: [
        // Agent task missing kind — clearly an agent (type='agent') but
        // didn't pick a kind. The operation/human branches' "missing
        // operationId / pauseInstruction" complaints would otherwise mix
        // in and confuse the runner.
        { type: 'agent', goal: 'do something' },
      ],
    };
    expect(validate(data)).toBe(false);
    const filtered = __testing_filterAnyOfBranchErrors(validate.errors ?? [], schema, data);

    const fieldsMentioned = filtered
      .map((e) => String(e.params?.['missingProperty'] ?? e.params?.['additionalProperty'] ?? ''))
      .filter(Boolean);
    expect(fieldsMentioned).toContain('kind');
    expect(fieldsMentioned).not.toContain('operationId');
    expect(fieldsMentioned).not.toContain('pauseInstruction');
  });

  it('keeps all branches when the data has no discriminator field at all', () => {
    const data = { tasks: [{}] };
    expect(validate(data)).toBe(false);
    const before = validate.errors ?? [];
    const filtered = __testing_filterAnyOfBranchErrors(before, schema, data);
    // No branch matches → don't hide anything, the runner needs full
    // signal that it forgot the discriminator entirely.
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('drops sibling-branch const errors when the failing rule lives at a deeper field', () => {
    // Live trace 2026-05-03 03:53 PM: a human task with too-long
    // pauseInstruction produced 3 errors: two `/tasks/0/type: must be
    // equal to constant` (from agent + operation branches) and one
    // `/tasks/0/pauseInstruction: must NOT have more than 500 characters`.
    // The two const errors live at `/tasks/0/type` (one segment deeper
    // than the anyOf decision at `/tasks/0`) so a naive grouping by
    // `instancePath` puts them in a separate group whose discriminator
    // lookup finds a string instead of an object — and falls through to
    // "no branch matched, keep everything." The fix is to derive the
    // anyOf decision's instance path from the schemaPath suffix and
    // group const errors with their anyOf siblings at the parent path.
    const data = {
      tasks: [{ type: 'human', pauseInstruction: 'X'.repeat(600) }],
    };
    expect(validate(data)).toBe(false);
    const filtered = __testing_filterAnyOfBranchErrors(validate.errors ?? [], schema, data);

    // No const errors should survive — they came from non-human branches.
    const constErrors = filtered.filter((e) => e.keyword === 'const');
    expect(constErrors).toHaveLength(0);

    // The pauseInstruction maxLength error from the human branch should
    // remain — that's the actual signal the runner needs.
    const remaining = filtered.map((e) => `${e.instancePath ?? ''}::${e.keyword ?? ''}`);
    expect(remaining).toContain('/tasks/0/pauseInstruction::maxLength');
  });
});

describe('runnerOutput.ts — Ajv error formatter', () => {
  it('surfaces the rejected field name on additionalProperties', () => {
    const msg = __testing_formatAjvError({
      instancePath: '/tasks/3',
      schemaPath: '#/properties/tasks/items/anyOf/2/additionalProperties',
      keyword: 'additionalProperties',
      message: 'must NOT have additional properties',
      params: { additionalProperty: 'kind' },
    });
    // Without the field name (the prior format), the runner had no way
    // to know which extra field to remove.
    expect(msg).toContain('"kind"');
    expect(msg).toContain('/tasks/3');
  });

  it('surfaces the missing field name on required', () => {
    const msg = __testing_formatAjvError({
      instancePath: '/tasks/0',
      schemaPath: '#/properties/tasks/items/anyOf/0/required',
      keyword: 'required',
      message: "must have required property 'kind'",
      params: { missingProperty: 'kind' },
    });
    expect(msg).toContain('"kind"');
    expect(msg).toContain('/tasks/0');
  });

  it('surfaces the expected literal on a const violation', () => {
    const msg = __testing_formatAjvError({
      instancePath: '/tasks/3/type',
      schemaPath: '#/properties/tasks/items/anyOf/0/properties/type/const',
      keyword: 'const',
      message: 'must be equal to constant',
      params: { allowedValue: 'agent' },
    });
    // Without the allowed value, the runner saw "must be equal to
    // constant" and had no idea WHICH constant — confounded by the fact
    // that there are several const-bound branches in the union.
    expect(msg).toContain('"agent"');
  });
});

describe('runnerOutput.ts — unresolved $ref detection for the validation hint', () => {
  it('finds a backtick-mangled ref nested deep (the submit_output fileContent failure)', () => {
    const result = {
      submit: true,
      submissionPayload: {
        message: 'ensemble',
        fileContent: { '`$ref`': 'output.call_compute/data' },
      },
    };
    expect(__testing_findUnresolvedRef(result)).toBe('output.call_compute/data');
  });

  it('finds a clean unresolved ref and walks arrays', () => {
    expect(__testing_findUnresolvedRef({ a: [{ b: { $ref: 'state.x' } }] })).toBe('state.x');
  });

  it('returns null when there is no ref-shaped value', () => {
    expect(
      __testing_findUnresolvedRef({
        submit: true,
        submissionPayload: { fileContent: 'a,b\n1,2\n' },
      }),
    ).toBeNull();
  });
});
