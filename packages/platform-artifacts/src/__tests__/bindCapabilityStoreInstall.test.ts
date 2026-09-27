import { describe, it, expect } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph, validateWhenExpression } from '@aflow/cybernetic-runtime';
import { BIND_CAPABILITY_WORKFLOW } from '../skillBundles.js';

const wf = BIND_CAPABILITY_WORKFLOW as unknown as {
  outcomes: Array<{ id: string; evaluator: Record<string, unknown> }>;
  stateVariables: Array<{ variableId: string }>;
  tasks: Array<Record<string, unknown>>;
};

function task(taskId: string): Record<string, unknown> {
  const t = wf.tasks.find((x) => x['taskId'] === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  return t;
}

function elicitTargetVariants(): Array<Record<string, unknown>> {
  const contract = task('elicit-target')['outputContract'] as { schema: Record<string, unknown> };
  const variants = (contract.schema['anyOf'] ?? contract.schema['oneOf']) as
    Array<Record<string, unknown>> | undefined;
  if (!variants) throw new Error('elicit-target output schema is not a union');
  return variants;
}

function scopeOf(variant: Record<string, unknown>): unknown {
  const props = variant['properties'] as Record<string, Record<string, unknown>> | undefined;
  const scope = props?.['scope'];
  if (scope?.['const'] !== undefined) return scope['const'];
  const values = scope?.['enum'];
  return Array.isArray(values) ? values[0] : undefined;
}

describe('bind-capability store-install branch', () => {
  it('the elicit-target union carries a store_install arm with the listing coordinates', () => {
    const arm = elicitTargetVariants().find((v) => scopeOf(v) === 'store_install');
    expect(arm).toBeDefined();
    const required = arm!['required'] as string[];
    expect(required).toContain('catalogId');
    expect(required).toContain('expectedVersion');
    // Pinned false so drafting/proposing a definition stays inexpressible
    // on the store path (their gates require proceedWithApiChange == true).
    const props = arm!['properties'] as Record<string, Record<string, unknown>>;
    const proceed = props['proceedWithApiChange'];
    const pinned = proceed?.['const'] ?? (proceed?.['enum'] as unknown[] | undefined)?.[0];
    expect(pinned).toBe(false);
  });

  it('elicit-target is granted the store discovery pair to run the store check', () => {
    const context = task('elicit-target')['context'] as {
      capabilities: { operations: string[] };
    };
    expect(context.capabilities.operations).toContain('store.listing.search');
    expect(context.capabilities.operations).toContain('store.listing.get');
  });

  it('propose-store-install routes the store_install scope to store.listing.install', () => {
    const t = task('propose-store-install');
    expect(t['type']).toBe('operation');
    expect(t['operation']).toBe('store.listing.install');
    expect(t['dependsOn']).toEqual(['elicit-target']);
    const when = t['when'] as { expression: string; onMissingRef: string };
    expect(when.expression).toBe("tasks.elicit-target.output.scope == 'store_install'");
    expect(when.onMissingRef).toBe('skip');
    expect(validateWhenExpression(when.expression)).toBeNull();
    expect(t['inputBindings']).toEqual({
      catalogId: { kind: 'task_output', taskId: 'elicit-target', path: 'catalogId' },
      expectedVersion: { kind: 'task_output', taskId: 'elicit-target', path: 'expectedVersion' },
    });
  });

  it('promotes the install proposal status into a declared state variable with an outcome', () => {
    const promos = task('propose-store-install')['promoteOutputs'] as Array<
      Record<string, unknown>
    >;
    expect(promos).toContainEqual({
      kind: 'output_path',
      path: 'status',
      toState: 'install_status',
    });
    expect(wf.stateVariables.some((v) => v.variableId === 'install_status')).toBe(true);
    const outcome = wf.outcomes.find((o) => o.id === 'store-install-proposed');
    expect(outcome?.evaluator).toEqual({
      type: 'pattern',
      metric: 'install_status',
      pattern: 'proposed',
    });
  });

  it('draft-definition and propose-binding stay gated off the store path', () => {
    for (const id of ['draft-definition', 'propose-binding']) {
      const when = task(id)['when'] as { expression: string };
      expect(when.expression).toBe('tasks.elicit-target.output.proceedWithApiChange == true');
    }
  });

  it('the workflow graph is valid with the store-install branch wired', () => {
    const errors = validateWorkflowGraph(
      wf.tasks as unknown as WorkflowTask[],
      wf.stateVariables as unknown as Parameters<typeof validateWorkflowGraph>[1],
    );
    expect(errors).toEqual([]);
  });
});
