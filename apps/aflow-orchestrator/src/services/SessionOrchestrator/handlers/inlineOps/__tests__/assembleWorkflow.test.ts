import { describe, it, expect } from 'vitest';
import {
  ComposedWorkflowSchema,
  WorkflowAssemblyInputSchema,
  getOperation,
  toJsonSchemaSync,
  type ComposeIntent,
  type DesignSurface,
  type TaskGraphDraft,
  type WorkflowAssemblyInput,
} from '@aflow/schemas';
import {
  validateWorkflowGraph,
  materializeAndValidateSkillConfig,
} from '@aflow/cybernetic-runtime';
import { assembleWorkflow as rawAssembleWorkflow } from '../assembleWorkflow.js';

/**
 * The handler parses input through `WorkflowAssemblyInputSchema.safeParse`
 * before delegating; tests do the same so Zod defaults (e.g. `consumes: []`,
 * `produces: []`) are populated. Direct call with raw fixtures would bypass
 * those defaults and surface as runtime errors that don't reflect production.
 */
function assembleWorkflow(input: WorkflowAssemblyInput) {
  return rawAssembleWorkflow(WorkflowAssemblyInputSchema.parse(input));
}

// ============================================================================
// Fixtures
// ============================================================================

function emptySurface(): DesignSurface {
  return {
    integrations: [],
    operations: [],
    policies: { compute: false },
    bindableButUnbound: [],
  };
}

function intentOf(overrides: Partial<ComposeIntent> = {}): ComposeIntent {
  return {
    intent: 'Compose a test skill.',
    iterationModel: 'process',
    requiredCapabilities: [],
    requiredDataSources: [],
    taskShapeHints: [],
    pauseForUser: { needed: false },
    ...overrides,
  };
}

function draftOf(overrides: Partial<TaskGraphDraft>): TaskGraphDraft {
  return {
    slug: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill.',
    goal: 'Do the test thing.',
    outcomes: [
      {
        id: 'done',
        name: 'Done',
        evaluator: { type: 'manual', instruction: 'It worked.' },
      },
    ],
    tasks: overrides.tasks ?? [
      { type: 'agent', kind: 'transformer', taskId: 'main', goal: 'Do it.' },
    ],
    ...overrides,
  };
}

function inputOf(parts: Partial<WorkflowAssemblyInput>): WorkflowAssemblyInput {
  return {
    intent: parts.intent ?? intentOf(),
    surface: parts.surface ?? emptySurface(),
    draft: parts.draft ?? draftOf({}),
  };
}

// ============================================================================
// iterationModel → mode
// ============================================================================

describe('assembleWorkflow — iterationModel → mode', () => {
  it.each(['optimization', 'process', 'project'] as const)(
    'maps iterationModel="%s" to workflow.mode',
    (model) => {
      const out = assembleWorkflow(inputOf({ intent: intentOf({ iterationModel: model }) }));
      expect(out.workflow.mode).toBe(model);
    },
  );

  it('iteration policy auto-iterates only for optimization mode', () => {
    const opt = assembleWorkflow(inputOf({ intent: intentOf({ iterationModel: 'optimization' }) }));
    const proc = assembleWorkflow(inputOf({ intent: intentOf({ iterationModel: 'process' }) }));
    expect(opt.workflow.iteration?.maxConsecutiveRuns).toBe(5);
    expect(proc.workflow.iteration?.maxConsecutiveRuns).toBe(1);
  });
});

// ============================================================================
// State variables + bindings + promotions (§12 #10 — load-bearing)
// ============================================================================

describe('assembleWorkflow — typed dataflow → task_output bindings', () => {
  const tinyInput: WorkflowAssemblyInput = inputOf({
    draft: draftOf({
      tasks: [
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'fetch-data',
          goal: 'Fetch.',
          produces: [{ key: 'rows', shape: { type: 'array' }, semantics: 'data' }],
        },
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'transform',
          goal: 'Transform.',
          produces: [{ key: 'cleaned', shape: { type: 'object' }, semantics: 'data' }],
          consumes: [{ taskId: 'fetch-data', outputKey: 'rows', bindAs: 'incoming' }],
        },
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'summarize',
          goal: 'Summarize.',
          consumes: [{ taskId: 'transform', outputKey: 'cleaned', bindAs: 'data' }],
        },
      ],
    }),
  });

  it('does not synthesize stateVariables (state lane is unwired at runtime)', () => {
    const out = assembleWorkflow(tinyInput);
    expect(out.workflow.stateVariables).toEqual([]);
  });

  it('does not synthesize promoteOutputs', () => {
    const out = assembleWorkflow(tinyInput);
    for (const t of out.workflow.tasks) {
      expect(t.promoteOutputs).toBeUndefined();
    }
  });

  it('lowers consumes to task_output inputBindings', () => {
    const out = assembleWorkflow(tinyInput);
    const transform = out.workflow.tasks.find((t) => t.taskId === 'transform')!;
    expect(transform.inputBindings).toEqual({
      incoming: { kind: 'task_output', taskId: 'fetch-data', path: 'rows' },
    });
    const summarize = out.workflow.tasks.find((t) => t.taskId === 'summarize')!;
    expect(summarize.inputBindings).toEqual({
      data: { kind: 'task_output', taskId: 'transform', path: 'cleaned' },
    });
  });

  it('does not author priorResults on agent consumers (Plan 123 cleanup — typed inputBindings is the only channel)', () => {
    const out = assembleWorkflow(tinyInput);
    const fetcher = out.workflow.tasks.find((t) => t.taskId === 'fetch-data')!;
    const transform = out.workflow.tasks.find((t) => t.taskId === 'transform')!;
    const summarize = out.workflow.tasks.find((t) => t.taskId === 'summarize')!;
    // fetch-data has no consumes — no context block at all.
    expect(fetcher.context).toBeUndefined();
    // Consumers get a context block (capabilities + scoped strategy) but
    // never the legacy `priorResults` field — upstream data flows through
    // `inputBindings` resolved into the typed `TaskInputs` channel.
    expect(transform.context).toBeDefined();
    expect(
      (transform.context as Record<string, unknown> | undefined)?.['priorResults'],
    ).toBeUndefined();
    expect(summarize.context).toBeDefined();
    expect(
      (summarize.context as Record<string, unknown> | undefined)?.['priorResults'],
    ).toBeUndefined();
    // `inputBindings` are still authored on the consumers so the typed
    // channel actually has bindings to resolve.
    expect(transform.inputBindings).toBeDefined();
    expect(summarize.inputBindings).toBeDefined();
  });

  it('builds dependsOn = explicit ∪ implicit-from-consumes (deduped, sorted)', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'a',
              goal: 'g',
              produces: [{ key: 'k', shape: { type: 'object' }, semantics: 'data' }],
            },
            { type: 'agent', kind: 'transformer', taskId: 'b', goal: 'g' },
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'c',
              goal: 'g',
              dependsOn: ['b'],
              consumes: [{ taskId: 'a', outputKey: 'k', bindAs: 'i' }],
            },
          ],
        }),
      }),
    );
    const c = out.workflow.tasks.find((t) => t.taskId === 'c')!;
    expect(c.dependsOn).toEqual(['a', 'b']);
  });

  it('produces a workflow that satisfies validateWorkflowGraph', () => {
    const out = assembleWorkflow(tinyInput);
    const errors = validateWorkflowGraph(out.workflow.tasks, out.workflow.stateVariables);
    expect(errors).toEqual([]);
  });

  it('parses against ComposedWorkflowSchema', () => {
    const out = assembleWorkflow(tinyInput);
    const result = ComposedWorkflowSchema.safeParse(out.workflow);
    if (!result.success) {
      throw new Error(`ComposedWorkflowSchema rejected output: ${result.error.message}`);
    }
  });
});

// ============================================================================

describe('assembleWorkflow — Plan 123 C3 produces[] persistence', () => {
  it('lifts produces[] from the IR onto each assembled task', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'fetch',
              goal: 'Fetch.',
              produces: [
                { key: 'rows', shape: { type: 'array' }, semantics: 'data' },
                {
                  key: 'meta',
                  shape: { type: 'object', properties: { count: { type: 'integer' } } },
                  semantics: 'metric',
                },
              ],
            },
          ],
        }),
      }),
    );
    const fetch = out.workflow.tasks.find((t) => t.taskId === 'fetch')!;
    expect(fetch.produces).toEqual([
      { key: 'rows', shape: { type: 'array' }, semantics: 'data' },
      {
        key: 'meta',
        shape: { type: 'object', properties: { count: { type: 'integer' } } },
        semantics: 'metric',
      },
    ]);
  });

  it('omits produces on tasks that declare no ports', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [{ type: 'agent', kind: 'transformer', taskId: 'noop', goal: 'Do nothing.' }],
        }),
      }),
    );
    const noop = out.workflow.tasks.find((t) => t.taskId === 'noop')!;
    expect(noop.produces).toBeUndefined();
  });

  it('throws when a task declares duplicate produces[].key (P2.2 review fix)', () => {
    expect(() =>
      assembleWorkflow(
        inputOf({
          draft: draftOf({
            tasks: [
              {
                type: 'agent',
                kind: 'transformer',
                taskId: 'producer',
                goal: 'P.',
                produces: [
                  { key: 'data', shape: { type: 'array' }, semantics: 'data' },
                  // Same key, different shape — silent last-one-wins would
                  // make inputContract derivation point at one shape while
                  // produces[] persists both. Reject loud at assemble time.
                  { key: 'data', shape: { type: 'object' }, semantics: 'data' },
                ],
              },
            ],
          }),
        }),
      ),
    ).toThrow(/duplicate produces\[\]\.key="data"/);
  });

  it('preserves providesPurposeId on a port', () => {
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({
          requiredDataSources: [{ purposeId: 'titanic-train', sourceKind: 'memory' }],
        }),
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'fetcher',
              taskId: 'fetch-titanic',
              goal: 'Fetch.',
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api' as const,
                      integrationId: 'x',
                      bindingId: 'x-d',
                      toolNames: ['get'],
                    },
                  ],
                  operations: [],
                },
              },
              produces: [
                {
                  key: 'rows',
                  shape: { type: 'array' },
                  semantics: 'data',
                  providesPurposeId: 'titanic-train',
                },
              ],
            },
          ],
        }),
      }),
    );
    const fetcher = out.workflow.tasks.find((t) => t.taskId === 'fetch-titanic')!;
    expect(fetcher.produces?.[0]?.providesPurposeId).toBe('titanic-train');
  });
});

// ============================================================================

describe('assembleWorkflow — Plan 123 C3 inputContract derivation', () => {
  it('derives inputContract for each consumer with the producer-port shape as the schema', () => {
    const portShape = {
      type: 'object',
      properties: { intent: { type: 'string' } },
      required: ['intent'],
    };
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'analyze-intent',
              goal: 'Analyze.',
              produces: [{ key: 'intent', shape: portShape, semantics: 'data' }],
            },
            {
              type: 'operation',
              taskId: 'prepare-design-surface',
              operationId: 'skill.compose.prepare_surface',
              consumes: [{ taskId: 'analyze-intent', outputKey: 'intent', bindAs: 'intent' }],
            },
          ],
        }),
      }),
    );
    const opIntentSchema = (
      toJsonSchemaSync(getOperation('skill.compose.prepare_surface')!.inputZod) as {
        properties: { intent: unknown };
      }
    ).properties.intent;
    const consumer = out.workflow.tasks.find((t) => t.taskId === 'prepare-design-surface')!;
    expect(consumer.inputContract).toBeDefined();
    expect(consumer.inputContract?.bindings.intent).toEqual({
      kind: 'task_output',
      bindAs: 'intent',
      taskId: 'analyze-intent',
      outputKey: 'intent',
      schema: opIntentSchema,
    });
  });

  it('omits inputContract on tasks with no inputBindings', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'standalone',
              goal: 'No upstream.',
              produces: [{ key: 'k', shape: { type: 'string' }, semantics: 'data' }],
            },
          ],
        }),
      }),
    );
    const standalone = out.workflow.tasks.find((t) => t.taskId === 'standalone')!;
    expect(standalone.inputContract).toBeUndefined();
  });

  it('throws when a binding references a producer port that does not exist (defense-in-depth)', () => {
    expect(() =>
      assembleWorkflow(
        inputOf({
          draft: draftOf({
            tasks: [
              {
                type: 'agent',
                kind: 'transformer',
                taskId: 'producer',
                goal: 'P.',
                produces: [{ key: 'realPort', shape: { type: 'object' }, semantics: 'data' }],
              },
              {
                type: 'operation',
                taskId: 'consumer',
                operationId: 'skill.compose.prepare_surface',
                consumes: [{ taskId: 'producer', outputKey: 'phantomPort', bindAs: 'x' }],
              },
            ],
          }),
        }),
      ),
    ).toThrow(/no matching produces\[\] entry was found/);
  });

  it('builds inputContract entries for both producer and consumer in a chain', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'a',
              goal: 'A.',
              produces: [{ key: 'k1', shape: { type: 'array' }, semantics: 'data' }],
            },
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'b',
              goal: 'B.',
              produces: [{ key: 'k2', shape: { type: 'object' }, semantics: 'data' }],
              consumes: [{ taskId: 'a', outputKey: 'k1', bindAs: 'aValue' }],
            },
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'c',
              goal: 'C.',
              consumes: [{ taskId: 'b', outputKey: 'k2', bindAs: 'bValue' }],
            },
          ],
        }),
      }),
    );
    const a = out.workflow.tasks.find((t) => t.taskId === 'a')!;
    const b = out.workflow.tasks.find((t) => t.taskId === 'b')!;
    const c = out.workflow.tasks.find((t) => t.taskId === 'c')!;
    expect(a.inputContract).toBeUndefined(); // no inputBindings
    expect(b.inputContract?.bindings.aValue?.kind).toBe('task_output');
    expect(c.inputContract?.bindings.bValue?.kind).toBe('task_output');
    if (c.inputContract?.bindings.bValue?.kind === 'task_output') {
      expect(c.inputContract.bindings.bValue.schema).toEqual({ type: 'object' });
    }
  });

  it('parses against ComposedWorkflowSchema with produces + inputContract present', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'a',
              goal: 'A.',
              produces: [{ key: 'k', shape: { type: 'string' }, semantics: 'data' }],
            },
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'b',
              goal: 'B.',
              consumes: [{ taskId: 'a', outputKey: 'k', bindAs: 'val' }],
            },
          ],
        }),
      }),
    );
    const result = ComposedWorkflowSchema.safeParse(out.workflow);
    if (!result.success) {
      throw new Error(`ComposedWorkflowSchema rejected output: ${result.error.message}`);
    }
  });
});

// ============================================================================
// Task type lowering
// ============================================================================

describe('assembleWorkflow — task type lowering', () => {
  it('lowers an operation task with operationId → workflow operation field', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'operation',
              taskId: 'store-result',
              operationId: 'memory.store.put',
            },
          ],
        }),
      }),
    );
    const op = out.workflow.tasks[0]!;
    expect(op.type).toBe('operation');
    expect(op.operation).toBe('memory.store.put');
  });

  it('lowers a human task with pauseInstruction', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'human',
              taskId: 'approve',
              pauseInstruction: 'Approve before continuing.',
            },
          ],
        }),
      }),
    );
    const human = out.workflow.tasks[0]!;
    expect(human.type).toBe('human');
    expect(human.pauseInstruction).toBe('Approve before continuing.');
  });

  it('lowers agent capabilities, setting allEndpoints/allTools to false (compose-skill output rule)', () => {
    const out = assembleWorkflow(
      inputOf({
        // Surface must list the github binding the agent grants — otherwise
        surface: {
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'github',
              bindingId: 'gh-acme',
              toolNames: ['repos.list'],
            },
          ],
          operations: [],
          policies: { compute: false },
          bindableButUnbound: [],
        },
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'fetcher',
              taskId: 'fetch',
              goal: 'g',
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api' as const,
                      integrationId: 'github',
                      bindingId: 'gh-acme',
                      toolNames: ['repos.list'],
                    },
                  ],
                  operations: ['memory.store.put'],
                },
              },
            },
          ],
        }),
      }),
    );
    const agent = out.workflow.tasks[0]!;
    const caps = agent.context?.capabilities;
    expect(caps?.integrations?.[0]?.allTools).toBe(false);
    expect(caps?.integrations?.[0]?.toolNames).toEqual([{ toolName: 'repos.list' }]);
    expect(caps?.operations).toEqual(['memory.store.put']);
  });
});

// ============================================================================
// pauseForUser injection
// ============================================================================

describe('assembleWorkflow — pauseForUser', () => {
  it('appends a human approval task when pauseForUser.needed is true and no human task exists', () => {
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({
          pauseForUser: { needed: true, when: 'before submission' },
        }),
        draft: draftOf({
          tasks: [{ type: 'agent', kind: 'transformer', taskId: 'do', goal: 'g' }],
        }),
      }),
    );
    expect(out.workflow.tasks).toHaveLength(2);
    const last = out.workflow.tasks[out.workflow.tasks.length - 1]!;
    expect(last.type).toBe('human');
    expect(last.pauseInstruction).toBe('before submission');
    expect(last.dependsOn).toEqual(['do']);
  });

  it('does not inject a human task when an APPROVAL-intent one already exists in the draft', () => {
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({ pauseForUser: { needed: true } }),
        draft: draftOf({
          tasks: [
            { type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g' },
            {
              type: 'human',
              taskId: 'approve',
              pauseInstruction: 'Approve.',
              intent: 'approve',
              dependsOn: ['a'],
            },
          ],
        }),
      }),
    );
    expect(out.workflow.tasks.filter((t) => t.type === 'human')).toHaveLength(1);
  });

  it('renames the auto-injected approval task to avoid a taskId collision (Plan 156 §7B PR #368 P2)', () => {
    // Regression for codex bot P2 on PR #368:
    //   If a draft already contains a `collect`-intent human task
    //   named `human-approval` (or any non-approval task with that
    //   id), the auto-inject must not produce a duplicate taskId —
    //   `validateWorkflowGraph` rejects duplicates and aborts
    //   compose-skill with an internal invariant error instead of
    //   yielding a proposal. The injection now suffixes a numeric
    //   counter (`human-approval-2`, `-3`, …) until the id is free.
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({ pauseForUser: { needed: true } }),
        draft: draftOf({
          tasks: [
            { type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g' },
            {
              // The operator chose `human-approval` as their typed-
              // question task id — same string the injection wants to
              // use. Pre-fix this collided; post-fix the injection
              // takes `human-approval-2`.
              type: 'human',
              taskId: 'human-approval',
              pauseInstruction: 'Which model variant?',
              intent: 'collect',
              dependsOn: ['a'],
            },
          ],
        }),
      }),
    );
    const ids = out.workflow.tasks.map((t) => t.taskId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    const humans = out.workflow.tasks.filter((t) => t.type === 'human');
    expect(humans).toHaveLength(2);
    expect(humans.find((t) => t.intent === 'collect')?.taskId).toBe('human-approval');
    expect(humans.find((t) => t.intent === 'approve')?.taskId).toBe('human-approval-2');
  });

  it('STILL injects the approval gate when only a COLLECT-intent human task exists (Plan 156 §7B review)', () => {
    // Regression for codex bot P1 on PR #368:
    //   A `collect`-intent human task (typed-input question) is NOT an
    //   approval gate. If the draft declares a typed question AND
    //   `intent.pauseForUser.needed` is true, the runtime must still
    //   get the approval pause — otherwise the workflow can land
    //   without the gate the intent declared.
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({
          pauseForUser: { needed: true, when: 'before submission' },
        }),
        draft: draftOf({
          tasks: [
            { type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g' },
            {
              type: 'human',
              taskId: 'pick-model',
              pauseInstruction: 'Which model?',
              intent: 'collect',
              dependsOn: ['a'],
            },
          ],
        }),
      }),
    );
    const humans = out.workflow.tasks.filter((t) => t.type === 'human');
    expect(humans).toHaveLength(2);
    // The injected one is the approval gate; the operator's collect
    // task stays where it was authored.
    const approval = humans.find((t) => t.intent === 'approve');
    expect(approval).toBeDefined();
    expect(approval?.pauseInstruction).toBe('before submission');
    const collect = humans.find((t) => t.intent === 'collect');
    expect(collect?.pauseInstruction).toBe('Which model?');
  });
});

// ============================================================================
// Defensive: missing matching produces[] (caught upstream by
// task-graph-self-consistent, but the assembler must fail clearly if it
// somehow reaches it).
// ============================================================================

describe('assembleWorkflow — defensive failures', () => {
  it('throws when consumes references a production that was not promoted', () => {
    expect(() =>
      assembleWorkflow(
        inputOf({
          draft: draftOf({
            tasks: [
              { type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g' },
              {
                type: 'agent',
                kind: 'transformer',
                taskId: 'b',
                goal: 'g',
                consumes: [{ taskId: 'a', outputKey: 'noSuchKey', bindAs: 'i' }],
              },
            ],
          }),
        }),
      ),
    ).toThrow(/no matching produces\[\] entry/);
  });
});

// ============================================================================

const kaggleSurface: DesignSurface = {
  integrations: [
    {
      sourceKind: 'api' as const,
      integrationId: 'kaggle-rest-api',
      bindingId: 'kaggle-prod',
      toolNames: ['datasets.fetch'],
    },
  ],
  operations: [],
  policies: { compute: false },
  bindableButUnbound: [],
};
const kaggleApiGrant = {
  sourceKind: 'api' as const,
  integrationId: 'kaggle-rest-api',
  bindingId: 'kaggle-prod',
  toolNames: ['datasets.fetch'],
};

// `assembleWorkflow — provenance attachment` describe block removed
// 2026-05-06 — runtime provenance gate dropped. The 5 tests below all
// pinned the auto-attachment of `validatorRefs:
// ['provenance-required', 'provenance-evidence-required']` and the
// `provenance` property on producer outputContracts. Both the validators
// and the assembler logic that attached them have been deleted; the

// ============================================================================

describe('assembleWorkflow — Plan 129 derived outputContract.schema', () => {
  it('case 3: produces[] only (not provenance-bearing) → strict derived schema', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'producer',
              goal: 'g',
              produces: [
                { key: 'data', shape: { type: 'object' }, semantics: 'data' },
                { key: 'metric', shape: { type: 'number' }, semantics: 'metric' },
              ],
            },
          ],
        }),
      }),
    );
    const oc = out.workflow.tasks[0]?.outputContract;
    expect(oc).toBeDefined();
    expect(oc?.validatorRefs).toBeUndefined();
    const schema = oc?.schema as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['data', 'metric']);
    const props = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['data', 'metric']);
    expect(props['data']).toEqual({ type: 'object' });
    expect(props['metric']).toEqual({ type: 'number' });
    expect(props['provenance']).toBeUndefined();
  });

  it('no ports → outputContract is undefined (legacy free-form lane)', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'free-form',
              goal: 'g',
              // No produces[].
            },
          ],
        }),
      }),
    );
    expect(out.workflow.tasks[0]?.outputContract).toBeUndefined();
  });

  it('downstream consumer with no produces[] of its own gets no contract (provenance gate removed)', () => {
    // Provenance gates removed 2026-05-06: a transitive consumer of a
    // labeled-source root no longer gets the legacy loose
    // `PROVENANCE_OUTPUT_CONTRACT_SCHEMA` because there is no longer a
    // contract to attach. Only `produces[]`-bearing tasks get a strict
    // derived schema. This pins that the consumer ends up with
    // `outputContract: undefined`.
    const out = assembleWorkflow(
      inputOf({
        intent: intentOf({
          requiredDataSources: [
            { purposeId: 'titanic-train', sourceKind: 'api', sourceId: 'kaggle-rest-api' },
          ],
        }),
        surface: kaggleSurface,
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'fetcher',
              taskId: 'fetch',
              goal: 'g',
              context: {
                capabilities: { integrations: [kaggleApiGrant], operations: [] },
              },
              produces: [
                {
                  key: 'rows',
                  shape: { type: 'array', items: { type: 'object' } },
                  semantics: 'data',
                  providesPurposeId: 'titanic-train',
                },
              ],
            },
            {
              // Transitive consumer with no produces[] of its own.
              type: 'agent',
              kind: 'transformer',
              taskId: 'consume',
              goal: 'g',
              consumes: [{ taskId: 'fetch', outputKey: 'rows', bindAs: 'data' }],
            },
          ],
        }),
      }),
    );
    const consumer = out.workflow.tasks.find((t) => t.taskId === 'consume')!;
    expect(consumer.outputContract).toBeUndefined();
  });
});

// ============================================================================

// ============================================================================
// Activation passthrough
// ============================================================================

describe('assembleWorkflow — activation passthrough', () => {
  it('passes draft.activation through verbatim when present', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          activation: {
            triggerPatterns: ['create skill'],
            activationHint: 'Use to create skills.',
            priority: 50,
          },
        }),
      }),
    );
    expect(out.activation?.triggerPatterns).toEqual(['create skill']);
  });

  it('omits activation entirely when absent', () => {
    const out = assembleWorkflow(inputOf({ draft: draftOf({}) }));
    expect(out.activation).toBeUndefined();
  });
});

// `end-to-end: provenance contract forces real-source emission` describe
// block removed 2026-05-06 — the runtime provenance gate it pinned
// (Ajv-rejects-`synthetic: true` + the `provenance-required` validator's

// ============================================================================

describe('assembleWorkflow — operation-task inputTemplate', () => {
  /**
   * Canonical templated op-task draft: an agent uploads + describes, the
   * templated `mcp.tool.call` builds the nested request. Ports feeding a
   * TEMPLATED op task must declare their shape (bindAs ≠ top-level op field,
   * so Phase D derivation is skipped).
   */
  function templatedDraft() {
    return draftOf({
      tasks: [
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'prepare',
          goal: 'Prepare the submission.',
          produces: [
            { key: 'token', shape: { type: 'string' }, semantics: 'data' },
            { key: 'description', shape: { type: 'string' }, semantics: 'data' },
          ],
        },
        {
          type: 'operation',
          taskId: 'finalize',
          operationId: 'mcp.tool.call',
          inputBindings: { competitionName: 'titanic' },
          consumes: [
            { taskId: 'prepare', outputKey: 'token', bindAs: 'blobToken' },
            { taskId: 'prepare', outputKey: 'description', bindAs: 'message' },
          ],
          inputTemplate: {
            serverId: 'kaggle',
            toolName: 'submit_to_competition',
            arguments: {
              request: {
                competitionName: { $bind: 'competitionName' },
                blobFileTokens: [{ $bind: 'blobToken' }],
                submissionDescription: { $bind: 'message' },
              },
            },
          },
        },
      ],
    });
  }

  it('lowers the draft inputTemplate verbatim onto the assembled task (round-trip)', () => {
    const out = assembleWorkflow(inputOf({ draft: templatedDraft() }));
    const finalize = out.workflow.tasks.find((t) => t.taskId === 'finalize')!;

    // Template verbatim; consumes lowered to runtime bindings; literal
    // draft inputBindings lowered to runtime `inputs` — so every `$bind`
    // reference survives lowering unchanged.
    expect(finalize.inputTemplate).toEqual({
      serverId: 'kaggle',
      toolName: 'submit_to_competition',
      arguments: {
        request: {
          competitionName: { $bind: 'competitionName' },
          blobFileTokens: [{ $bind: 'blobToken' }],
          submissionDescription: { $bind: 'message' },
        },
      },
    });
    expect(finalize.inputBindings).toEqual({
      blobToken: { kind: 'task_output', taskId: 'prepare', path: 'token' },
      message: { kind: 'task_output', taskId: 'prepare', path: 'description' },
    });
    expect(finalize.inputs).toEqual({ competitionName: 'titanic' });

    // The assembled workflow parses under the persisted-schema membrane and
    const parsed = ComposedWorkflowSchema.parse(out.workflow);
    expect(validateWorkflowGraph(parsed.tasks)).toEqual([]);
  });

  it('rejects a draft whose template $bind names no consumes[].bindAs or literal inputBindings key', () => {
    const draft = templatedDraft();
    const finalize = draft.tasks.find((t) => t.taskId === 'finalize')!;
    if (finalize.type === 'operation') {
      finalize.inputTemplate = { serverId: 'kaggle', toolName: 't', a: { $bind: 'ghost' } };
    }
    expect(() => assembleWorkflow(inputOf({ draft }))).toThrow(/ghost/);
  });

  it('a port consumed ONLY by a templated op task still requires an authored shape (no Phase D derivation)', () => {
    const draft = templatedDraft();
    const prepare = draft.tasks.find((t) => t.taskId === 'prepare')!;
    if (prepare.type === 'agent') {
      // Drop the shape — for a non-templated op consumer Phase D would derive
      // it; for a templated consumer it must be rejected at the draft schema.
      prepare.produces = prepare.produces.map((p) =>
        p.key === 'token' ? { key: p.key, semantics: p.semantics } : p,
      ) as typeof prepare.produces;
    }
    expect(() => assembleWorkflow(inputOf({ draft }))).toThrow(/declare its shape/);
  });

  it('omits inputTemplate on the lowered task when the draft has none', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'operation',
              taskId: 'plain-op',
              operationId: 'skill.compose.prepare_surface',
              inputBindings: { intent: { intent: 'x', iterationModel: 'process' } },
            },
          ],
        }),
      }),
    );
    const op = out.workflow.tasks.find((t) => t.taskId === 'plain-op')!;
    expect('inputTemplate' in op).toBe(false);
  });
});

// ============================================================================
// Optimization archetype (Plan 203) — the Kaggle-shaped dogfood
// ============================================================================

/**
 * A Kaggle-shaped optimization draft: iterate → approve → submit (unsafe) →
 * observe (poll + projection) → learn, with a campaign contract and a
 * `$campaign`-parameterized goal direction + target. Mirrors the hand-authored
 * `kaggle-competition-optimizer` shape that 203 must let compose-skill author.
 */
function kaggleShapedDraft(overrides: Partial<TaskGraphDraft> = {}): TaskGraphDraft {
  return draftOf({
    slug: 'kaggle-shaped-optimizer',
    name: 'Kaggle Shaped Optimizer',
    goal: 'Iterate toward a target leaderboard score.',
    // Optimization drafts omit outcomes — the assembler derives them.
    outcomes: [],
    tasks: [
      {
        type: 'agent',
        kind: 'transformer',
        taskId: 'execute',
        goal: 'Train a model in the sandbox and write submission.csv.',
        consumes: [{ campaignField: 'competitionSlug', bindAs: 'competitionSlug' }],
        produces: [{ key: 'submissionPath', shape: { type: 'string' }, semantics: 'data' }],
        context: { capabilities: { operations: ['compute.sandbox.exec'], integrations: [] } },
      },
      {
        type: 'human',
        taskId: 'approve-submit',
        intent: 'approve',
        pauseInstruction: 'Approve the Kaggle submission before it consumes daily quota.',
        dependsOn: ['execute'],
      },
      {
        type: 'operation',
        taskId: 'submit',
        operationId: 'api.http.call',
        dependsOn: ['approve-submit'],
        retryability: 'unsafe',
        maxAttempts: 3,
        consumes: [{ taskId: 'execute', outputKey: 'submissionPath', bindAs: 'submissionPath' }],
        inputTemplate: {
          apiId: 'kaggle',
          endpointId: 'submit_to_competition',
          params: { filePath: { $bind: 'submissionPath' } },
        },
      },
      {
        type: 'operation',
        taskId: 'poll-lb',
        operationId: 'api.http.call',
        dependsOn: ['submit'],
        consumes: [{ campaignField: 'competitionSlug', bindAs: 'competitionSlug' }],
        inputTemplate: {
          apiId: 'kaggle',
          endpointId: 'list_competition_submissions',
          params: { competitionName: { $bind: 'competitionSlug' } },
        },
        poll: {
          intervalMs: 60000,
          maxCycles: 5,
          until: { expression: "output.data[0].status == 'complete'" },
          onExhausted: 'complete',
        },
        outputProjection: {
          lbValue: { path: 'data[0].publicScore', parse: ['number'], onMissing: 'null' },
        },
        produces: [{ key: 'lbValue', shape: { type: ['number', 'null'] }, semantics: 'metric' }],
      },
    ],
    optimization: {
      goalMetric: {
        producedBy: { taskId: 'poll-lb', outputKey: 'lbValue' },
        direction: { $campaign: 'metricDirection' },
      },
      campaign: {
        fields: {
          competitionSlug: {
            schema: { type: 'string', minLength: 1 },
            identity: true,
            label: 'Competition slug',
          },
          metricDirection: {
            schema: { type: 'string', enum: ['minimize', 'maximize'] },
            label: 'Metric direction',
          },
          targetScore: { schema: { type: 'number' }, label: 'Target score' },
        },
      },
      target: { $campaign: 'targetScore' },
    },
    ...overrides,
  });
}

describe('assembleWorkflow — optimization archetype (Plan 203)', () => {
  function assembleKaggle(draft?: TaskGraphDraft) {
    return assembleWorkflow(
      inputOf({
        intent: intentOf({ iterationModel: 'optimization' }),
        draft: draft ?? kaggleShapedDraft(),
      }),
    );
  }

  it('derives stateVariables, promoteOutputs, threshold outcome, output, campaign + goal', () => {
    const out = assembleKaggle();

    // The assembled workflow itself is valid.
    expect(() => ComposedWorkflowSchema.parse(out.workflow)).not.toThrow();

    // stateVariables: the goal metric is promoted into run state.
    expect(out.workflow.stateVariables.map((v) => v.variableId)).toContain('lbValue');

    // promoteOutputs is injected on the observe task (never authored by the Runner).
    const pollTask = out.workflow.tasks.find((t) => t.taskId === 'poll-lb')!;
    expect(pollTask.promoteOutputs).toEqual([
      { kind: 'output_path', path: 'lbValue', toState: 'lbValue' },
    ]);

    // The threshold outcome targets the metric, with $campaign refs passed through.
    expect(out.workflow.outcomes).toHaveLength(1);
    const ev = out.workflow.outcomes[0]!.evaluator;
    expect(ev).toEqual({
      type: 'threshold',
      metric: 'lbValue',
      operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
      target: { $campaign: 'targetScore' },
    });

    // output.primary points at the metric.
    expect(out.workflow.output?.primary).toBe('lbValue');

    // Manifest-level derivations surfaced for skill.compose.propose.
    expect(out.campaign?.fields.competitionSlug?.identity).toBe(true);
    expect(out.goal).toEqual({
      type: 'numeric',
      metricKey: 'lbValue',
      direction: { $campaign: 'metricDirection' },
    });
  });

  it('lowers a campaign_field consume to a campaign_input binding (not a dependency)', () => {
    const out = assembleKaggle();
    const execute = out.workflow.tasks.find((t) => t.taskId === 'execute')!;
    expect(execute.inputBindings?.['competitionSlug']).toEqual({
      kind: 'campaign_input',
      path: 'competitionSlug',
    });
    // A campaign consume is NOT a task dependency.
    expect(execute.dependsOn ?? []).not.toContain('competitionSlug');
  });

  it('passes the optimization archetype-coherence validity check', () => {
    const out = assembleKaggle();
    const { validity } = materializeAndValidateSkillConfig({
      tasks: out.workflow.tasks,
      stateVariables: out.workflow.stateVariables,
      output: out.workflow.output,
      mode: out.workflow.mode,
      campaign: {
        contract: out.campaign,
        goal: out.goal,
        outcomes: out.workflow.outcomes,
      },
    });
    expect(validity.status).toBe('valid');
    // The Kaggle shape gates its unsafe submit behind an approval → no advisory.
    expect(validity.advisories.map((d) => d.code)).not.toContain(
      'optimization_side_effect_ungated',
    );
  });

  it('flags optimization_side_effect_ungated (advisory) when an unsafe op has no approval gate', () => {
    // Drop the approval gate; keep the unsafe submit.
    const draft = kaggleShapedDraft();
    draft.tasks = draft.tasks.filter((t) => t.taskId !== 'approve-submit');
    const submit = draft.tasks.find((t) => t.taskId === 'submit')!;
    if (submit.type === 'operation') submit.dependsOn = ['execute'];

    const out = assembleWorkflow(
      inputOf({ intent: intentOf({ iterationModel: 'optimization' }), draft }),
    );
    const { validity } = materializeAndValidateSkillConfig({
      tasks: out.workflow.tasks,
      stateVariables: out.workflow.stateVariables,
      output: out.workflow.output,
      mode: out.workflow.mode,
      campaign: { contract: out.campaign, goal: out.goal, outcomes: out.workflow.outcomes },
    });
    // Advisory does not block (still valid) but is surfaced.
    expect(validity.status).toBe('valid');
    expect(validity.advisories.map((d) => d.code)).toContain('optimization_side_effect_ungated');
  });

  // Dogfood regression: the Runner over-specified `target`/`direction` with an
  // empty `map: {}` on numeric/enum refs, which tripped campaign_ref_map_incomplete
  // and killed the run at validate-and-propose. The assembler now normalizes it.
  it('normalizes an over-specified empty $campaign map instead of failing validity', () => {
    const draft = kaggleShapedDraft({
      optimization: {
        goalMetric: {
          producedBy: { taskId: 'poll-lb', outputKey: 'lbValue' },
          direction: { $campaign: 'metricDirection', map: {} },
        },
        campaign: {
          fields: {
            competitionSlug: {
              schema: { type: 'string', minLength: 1 },
              identity: true,
              label: 'Competition slug',
            },
            metricDirection: {
              schema: { type: 'string', enum: ['minimize', 'maximize'] },
              label: 'Metric direction',
            },
            targetScore: { schema: { type: 'number' }, label: 'Target score' },
          },
        },
        target: { $campaign: 'targetScore', map: {} },
      },
    });

    const out = assembleWorkflow(
      inputOf({ intent: intentOf({ iterationModel: 'optimization' }), draft }),
    );
    const ev = out.workflow.outcomes[0]!.evaluator;
    if (ev.type !== 'threshold') throw new Error('expected threshold');
    // Empty map dropped → bare numeric ref; bare direction → default operator map.
    expect(ev.target).toEqual({ $campaign: 'targetScore' });
    expect(ev.operator).toEqual({
      $campaign: 'metricDirection',
      map: { maximize: 'gte', minimize: 'lte' },
    });

    const { validity } = materializeAndValidateSkillConfig({
      tasks: out.workflow.tasks,
      stateVariables: out.workflow.stateVariables,
      output: out.workflow.output,
      mode: out.workflow.mode,
      campaign: { contract: out.campaign, goal: out.goal, outcomes: out.workflow.outcomes },
    });
    expect(validity.status).toBe('valid');
    expect(validity.diagnostics.map((d) => d.code)).not.toContain('campaign_ref_map_incomplete');
  });
});

describe('assembleWorkflow — human task approves[] lowering', () => {
  it('derives dependsOn from approves and persists approves on the assembled task', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'train',
              goal: 'Train the model.',
              produces: [{ key: 'predictions', shape: { type: 'string' }, semantics: 'data' }],
            },
            {
              type: 'human',
              taskId: 'approve-submission',
              pauseInstruction: 'Review predictions and approve submission.',
              intent: 'approve',
              approves: ['train'],
              dependsOn: [],
            },
            {
              type: 'agent',
              kind: 'writeback',
              taskId: 'submit',
              goal: 'Submit to Kaggle.',
              dependsOn: ['approve-submission', 'train'],
              consumes: [{ taskId: 'train', outputKey: 'predictions', bindAs: 'predictions' }],
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api',
                      integrationId: 'kaggle',
                      bindingId: 'kaggle-default',
                      toolNames: ['submit'],
                    },
                  ],
                  operations: [],
                },
              },
            },
          ],
        }),
      }),
    );

    const approval = out.workflow.tasks.find((t) => t.taskId === 'approve-submission');
    expect(approval).toBeDefined();
    // approves derives dependsOn
    expect(approval!.dependsOn).toContain('train');
    // approves is persisted on the assembled task
    expect((approval as { approves?: string[] }).approves).toEqual(['train']);
  });

  it('produces a graph with no multiple_root_tasks when approves wires the ordering', () => {
    const out = assembleWorkflow(
      inputOf({
        draft: draftOf({
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'setup',
              goal: 'Setup.',
            },
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'train',
              goal: 'Train.',
              dependsOn: ['setup'],
            },
            {
              type: 'human',
              taskId: 'approve',
              pauseInstruction: 'Approve?',
              intent: 'approve',
              approves: ['train'],
            },
            {
              type: 'agent',
              kind: 'writeback',
              taskId: 'submit',
              goal: 'Submit.',
              dependsOn: ['approve', 'train'],
              consumes: [],
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api',
                      integrationId: 'kaggle',
                      bindingId: 'kaggle-default',
                      toolNames: ['submit'],
                    },
                  ],
                  operations: [],
                },
              },
            },
          ],
        }),
      }),
    );

    const graphErrors = validateWorkflowGraph(out.workflow.tasks);
    expect(graphErrors.some((e) => e.kind === 'multiple_root_tasks')).toBe(false);
    // only 'setup' is the root
    const roots = out.workflow.tasks.filter((t) => !t.dependsOn || t.dependsOn.length === 0);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.taskId).toBe('setup');
  });
});
