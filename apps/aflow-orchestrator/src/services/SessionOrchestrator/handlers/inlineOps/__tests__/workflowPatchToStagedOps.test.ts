import { describe, it, expect } from 'vitest';
import type { Workflow } from '@aflow/schemas';
import {
  convertWorkflowPatchToStagedOps,
  convertManifestPatchToStagedOps,
  isManifestPatchOp,
  type ManifestPatchDoc,
} from '../workflowPatchToStagedOps.js';

function makeWorkflow(): Workflow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'propose-and-execute-trade',
    name: 'Propose and Execute Trade',
    description: '',
    outcomes: [
      {
        id: 'order-submitted',
        name: 'Order Submitted',
        evaluator: {
          type: 'threshold',
          metric: 'success',
          operator: 'gte',
          target: 1,
        },
      },
    ],
    mode: 'process',
    tasks: [
      { taskId: 'hydrate', name: 'Hydrate', goal: 'Hydrate inputs.', type: 'agent' },
      {
        taskId: 'submit-order',
        name: 'Submit Order',
        goal: 'Submit the order.',
        type: 'agent',
        dependsOn: ['hydrate'],
        context: {
          strategy: 'scoped',
          capabilities: {
            integrations: [
              {
                capabilityId: 'kaggle',
                binding: { kind: 'binding' as const, bindingId: 'kaggle-binding' },
                sourceKind: 'api',
                integrationId: 'kaggle',
                toolNames: [{ toolName: 'download_file' }],
              },
            ],
          },
        },
      },
    ],
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    stateVariables: [],
    revision: 1,
    status: 'approved',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
  };
}

describe('convertWorkflowPatchToStagedOps', () => {
  // ==========================================================================
  // Supported shapes — happy paths
  // ==========================================================================

  it('converts replace /tasks/{i}/goal to update_task_goal with the right taskId', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/tasks/1/goal', value: 'Fixed goal text.' }],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'update_task_goal', taskId: 'submit-order', newGoal: 'Fixed goal text.' },
    ]);
  });

  it('converts replace /tasks/{i}/dependsOn to update_task_dependencies', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/tasks/1/dependsOn', value: ['hydrate', 'analyze'] }],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'update_task_dependencies', taskId: 'submit-order', dependsOn: ['hydrate', 'analyze'] },
    ]);
  });

  it('marks empty dependsOn as a source-task promotion', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/tasks/1/dependsOn', value: [] }],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      {
        op: 'update_task_dependencies',
        taskId: 'submit-order',
        dependsOn: [],
        source: true,
      },
    ]);
  });

  it('converts remove /tasks/{i} to remove_task', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'remove', path: '/tasks/0' }],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([{ op: 'remove_task', taskId: 'hydrate' }]);
  });

  it('converts add /tasks/- to add_task when the value passes WorkflowTaskSchema', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'add',
          path: '/tasks/-',
          value: {
            taskId: 'analyze',
            name: 'Analyze',
            goal: 'Analyze inputs.market.',
            type: 'agent',
            dependsOn: ['hydrate'],
          },
        },
      ],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toHaveLength(1);
    expect(out.ops[0]).toMatchObject({ op: 'add_task' });
  });

  it('converts replace /outcomes/{i}/evaluator/target to update_outcome_threshold', () => {
    // The threshold lives at outcome.evaluator.target, so the JSON Patch
    // path mirrors that structure.
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/outcomes/0/evaluator/target', value: 0.95 }],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'update_outcome_threshold', outcomeId: 'order-submitted', newTarget: 0.95 },
    ]);
  });

  it('converts replace /iteration to update_iteration_policy (fields it carries)', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'replace',
          path: '/iteration',
          value: {
            auto: false, // matches existing — no change
            maxConsecutiveRuns: 5,
            stopOnOutcomesMet: false,
            cooldownMs: 1000,
          },
        },
      ],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      {
        op: 'update_iteration_policy',
        maxConsecutiveRuns: 5,
        cooldownMs: 1000,
        stopOnOutcomesMet: false,
      },
    ]);
  });

  it('refuses iteration auto flips (update_iteration_policy does not cover it)', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'replace',
          path: '/iteration',
          value: { auto: true, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
        },
      ],
      makeWorkflow(),
    );
    expect(out.ops).toEqual([]);
    expect(out.unsupported[0]).toMatch(/auto/);
  });

  it('converts nested task context patches to update_task_context_spec with the patched context', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'add',
          path: '/tasks/1/context/capabilities/integrations/0/toolNames/-',
          value: { toolName: 'submit_blob_url' },
        },
      ],
      makeWorkflow(),
    );

    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      {
        op: 'update_task_context_spec',
        taskId: 'submit-order',
        contextSpec: {
          strategy: 'scoped',
          contextPolicy: 'auto-optimize',
          learnings: 'active',
          capabilities: {
            operations: [],
            integrations: [
              {
                capabilityId: 'kaggle',
                binding: { kind: 'binding' as const, bindingId: 'kaggle-binding' },
                sourceKind: 'api',
                integrationId: 'kaggle',
                allTools: false,
                toolNames: [{ toolName: 'download_file' }, { toolName: 'submit_blob_url' }],
              },
            ],
          },
        },
      },
    ]);
  });

  it('rejects nested task context patches that leave the context invalid', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'replace',
          path: '/tasks/1/context/capabilities/integrations/0/sourceKind',
          value: 'ftp',
        },
      ],
      makeWorkflow(),
    );

    expect(out.ops).toEqual([]);
    expect(out.unsupported[0]).toMatch(/invalid TaskContextSpec/);
  });

  it('converts deep task patches to replace_task with the patched whole task', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'add',
          path: '/tasks/1/outputContract',
          value: {
            schema: {
              type: 'object',
              properties: { submissionUrl: { type: 'string' } },
              required: ['submissionUrl'],
              additionalProperties: false,
            },
          },
        },
      ],
      makeWorkflow(),
    );

    expect(out.unsupported).toEqual([]);
    expect(out.ops).toHaveLength(1);
    expect(out.ops[0]).toMatchObject({
      op: 'replace_task',
      taskId: 'submit-order',
      task: {
        taskId: 'submit-order',
        outputContract: {
          schema: {
            type: 'object',
            properties: { submissionUrl: { type: 'string' } },
            required: ['submissionUrl'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('converts workflow output patches to update_workflow_contract', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'add', path: '/output', value: { primary: 'submissionUrl' } }],
      {
        ...makeWorkflow(),
        stateVariables: [
          { variableId: 'submissionUrl', name: 'Submission URL', schema: { type: 'string' } },
        ],
      },
    );

    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'update_workflow_contract', output: { primary: 'submissionUrl' } },
    ]);
  });

  it('converts state variable patches to update_workflow_contract', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'add',
          path: '/stateVariables/-',
          value: {
            variableId: 'submissionUrl',
            name: 'Submission URL',
            schema: { type: 'string' },
          },
        },
      ],
      makeWorkflow(),
    );

    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      {
        op: 'update_workflow_contract',
        stateVariables: [
          {
            variableId: 'submissionUrl',
            name: 'Submission URL',
            required: false,
            sensitive: false,
            immutable: false,
          },
        ],
      },
    ]);
  });

  // ==========================================================================
  // Unsupported shapes — must surface actionable error strings
  // ==========================================================================

  it('rejects task replacement patches that would rename the task', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'replace',
          path: '/tasks/1/taskId',
          value: 'renamed-task',
        },
      ],
      makeWorkflow(),
    );
    expect(out.ops).toEqual([]);
    expect(out.unsupported[0]).toMatch(/Task identity is immutable/);
  });

  it('rejects move and copy ops', () => {
    const wf = makeWorkflow();
    const moveResult = convertWorkflowPatchToStagedOps(
      [{ op: 'move', path: '/tasks/1', from: '/tasks/0' }],
      wf,
    );
    expect(moveResult.unsupported[0]).toMatch(/move/);

    const copyResult = convertWorkflowPatchToStagedOps(
      [{ op: 'copy', path: '/tasks/-', from: '/tasks/0' }],
      wf,
    );
    expect(copyResult.unsupported[0]).toMatch(/copy/);
  });

  it('rejects test ops', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'test', path: '/tasks/0/goal', value: 'whatever' }],
      makeWorkflow(),
    );
    expect(out.unsupported[0]).toMatch(/test/);
  });

  it('rejects a task index that is out of range', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/tasks/99/goal', value: 'whatever' }],
      makeWorkflow(),
    );
    expect(out.unsupported[0]).toMatch(/index 99.*does not exist/);
  });

  it('rejects /tasks/{i}/goal with a non-string value', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'replace', path: '/tasks/0/goal', value: 42 }],
      makeWorkflow(),
    );
    expect(out.unsupported[0]).toMatch(/string value/);
  });

  it('rejects add /tasks/- when value is not a valid WorkflowTask', () => {
    const out = convertWorkflowPatchToStagedOps(
      [{ op: 'add', path: '/tasks/-', value: { taskId: 'foo' } }],
      makeWorkflow(),
    );
    expect(out.unsupported[0]).toMatch(/WorkflowTaskSchema/);
  });

  // ==========================================================================
  // Mixed-shape patch — partial conversion: all-or-nothing behavior is the
  // caller's choice. The converter reports both buckets so the handler can
  // decide whether to reject or proceed with the supported subset.
  // ==========================================================================

  it('reports both supported ops and unsupported reasons on a mixed patch', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        { op: 'replace', path: '/tasks/0/goal', value: 'Fixed goal.' },
        { op: 'replace', path: '/slug', value: 'renamed-workflow' }, // unsupported
      ],
      makeWorkflow(),
    );
    expect(out.ops).toHaveLength(1);
    expect(out.unsupported).toHaveLength(1);
  });

  // ==========================================================================
  // RFC 6902 array-index semantics — each op resolves against the document
  // AFTER prior ops have been applied. Without a shadow workflow, a sequence
  // like `[remove /tasks/0, replace /tasks/0/goal]` would lower the second
  // op to the WRONG taskId.
  // ==========================================================================

  it('resolves later indexed ops against the document mutated by earlier ops', () => {
    // Sequence: remove hydrate (was /tasks/0), then patch /tasks/0/goal which
    // now points at submit-order. Without the shadow, the second op would
    // resolve to taskId=hydrate (which was just removed!).
    const out = convertWorkflowPatchToStagedOps(
      [
        { op: 'remove', path: '/tasks/0' },
        { op: 'replace', path: '/tasks/0/goal', value: 'Updated submit-order goal.' },
      ],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'remove_task', taskId: 'hydrate' },
      { op: 'update_task_goal', taskId: 'submit-order', newGoal: 'Updated submit-order goal.' },
    ]);
  });

  it('honors add /tasks/- when a later op references the newly-appended task', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        {
          op: 'add',
          path: '/tasks/-',
          value: {
            taskId: 'analyze',
            name: 'Analyze',
            goal: 'Analyze inputs.market.',
            type: 'agent',
            dependsOn: ['hydrate'],
          },
        },
        // After append, the new task lives at index 2. The shadow advances
        // before this resolution, so the second op should pick it up.
        { op: 'replace', path: '/tasks/2/goal', value: 'Refined analyze goal.' },
      ],
      makeWorkflow(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toHaveLength(2);
    expect(out.ops[0]).toMatchObject({ op: 'add_task' });
    expect(out.ops[1]).toEqual({
      op: 'update_task_goal',
      taskId: 'analyze',
      newGoal: 'Refined analyze goal.',
    });
  });

  it('halts and reports when a later op is invalid against the shadow (e.g., removed-task ref)', () => {
    const out = convertWorkflowPatchToStagedOps(
      [
        { op: 'remove', path: '/tasks/0' },
        { op: 'remove', path: '/tasks/0' },
        { op: 'remove', path: '/tasks/0' }, // no task left to remove
      ],
      makeWorkflow(),
    );
    // First two are valid removes; the third should fail shadow-apply and
    // surface as unsupported.
    expect(out.ops).toEqual([
      { op: 'remove_task', taskId: 'hydrate' },
      { op: 'remove_task', taskId: 'submit-order' },
    ]);
    expect(out.unsupported.length).toBeGreaterThanOrEqual(1);
    expect(out.unsupported.at(-1)).toMatch(/cannot be applied/);
  });
});

function makeManifestDoc(): ManifestPatchDoc {
  return {
    goal: { type: 'subjective', rubric: ['Output is clear'] },
    campaign: {
      fields: {
        competitionSlug: {
          schema: { type: 'string', minLength: 1 },
          identity: true,
          label: 'Competition slug',
        },
        targetScore: { schema: { type: 'number' }, label: 'Target score' },
      },
    },
  };
}

describe('isManifestPatchOp', () => {
  it('classifies /goal and /campaign paths as manifest, others as workflow', () => {
    expect(isManifestPatchOp({ op: 'replace', path: '/goal', value: {} })).toBe(true);
    expect(isManifestPatchOp({ op: 'add', path: '/campaign/fields/x', value: {} })).toBe(true);
    expect(isManifestPatchOp({ op: 'replace', path: '/tasks/0/goal', value: 'x' })).toBe(false);
    expect(isManifestPatchOp({ op: 'replace', path: '/status', value: 'approved' })).toBe(false);
  });
});

describe('convertManifestPatchToStagedOps', () => {
  it('replace /goal lowers to update_goal', () => {
    const nextGoal = { type: 'subjective', rubric: ['Maximize F1'] };
    const out = convertManifestPatchToStagedOps(
      [{ op: 'replace', path: '/goal', value: nextGoal }],
      makeManifestDoc(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([{ op: 'update_goal', goal: nextGoal }]);
  });

  it('nested /goal patch re-emits the whole goal', () => {
    const out = convertManifestPatchToStagedOps(
      [{ op: 'replace', path: '/goal/rubric/0', value: 'Sharper rubric' }],
      makeManifestDoc(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'update_goal', goal: { type: 'subjective', rubric: ['Sharper rubric'] } },
    ]);
  });

  it('refuses to remove the goal', () => {
    const out = convertManifestPatchToStagedOps(
      [{ op: 'remove', path: '/goal' }],
      makeManifestDoc(),
    );
    expect(out.ops).toEqual([]);
    expect(out.unsupported[0]).toMatch(/must always have a goal/);
  });

  it('add a new /campaign/fields key lowers to campaign.field.add', () => {
    const field = { schema: { type: 'number' }, label: 'Max runtime' };
    const out = convertManifestPatchToStagedOps(
      [{ op: 'add', path: '/campaign/fields/maxRuntime', value: field }],
      makeManifestDoc(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([{ op: 'campaign.field.add', fieldKey: 'maxRuntime', field }]);
  });

  it('replace an existing field lowers to campaign.field.update; remove to campaign.field.remove', () => {
    const field = { schema: { type: 'integer' }, label: 'Target score' };
    const out = convertManifestPatchToStagedOps(
      [
        { op: 'replace', path: '/campaign/fields/targetScore', value: field },
        { op: 'remove', path: '/campaign/fields/targetScore' },
      ],
      makeManifestDoc(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      { op: 'campaign.field.update', fieldKey: 'targetScore', field },
      { op: 'campaign.field.remove', fieldKey: 'targetScore' },
    ]);
  });

  it('nested field patch re-emits the whole field as campaign.field.update', () => {
    const out = convertManifestPatchToStagedOps(
      [{ op: 'replace', path: '/campaign/fields/targetScore/label', value: 'Goal score' }],
      makeManifestDoc(),
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([
      {
        op: 'campaign.field.update',
        fieldKey: 'targetScore',
        field: { schema: { type: 'number' }, label: 'Goal score' },
      },
    ]);
  });

  it('adds the FIRST field to a contract-less skill', () => {
    const field = { schema: { type: 'string' }, label: 'Competition' };
    const out = convertManifestPatchToStagedOps(
      [{ op: 'add', path: '/campaign/fields/competition', value: field }],
      { goal: { type: 'subjective', rubric: ['x'] } },
    );
    expect(out.unsupported).toEqual([]);
    expect(out.ops).toEqual([{ op: 'campaign.field.add', fieldKey: 'competition', field }]);
  });

  it('rejects an unsupported manifest path', () => {
    const out = convertManifestPatchToStagedOps(
      [{ op: 'replace', path: '/campaign/somethingElse', value: 1 }],
      makeManifestDoc(),
    );
    expect(out.ops).toEqual([]);
    expect(out.unsupported[0]).toMatch(/not supported for goal\/campaign/);
  });
});
