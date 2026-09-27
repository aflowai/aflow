import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import {
  TaskTargetedInstructionsSchema,
  TaskTargetedInstructionsJsonSchema,
  StoredParentTaskInputsSchema,
  ParentInputsRecordSchema,
  WorkflowRunMetadataSchema,
  WorkflowResumeResolutionSchema,
} from './index.js';
import { WorkflowRunStartInputSchema } from '../operations/workflow.js';

describe('Plan 141 — TaskTargetedInstructionsSchema (shared)', () => {
  it('accepts the run-level string flavour', () => {
    expect(TaskTargetedInstructionsSchema.safeParse('hello').success).toBe(true);
  });

  it('accepts the task-targeted array flavour', () => {
    expect(TaskTargetedInstructionsSchema.safeParse([{ taskId: 't', text: 'hint' }]).success).toBe(
      true,
    );
  });

  it('rejects empty strings (run-level must be non-empty)', () => {
    expect(TaskTargetedInstructionsSchema.safeParse('').success).toBe(false);
  });

  it('rejects empty arrays (must have at least one targeted entry)', () => {
    expect(TaskTargetedInstructionsSchema.safeParse([]).success).toBe(false);
  });
});

describe('Plan 141 — WorkflowResumeResolutionSchema.re_execute.instructions', () => {
  it('accepts a run-level string', () => {
    const parsed = WorkflowResumeResolutionSchema.parse({
      mode: 're_execute',
      instructions: 'retry with vendor=Alpaca',
    });
    expect(parsed.mode).toBe('re_execute');
  });

  it('accepts a task-targeted array', () => {
    const parsed = WorkflowResumeResolutionSchema.parse({
      mode: 're_execute',
      instructions: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
    });
    expect(parsed.mode).toBe('re_execute');
  });

  it('rejects a malformed array (Plan 141 P2 review fix — was previously a plain string)', () => {
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 're_execute',
        instructions: [{ taskId: '', text: 'hint' }], // taskId min(1)
      }).success,
    ).toBe(false);
  });

  it('still accepts the other resolution modes', () => {
    expect(WorkflowResumeResolutionSchema.safeParse({ mode: 'acknowledge' }).success).toBe(true);
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'replace_output',
        output: { x: 1 },
      }).success,
    ).toBe(true);
  });
});

describe('Plan 141 — TaskTargetedInstructionsJsonSchema (graph-tool mirror)', () => {
  // Ajv with strict-false to mirror the validator used downstream by the
  // graph-tool runtime (which accepts JSON Schema typeSchemas rendered
  // from the platform-artifact registry).
  const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
  const ajv = new (AjvCtor as new (opts?: Record<string, unknown>) => Ajv)({
    allErrors: true,
    strict: false,
  });
  const validate = ajv.compile(TaskTargetedInstructionsJsonSchema as Record<string, unknown>);

  it('accepts a run-level string', () => {
    expect(validate('bind Alpaca paper')).toBe(true);
  });

  it('accepts a task-targeted array', () => {
    expect(
      validate([
        { taskId: 'elicit-target', text: 'vendor=Alpaca' },
        { taskId: 'confirm-bind', text: 'baseUrl=https://paper-api.alpaca.markets' },
      ]),
    ).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validate('')).toBe(false);
  });

  it('rejects an empty array', () => {
    expect(validate([])).toBe(false);
  });

  it('rejects an array entry missing taskId', () => {
    expect(validate([{ text: 'hint' }])).toBe(false);
  });

  it('rejects an array entry missing text', () => {
    expect(validate([{ taskId: 'a' }])).toBe(false);
  });

  it('rejects additionalProperties on array entries', () => {
    expect(validate([{ taskId: 'a', text: 'hint', extra: 'nope' }])).toBe(false);
  });

  it('rejects a non-string non-array value', () => {
    expect(validate(42)).toBe(false);
    expect(validate({ taskId: 'a', text: 'hint' })).toBe(false);
  });
});

// ============================================================================

describe('Plan 141 — StoredParentTaskInputsSchema', () => {
  it('accepts a minimal { taskId, inputs } pair', () => {
    const parsed = StoredParentTaskInputsSchema.parse({
      taskId: 'elicit-target',
      inputs: { vendor: 'Alpaca' },
    });
    expect(parsed.taskId).toBe('elicit-target');
    expect(parsed.inputs).toEqual({ vendor: 'Alpaca' });
  });

  it('accepts an empty inputs record (catch-all path with no contract)', () => {
    expect(StoredParentTaskInputsSchema.safeParse({ taskId: 'a', inputs: {} }).success).toBe(true);
  });

  it('rejects when taskId is missing', () => {
    expect(StoredParentTaskInputsSchema.safeParse({ inputs: { x: 1 } }).success).toBe(false);
  });

  it('rejects additionalProperties (strict)', () => {
    expect(
      StoredParentTaskInputsSchema.safeParse({
        taskId: 'a',
        inputs: {},
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('Plan 141 — WorkflowRunMetadataSchema (extended)', () => {
  it('accepts both parentInstructions and parentTaskInputs together', () => {
    const parsed = WorkflowRunMetadataSchema.parse({
      parentInstructions: { runLevel: 'do the thing' },
      parentTaskInputs: { taskId: 'a', inputs: { x: 1 } },
    });
    expect(parsed.parentInstructions).toBeDefined();
    expect(parsed.parentTaskInputs).toBeDefined();
  });

  it('accepts parentTaskInputs alone', () => {
    expect(
      WorkflowRunMetadataSchema.safeParse({
        parentTaskInputs: { taskId: 'a', inputs: {} },
      }).success,
    ).toBe(true);
  });
});

describe('Plan 141 — WorkflowRunStartInputSchema.inputs', () => {
  it('accepts the inputs record on top of slug', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'bind-capability',
      inputs: { vendor: 'Alpaca', paper: true },
    });
    expect(parsed.inputs).toEqual({ vendor: 'Alpaca', paper: true });
  });

  it('omits inputs when undefined', () => {
    const parsed = WorkflowRunStartInputSchema.parse({ slug: 'bind-capability' });
    expect(parsed.inputs).toBeUndefined();
  });

  it('accepts an empty inputs object (handler treats as absent)', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'bind-capability',
      inputs: {},
    });
    expect(parsed.inputs).toEqual({});
  });

  it('coexists with instructions on the same start call', () => {
    const parsed = WorkflowRunStartInputSchema.parse({
      slug: 'bind-capability',
      instructions: 'use paper baseUrl',
      inputs: { vendor: 'Alpaca' },
    });
    expect(parsed.instructions).toBe('use paper baseUrl');
    expect(parsed.inputs).toEqual({ vendor: 'Alpaca' });
  });
});

// ============================================================================

describe('Plan 141 — ParentInputsRecordSchema bounds (P2 review fix)', () => {
  it('accepts an empty record', () => {
    expect(ParentInputsRecordSchema.safeParse({}).success).toBe(true);
  });

  it('accepts up to 20 keys', () => {
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i)}`, 1]));
    expect(ParentInputsRecordSchema.safeParse(twenty).success).toBe(true);
  });

  it('rejects more than 20 keys with an actionable message', () => {
    const twentyone = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]),
    );
    const result = ParentInputsRecordSchema.safeParse(twentyone);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('20 keys');
    }
  });

  it('accepts a small serialised payload', () => {
    expect(
      ParentInputsRecordSchema.safeParse({
        vendor: 'Alpaca',
        baseUrl: 'https://paper-api.alpaca.markets',
        authKind: 'basic',
        endpoints: ['/v2/account', '/v2/orders'],
      }).success,
    ).toBe(true);
  });

  it('rejects a serialised payload over 32KB', () => {
    // Construct a payload comfortably over 32 KB but under the 20-key cap.
    const big = 'x'.repeat(40 * 1024);
    const result = ParentInputsRecordSchema.safeParse({ big });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('serialised payload');
    }
  });

  it('rejects non-serialisable values (BigInt) with the size error', () => {
    // JSON.stringify throws on BigInt; the refine catches and rejects.
    const result = ParentInputsRecordSchema.safeParse({ count: 1n });
    expect(result.success).toBe(false);
  });

  it('rejects circular references', () => {
    const a: Record<string, unknown> = { name: 'A' };
    a['self'] = a;
    const result = ParentInputsRecordSchema.safeParse({ a });
    expect(result.success).toBe(false);
  });

  // Phase 4 review fix (P2.2) — the byte-budget guard must count UTF-8
  // bytes (Buffer.byteLength), not UTF-16 code units (.length). A
  // multi-byte string just under 16384 code units but over 32 KB UTF-8
  // bytes would have passed the prior `.length` check.
  it('rejects payloads that exceed 32 KB in UTF-8 bytes (multi-byte chars count correctly)', () => {
    // 4 bytes per emoji in UTF-8, 2 UTF-16 code units per emoji. 9_000
    // emojis = 36 KB UTF-8 (over limit), 18_000 code units (well under
    // the limit if we counted `.length`).
    const bigEmoji = '🚀'.repeat(9_000);
    const result = ParentInputsRecordSchema.safeParse({ flag: bigEmoji });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('serialised payload');
    }
  });

  it('accepts payloads just under the byte cap even when their character count is also under', () => {
    // 1 KB ASCII string is 1 KB both ways — comfortably under cap.
    expect(ParentInputsRecordSchema.safeParse({ ok: 'x'.repeat(1024) }).success).toBe(true);
  });
});

describe('Plan 141 — WorkflowRunStartInputSchema.inputs picks up the bounds', () => {
  it('rejects start input with >20 inputs', () => {
    const twentyone = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]),
    );
    expect(
      WorkflowRunStartInputSchema.safeParse({
        slug: 'bind-capability',
        inputs: twentyone,
      }).success,
    ).toBe(false);
  });

  it('rejects start input with oversize serialised payload', () => {
    expect(
      WorkflowRunStartInputSchema.safeParse({
        slug: 'bind-capability',
        inputs: { big: 'x'.repeat(40 * 1024) },
      }).success,
    ).toBe(false);
  });
});

describe('Plan 141 — StoredParentTaskInputsSchema picks up the bounds', () => {
  it('rejects stored shape with >20 inputs', () => {
    const twentyone = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]),
    );
    expect(StoredParentTaskInputsSchema.safeParse({ taskId: 'a', inputs: twentyone }).success).toBe(
      false,
    );
  });
});

// ============================================================================

describe('Plan 141 — WorkflowResumeResolutionSchema.provide_input', () => {
  const runId = '00000000-0000-0000-0000-000000000001';

  it('accepts a minimal provide_input resolution', () => {
    const parsed = WorkflowResumeResolutionSchema.parse({
      mode: 'provide_input',
      taskId: 'elicit-target',
      inputs: { vendor: 'Alpaca' },
    });
    expect(parsed.mode).toBe('provide_input');
    if (parsed.mode === 'provide_input') {
      expect(parsed.taskId).toBe('elicit-target');
      expect(parsed.inputs).toEqual({ vendor: 'Alpaca' });
    }
  });

  it('rejects when taskId is missing', () => {
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'provide_input',
        inputs: { vendor: 'Alpaca' },
      }).success,
    ).toBe(false);
  });

  it('rejects empty taskId / oversized taskId', () => {
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'provide_input',
        taskId: '',
        inputs: { vendor: 'Alpaca' },
      }).success,
    ).toBe(false);
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'provide_input',
        taskId: 'x'.repeat(65),
        inputs: { vendor: 'Alpaca' },
      }).success,
    ).toBe(false);
  });

  it('rejects inputs that exceed the bounds (>20 keys)', () => {
    const twentyone = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]),
    );
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'provide_input',
        taskId: 'elicit-target',
        inputs: twentyone,
      }).success,
    ).toBe(false);
  });

  it('rejects when inputs is missing entirely', () => {
    expect(
      WorkflowResumeResolutionSchema.safeParse({
        mode: 'provide_input',
        taskId: 'elicit-target',
      }).success,
    ).toBe(false);
  });

  it('round-trips through WorkflowRunResumeInputSchema (operations side)', async () => {
    const { WorkflowRunResumeInputSchema } = await import('../operations/workflow.js');
    const parsed = WorkflowRunResumeInputSchema.parse({
      runId,
      pauseVersion: 0,
      resolution: {
        mode: 'provide_input',
        taskId: 'elicit-target',
        inputs: { vendor: 'Alpaca' },
      },
    });
    expect(parsed.resolution.mode).toBe('provide_input');
  });
});

describe('Plan 141 — ResumeResolutionModeSchema enum (extended)', () => {
  it('lists provide_input alongside replace_output / re_execute / acknowledge', async () => {
    const { ResumeResolutionModeSchema } = await import('./workflowResume.js');
    for (const mode of ['replace_output', 're_execute', 'acknowledge', 'provide_input'] as const) {
      expect(ResumeResolutionModeSchema.parse(mode)).toBe(mode);
    }
  });
});
