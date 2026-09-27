import { describe, it, expect } from 'vitest';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import {
  selectFirstTaskForParentInputs,
  validateParentTaskInputs,
  renderParentInputsValidationFailure,
  deriveFirstTaskInputContract,
} from '../parentTaskInputs.js';

function task(taskId: string, deps?: string[]): WorkflowTask {
  return {
    taskId,
    name: taskId,
    goal: 'goal',
    type: 'agent',
    ...(deps ? { dependsOn: deps } : {}),
  } as never;
}

function workflow(tasks: WorkflowTask[]): Workflow {
  return { slug: 'wf', tasks } as never;
}

describe('selectFirstTaskForParentInputs', () => {
  it('picks the unique no-dependsOn task', () => {
    const w = workflow([task('a'), task('b', ['a']), task('c', ['b'])]);
    const r = selectFirstTaskForParentInputs(w);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.taskId).toBe('a');
  });

  it('treats empty dependsOn[] the same as missing', () => {
    const w = workflow([task('a'), { ...task('b', ['a']) }]);
    const r = selectFirstTaskForParentInputs(w);
    expect(r.ok).toBe(true);
  });

  it('rejects when zero roots exist (cycle / authoring bug)', () => {
    const w = workflow([task('a', ['b']), task('b', ['a'])]);
    const r = selectFirstTaskForParentInputs(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_ROOT_TASK');
  });

  it('rejects when multiple roots exist (caller must use `instructions` instead)', () => {
    const w = workflow([task('a'), task('b'), task('c', ['a'])]);
    const r = selectFirstTaskForParentInputs(w);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('AMBIGUOUS_ROOT_TASKS');
      expect(r.rootTaskIds).toEqual(['a', 'b']);
      expect(r.message).toContain('a');
      expect(r.message).toContain('b');
    }
  });
});

describe('validateParentTaskInputs — catch-all (no inputContract)', () => {
  it('accepts arbitrary inputs verbatim when the task has no inputContract', () => {
    const t = task('a');
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca', baseUrl: 'https://x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.validatedInputs).toEqual({ vendor: 'Alpaca', baseUrl: 'https://x' });
  });

  it('accepts when inputContract has zero bindings', () => {
    const t = { ...task('a'), inputContract: { bindings: {} } } as never;
    const r = validateParentTaskInputs(t, { x: 1 });
    expect(r.ok).toBe(true);
  });
});

describe('validateParentTaskInputs — strict (inputContract declared)', () => {
  const taskWithContract = (
    bindings: Record<string, { kind: string; schema: Record<string, unknown> }>,
  ): WorkflowTask =>
    ({
      ...task('elicit-target'),
      inputContract: {
        bindings: Object.fromEntries(
          Object.entries(bindings).map(([bindAs, b]) => [
            bindAs,
            { ...b, bindAs, ...(b.kind === 'run_input' ? { path: bindAs } : { taskId: 'up' }) },
          ]),
        ),
      },
    }) as never;

  it('accepts inputs that match the binding schemas', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string', minLength: 1 } },
      paper: { kind: 'run_input', schema: { type: 'boolean' } },
    });
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca', paper: true });
    expect(r.ok).toBe(true);
  });

  it('rejects an UNKNOWN_BINDAS key not declared by the task', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string' } },
    });
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca', wat: 'unknown' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]!.code).toBe('UNKNOWN_BINDAS');
      expect(r.issues[0]!.bindAs).toBe('wat');
      expect(r.populatableBindAs).toEqual(['vendor']);
    }
  });

  it('rejects WRONG_KIND when the bindAs targets a non-run_input binding', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string' } },
      upstream: { kind: 'task_output', schema: { type: 'object' } },
    });
    // Provide vendor so we don't also trip MISSING_BINDAS — this test
    // pins the WRONG_KIND code in isolation.
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca', upstream: { something: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const wrongKind = r.issues.find((i) => i.code === 'WRONG_KIND');
      expect(wrongKind).toBeDefined();
      expect(wrongKind!.bindAs).toBe('upstream');
      expect(wrongKind!.detail).toContain('task_output');
      expect(r.populatableBindAs).toEqual(['vendor']);
    }
  });

  // Phase 4 review fix (P2.1) — required-slot enforcement. The contract
  // advertises every run_input binding as required; the validator must
  // reject partial inputs at the boundary instead of letting the Runner
  // signal_blocked again on dispatch.
  it('rejects MISSING_BINDAS when a required run_input slot is absent', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string' } },
      paper: { kind: 'run_input', schema: { type: 'boolean' } },
    });
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca' }); // paper absent
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const missing = r.issues.find((i) => i.code === 'MISSING_BINDAS');
      expect(missing).toBeDefined();
      expect(missing!.bindAs).toBe('paper');
      expect(missing!.detail).toContain('required input');
      expect(r.populatableBindAs).toEqual(['vendor', 'paper']);
    }
  });

  it('rejects MISSING_BINDAS for every absent required slot (multiple)', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string' } },
      paper: { kind: 'run_input', schema: { type: 'boolean' } },
      baseUrl: { kind: 'run_input', schema: { type: 'string' } },
    });
    const r = validateParentTaskInputs(t, {}); // all absent
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const missing = r.issues.filter((i) => i.code === 'MISSING_BINDAS').map((i) => i.bindAs);
      expect(missing.sort()).toEqual(['baseUrl', 'paper', 'vendor']);
    }
  });

  it('does NOT emit MISSING_BINDAS for non-run_input bindings (platform-filled)', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string' } },
      upstream: { kind: 'task_output', schema: { type: 'object' } }, // not parent's job
    });
    const r = validateParentTaskInputs(t, { vendor: 'Alpaca' });
    expect(r.ok).toBe(true); // no missing — upstream isn't populatable
  });

  it('rejects SCHEMA_VIOLATION when a value fails its binding schema', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string', minLength: 3 } },
    });
    const r = validateParentTaskInputs(t, { vendor: 'ab' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]!.code).toBe('SCHEMA_VIOLATION');
      expect(r.issues[0]!.bindAs).toBe('vendor');
    }
  });

  it('aggregates multiple issues across mixed failure modes', () => {
    const t = taskWithContract({
      vendor: { kind: 'run_input', schema: { type: 'string', minLength: 3 } },
      upstream: { kind: 'task_output', schema: { type: 'object' } },
    });
    const r = validateParentTaskInputs(t, {
      vendor: 'ab', // SCHEMA_VIOLATION
      upstream: {}, // WRONG_KIND
      ghost: 1, // UNKNOWN_BINDAS
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code).sort();
      expect(codes).toEqual(['SCHEMA_VIOLATION', 'UNKNOWN_BINDAS', 'WRONG_KIND']);
    }
  });
});

describe('deriveFirstTaskInputContract — Plan 141 Phase 4', () => {
  const taskWithContract = (
    bindings: Record<string, { kind: string; schema: Record<string, unknown> }>,
  ): WorkflowTask =>
    ({
      ...task('elicit-target'),
      inputContract: {
        bindings: Object.fromEntries(
          Object.entries(bindings).map(([bindAs, b]) => [
            bindAs,
            { ...b, bindAs, ...(b.kind === 'run_input' ? { path: bindAs } : { taskId: 'up' }) },
          ]),
        ),
      },
    }) as never;

  it("returns the JSON Schema for the first task's run_input bindings", () => {
    const w = workflow([
      taskWithContract({
        vendor: { kind: 'run_input', schema: { type: 'string', minLength: 1 } },
        paper: { kind: 'run_input', schema: { type: 'boolean' } },
      }),
      task('next', ['elicit-target']),
    ]);
    const contract = deriveFirstTaskInputContract(w);
    expect(contract).toEqual({
      type: 'object',
      properties: {
        vendor: { type: 'string', minLength: 1 },
        paper: { type: 'boolean' },
      },
      required: ['vendor', 'paper'],
      additionalProperties: false,
    });
  });

  it('excludes non-run_input bindings from the schema', () => {
    const w = workflow([
      taskWithContract({
        vendor: { kind: 'run_input', schema: { type: 'string' } },
        upstream: { kind: 'task_output', schema: { type: 'object' } },
        summary: { kind: 'task_summary', schema: { type: 'string' } },
      }),
    ]);
    const contract = deriveFirstTaskInputContract(w);
    expect(contract).not.toBeNull();
    const props = (contract as Record<string, unknown>)['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['vendor']);
  });

  it('returns null when the first task has no inputContract', () => {
    const w = workflow([task('a'), task('b', ['a'])]);
    expect(deriveFirstTaskInputContract(w)).toBeNull();
  });

  it('returns null when inputContract has no run_input bindings', () => {
    const w = workflow([
      taskWithContract({
        upstream: { kind: 'task_output', schema: { type: 'object' } },
      }),
    ]);
    expect(deriveFirstTaskInputContract(w)).toBeNull();
  });

  it('returns null when the workflow has zero or multiple roots (no unique entry)', () => {
    // Zero roots (cycle).
    expect(deriveFirstTaskInputContract(workflow([task('a', ['b']), task('b', ['a'])]))).toBeNull();
    // Multiple roots.
    expect(
      deriveFirstTaskInputContract(workflow([task('a'), task('b'), task('c', ['a'])])),
    ).toBeNull();
  });

  it('returned schema validates a matching payload via Ajv (round-trip check)', async () => {
    const Ajv = (await import('ajv')).default;
    const w = workflow([
      taskWithContract({
        vendor: { kind: 'run_input', schema: { type: 'string', minLength: 3 } },
      }),
    ]);
    const contract = deriveFirstTaskInputContract(w);
    expect(contract).not.toBeNull();
    const ajv = new (
      Ajv as unknown as new (opts?: Record<string, unknown>) => InstanceType<typeof Ajv>
    )({ strict: false });
    const validate = ajv.compile(contract as Record<string, unknown>);
    expect(validate({ vendor: 'Alpaca' })).toBe(true);
    expect(validate({ vendor: 'ab' })).toBe(false); // minLength: 3
    expect(validate({ vendor: 'Alpaca', wat: 1 })).toBe(false); // additionalProperties: false
    expect(validate({})).toBe(false); // required: ['vendor']
  });
});

describe('renderParentInputsValidationFailure', () => {
  it('lists each issue line and the populatable hint', () => {
    const message = renderParentInputsValidationFailure(
      'elicit-target',
      [
        {
          bindAs: 'vendor',
          code: 'SCHEMA_VIOLATION',
          detail: 'value failed the JSON Schema',
        },
      ],
      ['vendor', 'paper'],
    );
    expect(message).toContain('elicit-target');
    expect(message).toContain('vendor');
    expect(message).toContain('SCHEMA_VIOLATION');
    expect(message).toContain('Populatable input keys');
    expect(message).toContain('[vendor, paper]');
  });

  it('renders a contract-less fallback when no populatable bindAs exist', () => {
    const message = renderParentInputsValidationFailure(
      'elicit-target',
      [{ bindAs: 'x', code: 'UNKNOWN_BINDAS', detail: 'not declared' }],
      [],
    );
    expect(message).toContain('declares no run_input bindings');
    expect(message).toContain('`instructions`');
  });
});

describe('optional run inputs (runInputs[].required === false)', () => {
  // A root task that binds two run inputs: `request` (required) + `prNumber`
  // (optional, fix-mode only) — exactly the open-pr shape.
  const rootTask = {
    taskId: 'discover',
    name: 'discover',
    goal: 'g',
    type: 'agent',
    inputContract: {
      bindings: {
        request: {
          kind: 'run_input',
          bindAs: 'request',
          path: 'request',
          schema: { type: 'string' },
        },
        prNumber: {
          kind: 'run_input',
          bindAs: 'prNumber',
          path: 'prNumber',
          schema: { type: 'integer' },
        },
      },
    },
  } as never as WorkflowTask;
  const runInputs = [
    { id: 'request', required: true },
    { id: 'prNumber', required: false },
  ] as Workflow['runInputs'];
  const wf = { slug: 'wf', tasks: [rootTask], runInputs } as never as Workflow;

  it('firstTaskInputContract requires only the required slots, not the optional ones', () => {
    const contract = deriveFirstTaskInputContract(wf) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(contract.properties).sort()).toEqual(['prNumber', 'request']);
    expect(contract.required).toEqual(['request']); // prNumber omitted
  });

  it('validateParentTaskInputs accepts an omitted OPTIONAL slot', () => {
    const r = validateParentTaskInputs(rootTask, { request: 'do a thing' }, runInputs);
    expect(r.ok).toBe(true);
  });

  it('validateParentTaskInputs still rejects an omitted REQUIRED slot', () => {
    const r = validateParentTaskInputs(rootTask, { prNumber: 3 }, runInputs);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.some((i) => i.bindAs === 'request' && i.code === 'MISSING_BINDAS')).toBe(
        true,
      );
  });

  it('without runInputs, every slot is required (backward-compatible default)', () => {
    const r = validateParentTaskInputs(rootTask, { request: 'x' });
    expect(r.ok).toBe(false); // prNumber now treated as required (default)
  });
});

describe('inputBindings-only entry task (no hand-authored inputContract)', () => {
  // The literature-scan shape: the entry task declares its run inputs via
  // `inputBindings` (kind run_input) and the workflow declares `runInputs`
  // (topic required, focus optional). No `inputContract` is authored — the
  // typed surface must derive + enforce from inputBindings + runInputs directly.
  const gatherPapers = {
    taskId: 'gather-papers',
    name: 'Gather papers',
    goal: 'g',
    type: 'agent',
    inputBindings: {
      topic: { kind: 'run_input', path: 'topic' },
      focus: { kind: 'run_input', path: 'focus' },
    },
  } as never as WorkflowTask;
  const runInputs = [
    { id: 'topic', required: true, schema: { type: 'string', minLength: 1 } },
    { id: 'focus', required: false },
  ] as Workflow['runInputs'];
  const wf = { slug: 'literature-scan', tasks: [gatherPapers], runInputs } as never as Workflow;

  it('derives firstTaskInputContract from inputBindings + runInputs', () => {
    const contract = deriveFirstTaskInputContract(wf) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(contract).not.toBeNull();
    expect(Object.keys(contract.properties).sort()).toEqual(['focus', 'topic']);
    expect(contract.required).toEqual(['topic']); // focus optional
    expect(contract.properties['topic']).toEqual({ type: 'string', minLength: 1 });
    expect(contract.additionalProperties).toBe(false);
  });

  it('rejects a start that omits the required run input (topic)', () => {
    const r = validateParentTaskInputs(gatherPapers, {}, runInputs);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.bindAs === 'topic' && i.code === 'MISSING_BINDAS')).toBe(true);
      expect(r.issues.some((i) => i.bindAs === 'focus')).toBe(false); // optional
      expect(r.populatableBindAs.sort()).toEqual(['focus', 'topic']);
    }
  });

  it('accepts when the required run input is provided and optional omitted', () => {
    const r = validateParentTaskInputs(gatherPapers, { topic: 'diffusion models' }, runInputs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.validatedInputs).toEqual({ topic: 'diffusion models' });
  });

  it('validates the provided value against the runInputs schema', () => {
    const r = validateParentTaskInputs(gatherPapers, { topic: '' }, runInputs); // minLength: 1
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'SCHEMA_VIOLATION')).toBe(true);
  });

  it('rejects an unknown input key not bound by the entry task', () => {
    const r = validateParentTaskInputs(gatherPapers, { topic: 'x', bogus: 1 }, runInputs);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.some((i) => i.bindAs === 'bogus' && i.code === 'UNKNOWN_BINDAS')).toBe(true);
  });
});
