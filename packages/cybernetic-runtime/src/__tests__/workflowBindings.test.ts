/**
 * Tests for 104j Phase 1: inputBindings, promoteOutputs validation + resolver.
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflowGraph, patchTouchesGraph } from '../scheduling/graphValidation.js';
import {
  extractByPath,
  resolveInputBinding,
  resolveTaskInputBindings,
} from '../scheduling/workflowResolver.js';
import type { WorkflowTask, WorkflowStateVariable } from '@aflow/schemas';
import type { WorkflowRunContext, TaskOutputSnapshot } from '../scheduling/workflowResolver.js';

// ============================================================================
// Helpers
// ============================================================================

function task(
  taskId: string,
  opts?: {
    dependsOn?: string[];
    inputBindings?: WorkflowTask['inputBindings'];
    promoteOutputs?: WorkflowTask['promoteOutputs'];
    produces?: WorkflowTask['produces'];
  },
): WorkflowTask {
  return {
    taskId,
    name: `Task ${taskId}`,
    goal: `Goal for ${taskId}`,
    ...(opts?.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    ...(opts?.inputBindings ? { inputBindings: opts.inputBindings } : {}),
    ...(opts?.promoteOutputs ? { promoteOutputs: opts.promoteOutputs } : {}),
    ...(opts?.produces ? { produces: opts.produces } : {}),
  };
}

function stateVar(
  variableId: string,
  opts?: { immutable?: boolean; writers?: WorkflowStateVariable['writers'] },
): WorkflowStateVariable {
  return {
    variableId,
    name: `Var ${variableId}`,
    required: false,
    sensitive: false,
    immutable: opts?.immutable ?? false,
    ...(opts?.writers !== undefined ? { writers: opts.writers } : {}),
  };
}

// ============================================================================
// Graph validation — inputBindings
// ============================================================================

describe('validateWorkflowGraph — inputBindings', () => {
  it('accepts valid task_output binding to upstream task', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', {
        dependsOn: ['a'],
        inputBindings: {
          data: { kind: 'task_output', taskId: 'a' },
        },
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts valid task_output binding to transitively upstream task', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', {
        dependsOn: ['b'],
        inputBindings: {
          data: { kind: 'task_output', taskId: 'a' }, // transitive upstream
        },
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects task_output binding to non-existent task', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', {
        dependsOn: ['a'],
        inputBindings: {
          data: { kind: 'task_output', taskId: 'ghost' },
        },
      }),
    ]);
    expect(errors.some((e) => e.kind === 'binding_dangling_task_ref')).toBe(true);
    expect(errors[0]!.taskIds).toContain('ghost');
  });

  it('rejects task_output binding to non-upstream task', () => {
    const errors = validateWorkflowGraph([
      task('a'),
      task('b'), // parallel, not upstream of c
      task('c', {
        dependsOn: ['a'],
        inputBindings: {
          data: { kind: 'task_output', taskId: 'b' },
        },
      }),
    ]);
    expect(errors.some((e) => e.kind === 'binding_not_upstream')).toBe(true);
  });

  // ==========================================================================

  it('rejects task_output binding to a path that is not a declared produces[].key', () => {
    const errors = validateWorkflowGraph([
      task('producer', {
        produces: [
          { key: 'data', shape: { type: 'object' }, semantics: 'data' },
          { key: 'metric', shape: { type: 'number' }, semantics: 'metric' },
        ],
      }),
      task('consumer', {
        dependsOn: ['producer'],
        inputBindings: {
          x: { kind: 'task_output', taskId: 'producer', path: 'wrongKey' },
        },
      }),
    ]);
    const portRefError = errors.find((e) => e.kind === 'binding_dangling_port_ref');
    expect(portRefError).toBeDefined();
    expect(portRefError?.detail).toContain('wrongKey');
    expect(portRefError?.detail).toContain('data');
    expect(portRefError?.detail).toContain('metric');
  });

  it('accepts task_output binding when path matches a declared produces[].key', () => {
    const errors = validateWorkflowGraph([
      task('producer', {
        produces: [{ key: 'data', shape: { type: 'object' }, semantics: 'data' }],
      }),
      task('consumer', {
        dependsOn: ['producer'],
        inputBindings: {
          x: { kind: 'task_output', taskId: 'producer', path: 'data' },
        },
      }),
    ]);
    expect(errors.find((e) => e.kind === 'binding_dangling_port_ref')).toBeUndefined();
  });

  it('legacy lane: task_output with path on a producer that has NO produces[] is allowed', () => {
    const errors = validateWorkflowGraph([
      task('legacy-producer'), // no produces[]
      task('consumer', {
        dependsOn: ['legacy-producer'],
        inputBindings: {
          x: { kind: 'task_output', taskId: 'legacy-producer', path: 'somePath' },
        },
      }),
    ]);
    expect(errors.find((e) => e.kind === 'binding_dangling_port_ref')).toBeUndefined();
  });

  it('whole-output binding (no path) is allowed regardless of producer ports', () => {
    const errors = validateWorkflowGraph([
      task('producer', {
        produces: [{ key: 'data', shape: { type: 'object' }, semantics: 'data' }],
      }),
      task('consumer', {
        dependsOn: ['producer'],
        inputBindings: {
          // No `path` — binds to the whole upstream output.
          x: { kind: 'task_output', taskId: 'producer' },
        },
      }),
    ]);
    expect(errors.find((e) => e.kind === 'binding_dangling_port_ref')).toBeUndefined();
  });

  it('task_summary bindings are not subject to the port-key check', () => {
    // task_summary is a different binding kind — it pulls the upstream
    // task's prose summary, not a typed port. The port-key gate only
    // applies to task_output.
    const errors = validateWorkflowGraph([
      task('producer', {
        produces: [{ key: 'data', shape: { type: 'object' }, semantics: 'data' }],
      }),
      task('consumer', {
        dependsOn: ['producer'],
        inputBindings: {
          summary: { kind: 'task_summary', taskId: 'producer' },
        },
      }),
    ]);
    expect(errors.find((e) => e.kind === 'binding_dangling_port_ref')).toBeUndefined();
  });

  it('accepts run_input binding without further validation', () => {
    const errors = validateWorkflowGraph([
      task('a', {
        inputBindings: {
          goal: { kind: 'run_input', path: 'goal' },
        },
      }),
    ]);
    expect(errors).toEqual([]);
  });
});

// ============================================================================
// Graph validation — promoteOutputs
// ============================================================================

describe('validateWorkflowGraph — promoteOutputs', () => {
  it('accepts valid promotion to declared state var', () => {
    const vars = [stateVar('draft')];
    const errors = validateWorkflowGraph(
      [
        task('a', {
          promoteOutputs: [{ kind: 'output_root', toState: 'draft' }],
        }),
      ],
      vars,
    );
    expect(errors).toEqual([]);
  });

  it('rejects promotion to undeclared state var', () => {
    const vars = [stateVar('draft')];
    const errors = validateWorkflowGraph(
      [
        task('a', {
          promoteOutputs: [{ kind: 'output_root', toState: 'unknown' }],
        }),
      ],
      vars,
    );
    expect(errors.some((e) => e.kind === 'promotion_undeclared_state_var')).toBe(true);
  });

  it('rejects promotion when no stateVariables are declared', () => {
    const errors = validateWorkflowGraph([
      task('a', {
        promoteOutputs: [{ kind: 'output_root', toState: 'orphan' }],
      }),
    ]);
    expect(errors.some((e) => e.kind === 'promotion_undeclared_state_var')).toBe(true);
  });

  it('rejects multi-writer to same state var in Phase 1', () => {
    const vars = [stateVar('shared')];
    const errors = validateWorkflowGraph(
      [
        task('a', {
          promoteOutputs: [{ kind: 'output_root', toState: 'shared' }],
        }),
        task('b', {
          promoteOutputs: [{ kind: 'output_root', toState: 'shared' }],
        }),
      ],
      vars,
    );
    expect(errors.some((e) => e.kind === 'promotion_multi_writer')).toBe(true);
  });

  it('accepts several writers into a variable that declares them alternatives', () => {
    const errors = validateWorkflowGraph(
      [
        task('a', { promoteOutputs: [{ kind: 'output_root', toState: 'shared' }] }),
        task('b', { promoteOutputs: [{ kind: 'output_root', toState: 'shared' }] }),
      ],
      [stateVar('shared', { writers: 'alternatives' })],
    );
    expect(errors.filter((e) => e.kind.startsWith('promotion_'))).toEqual([]);
  });

  it('rejects multi-writer to immutable state var', () => {
    const vars = [stateVar('final', { immutable: true })];
    const errors = validateWorkflowGraph(
      [
        task('a', {
          promoteOutputs: [{ kind: 'output_root', toState: 'final' }],
        }),
        task('b', {
          promoteOutputs: [{ kind: 'output_root', toState: 'final' }],
        }),
      ],
      vars,
    );
    expect(errors.some((e) => e.kind === 'promotion_immutable_conflict')).toBe(true);
  });

  it('accepts single writer to immutable state var', () => {
    const vars = [stateVar('final', { immutable: true })];
    const errors = validateWorkflowGraph(
      [
        task('a', {
          promoteOutputs: [{ kind: 'output_root', toState: 'final' }],
        }),
      ],
      vars,
    );
    expect(errors).toEqual([]);
  });
});

describe('validateWorkflowGraph — workflow.output', () => {
  it('rejects primary not declared in stateVariables', () => {
    const errors = validateWorkflowGraph([], [stateVar('lbValue')], { primary: 'missing' });
    expect(errors.some((e) => e.kind === 'output_primary_undeclared_state_var')).toBe(true);
  });

  it('accepts primary that matches a declared state variable', () => {
    const errors = validateWorkflowGraph([], [stateVar('lbValue')], { primary: 'lbValue' });
    expect(errors.filter((e) => e.kind === 'output_primary_undeclared_state_var')).toEqual([]);
  });
});

// ============================================================================
// Graph validation — duplicate state variable IDs
// ============================================================================

describe('validateWorkflowGraph — state variable declarations', () => {
  it('rejects duplicate state variable IDs', () => {
    const vars = [stateVar('dup'), stateVar('dup')];
    const errors = validateWorkflowGraph([task('a')], vars);
    expect(errors.some((e) => e.kind === 'duplicate_state_var_id')).toBe(true);
  });
});

// ============================================================================
// patchTouchesGraph — stateVariables
// ============================================================================

describe('patchTouchesGraph — stateVariables', () => {
  it('returns true for /stateVariables path', () => {
    expect(patchTouchesGraph([{ op: 'replace', path: '/stateVariables' }])).toBe(true);
  });

  it('returns true for /stateVariables/0 subpath', () => {
    expect(patchTouchesGraph([{ op: 'add', path: '/stateVariables/0' }])).toBe(true);
  });
});

// ============================================================================
// extractByPath
// ============================================================================

describe('extractByPath', () => {
  it('extracts top-level field', () => {
    const result = extractByPath({ a: 42 }, 'a');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('extracts nested field', () => {
    const result = extractByPath({ a: { b: { c: 'hello' } } }, 'a.b.c');
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('returns whole object for empty path', () => {
    const obj = { a: 1 };
    const result = extractByPath(obj, '');
    expect(result).toEqual({ ok: true, value: obj });
  });

  it('fails for missing field', () => {
    const result = extractByPath({ a: 1 }, 'b');
    expect(result.ok).toBe(false);
  });

  it('fails to traverse into null', () => {
    const result = extractByPath({ a: null }, 'a.b');
    expect(result.ok).toBe(false);
  });

  it('fails to traverse into primitive', () => {
    const result = extractByPath({ a: 42 }, 'a.b');
    expect(result.ok).toBe(false);
  });

  it('extracts array element via [n] indexing', () => {
    const result = extractByPath({ items: ['x', 'y'] }, 'items[1]');
    expect(result).toEqual({ ok: true, value: 'y' });
  });

  it('extracts a nested field through an array element (content[0].text)', () => {
    const result = extractByPath({ content: [{ type: 'text', text: 'hi' }] }, 'content[0].text');
    expect(result).toEqual({ ok: true, value: 'hi' });
  });

  it('does NOT read arrays via numeric dot segments (old dialect removed)', () => {
    const result = extractByPath({ items: ['x', 'y'] }, 'items.1');
    expect(result.ok).toBe(false);
  });

  it('fails for an out-of-range array index', () => {
    const result = extractByPath({ items: ['x'] }, 'items[3]');
    expect(result.ok).toBe(false);
  });

  it('fails for a malformed path', () => {
    const result = extractByPath({ a: { b: 1 } }, 'a..b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not a valid output path');
  });
});

// ============================================================================
// resolveInputBinding
// ============================================================================

describe('resolveInputBinding', () => {
  const snapshot: TaskOutputSnapshot = {
    status: 'completed',
    output: {
      name: 'test',
      nested: { score: 0.95 },
      content: [{ type: 'text', text: 'hello' }],
    },
    metrics: { rmsle: 0.123, accuracy: 0.87 },
    summary: 'Task completed successfully',
  };

  const context: WorkflowRunContext = {
    runInput: { goal: 'optimize', config: { maxRuns: 5 } },
    taskOutputs: new Map([['design', snapshot]]),
    stateVariables: new Map([['draft', { content: 'hello' }]]),
  };

  it('resolves run_input binding', () => {
    const result = resolveInputBinding({ kind: 'run_input', path: 'goal' }, context);
    expect(result).toEqual({ ok: true, value: 'optimize' });
  });

  it('resolves run_input nested path', () => {
    const result = resolveInputBinding({ kind: 'run_input', path: 'config.maxRuns' }, context);
    expect(result).toEqual({ ok: true, value: 5 });
  });

  it('resolves task_output whole output', () => {
    const result = resolveInputBinding({ kind: 'task_output', taskId: 'design' }, context);
    expect(result).toEqual({ ok: true, value: snapshot.output });
  });

  it('resolves task_output with path', () => {
    const result = resolveInputBinding(
      { kind: 'task_output', taskId: 'design', path: 'nested.score' },
      context,
    );
    expect(result).toEqual({ ok: true, value: 0.95 });
  });

  it('resolves task_output with a [n]-indexed path (shared dialect)', () => {
    const result = resolveInputBinding(
      { kind: 'task_output', taskId: 'design', path: 'content[0].text' },
      context,
    );
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('resolves task_summary', () => {
    const result = resolveInputBinding({ kind: 'task_summary', taskId: 'design' }, context);
    expect(result).toEqual({ ok: true, value: 'Task completed successfully' });
  });

  it('fails for missing task', () => {
    const result = resolveInputBinding({ kind: 'task_output', taskId: 'ghost' }, context);
    expect(result.ok).toBe(false);
  });

  it('fails for task_summary when summary is absent', () => {
    const noSummaryContext: WorkflowRunContext = {
      taskOutputs: new Map([['nosum', { status: 'completed', output: { x: 1 } }]]),
      stateVariables: new Map(),
    };
    const result = resolveInputBinding({ kind: 'task_summary', taskId: 'nosum' }, noSummaryContext);
    expect(result.ok).toBe(false);
  });

  it('resolves campaign_input from campaignConfig', () => {
    const campaignContext: WorkflowRunContext = {
      taskOutputs: new Map(),
      stateVariables: new Map(),
      campaignConfig: { competitionSlug: 'house-prices', metricName: 'rmsle' },
    };
    const result = resolveInputBinding(
      { kind: 'campaign_input', path: 'competitionSlug' },
      campaignContext,
    );
    expect(result).toEqual({ ok: true, value: 'house-prices' });
  });

  it('fails cleanly for campaign_input when campaignConfig is absent', () => {
    const result = resolveInputBinding(
      { kind: 'campaign_input', path: 'competitionSlug' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('Campaign config not available');
  });

  it('fails for campaign_input when the field is missing from campaignConfig', () => {
    const campaignContext: WorkflowRunContext = {
      taskOutputs: new Map(),
      stateVariables: new Map(),
      campaignConfig: { competitionSlug: 'house-prices' },
    };
    const result = resolveInputBinding(
      { kind: 'campaign_input', path: 'metricName' },
      campaignContext,
    );
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// resolveTaskInputBindings
// ============================================================================

describe('resolveTaskInputBindings', () => {
  const context: WorkflowRunContext = {
    runInput: { goal: 'optimize' },
    taskOutputs: new Map([
      [
        'a',
        {
          status: 'completed',
          output: { workflow: { tasks: [] } },
          metrics: { score: 42 },
          summary: 'Done',
        },
      ],
    ]),
    stateVariables: new Map(),
  };

  it('resolves all bindings and merges with base inputs', () => {
    const result = resolveTaskInputBindings(
      {
        data: { kind: 'task_output', taskId: 'a', path: 'workflow' },
        target: { kind: 'run_input', path: 'goal' },
      },
      context,
      { existing: 'kept' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved['existing']).toBe('kept');
      expect(result.resolved['data']).toEqual({ tasks: [] });
      expect(result.resolved['target']).toBe('optimize');
    }
  });

  it('returns errors for failed bindings', () => {
    const result = resolveTaskInputBindings(
      {
        data: { kind: 'task_output', taskId: 'ghost' },
      },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.field).toBe('data');
    }
  });
});
