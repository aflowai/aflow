import { describe, it, expect } from 'vitest';
import AjvModule from 'ajv';
import { buildCoreToolSpec } from '../coreToolSpec.js';
import { getAllOperationIds, getOperation } from '../registry.js';

/**
 * Same construction the AI executor validates tool arguments with
 * (`apps/aflow-executor-ai/src/handlers/ai/ajv.ts`). If these two ever diverge,
 * this suite stops testing the thing that actually gates a tool call.
 */
type AjvCtor = new (opts: { allErrors?: boolean; strict?: boolean }) => {
  compile(schema: Record<string, unknown>): (data: unknown) => boolean;
};
const mod = AjvModule as unknown as { default?: AjvCtor };
const Ajv: AjvCtor = mod.default ?? (AjvModule as unknown as AjvCtor);
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * A full, nested value for every collapsed field — the shape the model would
 * send if it composed the argument from `catalog.tool.list` or from memory of
 * the real schema. Each must survive validation against the COLLAPSED emission.
 */
const FULL_NESTED_ARGS: Record<string, Record<string, unknown>> = {
  'memory.store.query': {
    mode: 'search',
    query: 'anything',
    filters: {
      docType: ['markdown'],
      tagsAny: ['a'],
      updatedAfter: '2026-01-01T00:00:00Z',
      properties: { status: 'open' },
    },
    budget: { limit: 10, maxSnippetBytes: 500 },
    expand: { links: 1, direction: 'both' },
  },
  'workflow.run.resume': {
    runId: '9a3e0000-0000-4000-8000-000000000001',
    pauseVersion: 3,
    resolution: {
      mode: 'provide_input',
      taskId: 'ask-operator',
      inputs: { answer: 'yes' },
    },
  },
  'memory.store.get': {
    target: {
      path: '/x.md',
      version: 3,
      expectedContentHash: 'abc123',
    },
    view: 'content',
    lineRange: { startLine: 1, endLine: 20 },
    byteRange: { start: 0, end: 100 },
    itemRange: { start: 0, count: 10 },
  },
};

describe('agentCollapsedFields — emission narrows, acceptance does not', () => {
  const collapsed = getAllOperationIds().filter(
    (id) => getOperation(id)?.agentCollapsedFields !== undefined,
  );

  it('is in use — a passing suite over an empty set proves nothing', () => {
    expect(collapsed.length).toBeGreaterThan(0);
  });

  for (const operationId of collapsed) {
    describe(operationId, () => {
      const spec = buildCoreToolSpec(operationId);
      const schema = spec?.inputSchema as Record<string, unknown>;
      const fields = Object.keys(getOperation(operationId)?.agentCollapsedFields ?? {});

      it('emits each collapsed field as a described object with no nested shape', () => {
        const props = schema['properties'] as Record<string, Record<string, unknown>>;
        for (const field of fields) {
          expect(props[field], `${field} should still be emitted`).toBeDefined();
          expect(props[field]?.['type']).toBe('object');
          // The description is now the model's only shape information, so an
          // empty one would leave the argument genuinely unusable.
          expect(String(props[field]?.['description'] ?? '').length).toBeGreaterThan(40);
          // An object-form replacement may keep part of the shape typed (an
          // `enum` constrains generation in a way prose cannot). What must be
          // gone either way is the full nesting the collapse exists to remove.
          const emitted = JSON.stringify(props[field]);
          expect(emitted.length).toBeLessThan(900);
        }
      });

      it('still ACCEPTS the full nested value under the executor Ajv config', () => {
        const args = FULL_NESTED_ARGS[operationId];
        expect(args, `add a full-nested fixture for ${operationId}`).toBeDefined();
        expect(ajv.compile(schema)(args)).toBe(true);
      });

      it('leaves the server-side contract untouched', () => {
        // The emitted schema is a view. `inputZod` is the contract, and it must
        // still parse the same full value — that is what makes narrowing the
        // emission safe rather than a silent capability cut.
        const op = getOperation(operationId);
        expect(op?.inputZod.safeParse(FULL_NESTED_ARGS[operationId]).success).toBe(true);
      });
    });
  }
});

/**
 * `workflow.run.resume` collapses a seven-branch discriminated union, so one
 * fixture proves almost nothing — a wrapper that accidentally constrained the
 * payload would still pass on whichever branch happened to be chosen. Every
 * mode is checked, and each is validated against the COLLAPSED emission and
 * re-parsed by the real `inputZod`.
 */
describe('workflow.run.resume — every resolution mode survives the collapse', () => {
  const RUN_ID = '9a3e0000-0000-4000-8000-000000000001';
  const byMode: Array<[string, Record<string, unknown>]> = [
    ['replace_output', { mode: 'replace_output', output: { anything: true } }],
    [
      're_execute',
      {
        mode: 're_execute',
        instructions: [{ taskId: 't1', text: 'try again' }],
        remediationConfirmed: true,
      },
    ],
    ['acknowledge', { mode: 'acknowledge' }],
    ['provide_input', { mode: 'provide_input', taskId: 't1', inputs: { answer: 'yes' } }],
    ['fail', { mode: 'fail', reason: 'operator declined' }],
    ['reject', { mode: 'reject', comment: 'not now' }],
    [
      'retry_failed_task',
      {
        mode: 'retry_failed_task',
        taskId: 't1',
        failedAt: '2026-08-21T10:00:00.000Z',
        attempt: 2,
      },
    ],
  ];

  const spec = buildCoreToolSpec('workflow.run.resume');
  const validate = ajv.compile(spec?.inputSchema as Record<string, unknown>);
  const op = getOperation('workflow.run.resume');

  // This enum is the SOLE carrier of the resolution-mode set: the Helmsman
  // prompt no longer enumerates the modes, because an enum constrains
  // generation where prose only advised it. Collapsing `mode` to a plain
  // described object here would remove the set from the model's view entirely
  // with nothing failing in the prompt package.
  it('still advertises every mode as an enum — prose does not constrain generation', () => {
    const resolution = (
      spec?.inputSchema as Record<string, Record<string, Record<string, unknown>>>
    )['properties']?.['resolution'] as Record<string, Record<string, Record<string, unknown>>>;
    const modes = resolution['properties']?.['mode']?.['enum'] as string[] | undefined;
    expect(new Set(modes)).toEqual(new Set(byMode.map(([m]) => m)));
  });

  for (const [mode, resolution] of byMode) {
    it(`accepts mode "${mode}"`, () => {
      // `retry_failed_task` is the one mode that must NOT carry pauseVersion.
      const args =
        mode === 'retry_failed_task'
          ? { runId: RUN_ID, resolution }
          : { runId: RUN_ID, pauseVersion: 1, resolution };
      expect(validate(args), `collapsed emission rejected ${mode}`).toBe(true);
      expect(op?.inputZod.safeParse(args).success, `inputZod rejected ${mode}`).toBe(true);
    });
  }
});
