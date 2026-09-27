import { describe, it, expect } from 'vitest';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import { collectOperationTaskApiRefs } from './operationTaskApiRefs.js';
import { deriveCapabilityDependencies } from './skillProjectionReconciler.js';
import { deriveRequiredCapabilities } from './stagedChange/skillComposeApply.js';
import { checkGrantIntegrity } from './stagedChange/proposalValidations.js';

function opTask(taskId: string, inputTemplate: Record<string, unknown>): WorkflowTask {
  return {
    taskId,
    name: taskId,
    goal: 'g',
    type: 'operation',
    operation: 'api.http.call',
    inputTemplate,
  } as unknown as WorkflowTask;
}

describe('collectOperationTaskApiRefs', () => {
  it('collects a static direct-URL binding ref from an api.http.call operation task', () => {
    const refs = collectOperationTaskApiRefs([
      opTask('put-bytes', {
        apiId: 'kaggle-data-fetch',
        bindingId: 'kaggle-data-fetch-default',
        url: { $bind: 'createUrl' },
        method: 'PUT',
      }),
    ]);
    expect(refs).toEqual([
      { taskId: 'put-bytes', apiId: 'kaggle-data-fetch', bindingId: 'kaggle-data-fetch-default' },
    ]);
  });

  it('collects an endpoint-mode operation ref', () => {
    const refs = collectOperationTaskApiRefs([
      opTask('finalize', { apiId: 'kaggle', endpointId: 'submit_to_competition' }),
    ]);
    expect(refs).toEqual([
      { taskId: 'finalize', apiId: 'kaggle', endpointId: 'submit_to_competition' },
    ]);
  });

  it('skips a dynamic ($bind) apiId — not statically resolvable', () => {
    const refs = collectOperationTaskApiRefs([
      opTask('dyn', { apiId: { $bind: 'whichApi' }, url: { $bind: 'u' } }),
    ]);
    expect(refs).toEqual([]);
  });

  it('ignores non-api.http.call operation tasks', () => {
    const t = { taskId: 'x', name: 'x', goal: 'g', type: 'operation', operation: 'workflow.learn' };
    expect(collectOperationTaskApiRefs([t as unknown as WorkflowTask])).toEqual([]);
  });
});

describe('deriveCapabilityDependencies sees operation-task bindings', () => {
  it('registers an api dependency for a direct-URL binding used only in an operation task', () => {
    const workflow = {
      tasks: [
        opTask('put-bytes', {
          apiId: 'kaggle-data-fetch',
          bindingId: 'kaggle-data-fetch-default',
          url: { $bind: 'createUrl' },
        }),
      ],
    } as unknown as Workflow;
    const deps = deriveCapabilityDependencies(workflow);
    const apiDep = deps.find(
      (d) => d.capabilityType === 'api' && d.bindingId === 'kaggle-data-fetch-default',
    );
    expect(apiDep).toBeDefined();
    expect(apiDep?.capabilityId).toBe('kaggle-data-fetch');
    expect(apiDep?.taskIds).toContain('put-bytes');
  });
});

describe('deriveRequiredCapabilities — exact binding', () => {
  it('requires the exact bindingId (not just apiId) for a direct-URL operation ref', () => {
    const bundle = {
      workflow: {
        tasks: [
          opTask('put-bytes', {
            apiId: 'kaggle-data-fetch',
            bindingId: 'kaggle-data-fetch-default',
            url: { $bind: 'createUrl' },
          }),
        ],
      },
    } as unknown as Parameters<typeof deriveRequiredCapabilities>[0];
    const caps = deriveRequiredCapabilities(bundle);
    // Both required — so checkMissingCapabilities flags the exact binding if it's
    // missing/disabled even when another binding for the apiId is enabled.
    expect(caps).toContain('kaggle-data-fetch');
    expect(caps).toContain('kaggle-data-fetch-default');
  });
});

describe('checkGrantIntegrity — operation-task exact-ref checks', () => {
  const snapshot = {
    apiBindings: [
      { bindingId: 'kaggle-data-fetch-default', apiId: 'kaggle-data-fetch', endpointIds: [] },
      { bindingId: 'kaggle-default', apiId: 'kaggle', endpointIds: ['submit_to_competition'] },
    ],
    mcpBindings: [],
  } as unknown as Parameters<typeof checkGrantIntegrity>[1];

  it('flags a binding whose apiId does not match the op call', () => {
    const workflow = {
      tasks: [opTask('x', { apiId: 'kaggle', bindingId: 'kaggle-data-fetch-default' })],
    } as unknown as Workflow;
    const r = checkGrantIntegrity(workflow, snapshot);
    expect(r.issues.some((i) => i.includes('belongs to apiId'))).toBe(true);
  });

  it('flags an endpoint-mode op (no bindingId) with an unknown endpointId', () => {
    const workflow = {
      tasks: [opTask('y', { apiId: 'kaggle', endpointId: 'no_such_endpoint' })],
    } as unknown as Workflow;
    const r = checkGrantIntegrity(workflow, snapshot);
    expect(r.issues.some((i) => i.includes('no such endpoint'))).toBe(true);
  });

  it('warns when a direct-URL binding is absent from the space', () => {
    const workflow = {
      tasks: [opTask('z', { apiId: 'kaggle-data-fetch', bindingId: 'missing-binding' })],
    } as unknown as Workflow;
    const r = checkGrantIntegrity(workflow, snapshot);
    expect(r.warnings.some((w) => w.includes('not present in this space'))).toBe(true);
  });

  it('passes a correct direct-URL op (matching apiId + bindingId)', () => {
    const workflow = {
      tasks: [
        opTask('ok', {
          apiId: 'kaggle-data-fetch',
          bindingId: 'kaggle-data-fetch-default',
          url: { $bind: 'u' },
        }),
      ],
    } as unknown as Workflow;
    const r = checkGrantIntegrity(workflow, snapshot);
    expect(r.issues).toEqual([]);
  });
});
