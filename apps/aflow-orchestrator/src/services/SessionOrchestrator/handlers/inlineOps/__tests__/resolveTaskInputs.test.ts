import { describe, expect, it } from 'vitest';
import type { WorkflowRunDetail, WorkflowTaskRow } from '@aflow/cybernetic-runtime';
import type { ContractError, WorkflowTask } from '@aflow/schemas';
import { resolveTaskInputs, TaskInputResolutionError } from '../resolveTaskInputs.js';

const RUN_ID = 'run-test-1';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function makeTaskRow(
  overrides: Partial<WorkflowTaskRow> & Pick<WorkflowTaskRow, 'taskId'>,
): WorkflowTaskRow {
  return {
    id: `row-${overrides.taskId}`,
    runId: RUN_ID,
    taskId: overrides.taskId,
    status: overrides.status ?? 'succeeded',
    attempt: overrides.attempt ?? 1,
    sessionId: overrides.sessionId ?? null,
    workerSessionId: overrides.workerSessionId ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    durationMs: overrides.durationMs ?? null,
    costCents: overrides.costCents ?? null,
    metricsJson: overrides.metricsJson ?? null,
    summary: overrides.summary ?? null,
    failureReason: overrides.failureReason ?? null,
    outputRef: overrides.outputRef ?? null,
    reflectionJson: overrides.reflectionJson ?? null,
  };
}

function makeRun(rows: WorkflowTaskRow[]): WorkflowRunDetail {
  return {
    id: 'workflow-run-test',
    spaceId: 'space-test',
    workflowSlug: 'test-workflow',
    runId: RUN_ID,
    sessionId: null,
    status: 'running',
    workflowRevision: 1,
    startedAt: new Date(),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: {},
    tasks: rows,
  };
}

const baseOpTask = {
  taskId: 'consumer',
  type: 'operation' as const,
  operation: 'whatever.do.it',
  name: 'Consumer',
  goal: 'consume upstream data',
} as unknown as WorkflowTask;

describe('resolveTaskInputs — task_output bindings', () => {
  it('merges task.inputs with task_output bindings and unwraps childOutput envelope', async () => {
    const task = {
      ...baseOpTask,
      inputs: { extra: 1 },
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
      },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({
        taskId: 'analyze-intent',
        outputRef: inlineRef({
          childSessionId: 's',
          status: 'SUCCEEDED',
          childOutput: { intent: 'X', iterationModel: 'process' },
        }),
      }),
    ]);

    const result = await resolveTaskInputs(task, { run });

    expect(result['extra']).toBe(1);
    expect(result['intent']).toEqual({ intent: 'X', iterationModel: 'process' });
  });

  it('honors a sub-path', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: {
        v: { kind: 'task_output', taskId: 'upstream', path: 'nested.value' },
      },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({
        taskId: 'upstream',
        outputRef: inlineRef({ childOutput: { nested: { value: 42 } } }),
      }),
    ]);

    const result = await resolveTaskInputs(task, { run });
    expect(result['v']).toBe(42);
  });

  it('throws when the upstream task is missing', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { v: { kind: 'task_output', taskId: 'missing' } },
    } as WorkflowTask;
    const run = makeRun([]);

    await expect(resolveTaskInputs(task, { run })).rejects.toBeInstanceOf(TaskInputResolutionError);
    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/does not exist in run/);
  });

  it('throws when the upstream output is unavailable', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { v: { kind: 'task_output', taskId: 'upstream' } },
    } as WorkflowTask;
    const run = makeRun([makeTaskRow({ taskId: 'upstream', status: 'failed', outputRef: null })]);

    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/output is unavailable/);
  });

  it('rejects a non-inline outputRef when no payloadStore is in scope (round-6 P1 fail-loud)', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { v: { kind: 'task_output', taskId: 'upstream' } },
    } as WorkflowTask;
    const run = makeRun([makeTaskRow({ taskId: 'upstream', outputRef: 'redis:some-key:abc' })]);
    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/requires a PayloadStore/);
  });

  it('resolves a non-inline outputRef via PayloadStore', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { v: { kind: 'task_output', taskId: 'upstream' } },
    } as WorkflowTask;
    const run = makeRun([makeTaskRow({ taskId: 'upstream', outputRef: 'redis:some-key:abc' })]);
    const fakeStore = {
      retrieve: async (ref: string) => {
        if (ref === 'redis:some-key:abc') {
          return { childOutput: { value: 'from-redis' } };
        }
        return null;
      },
    } as unknown as import('@aflow/payload-store').PayloadStore;
    const result = await resolveTaskInputs(task, { run, payloadStore: fakeStore });
    expect(result['v']).toEqual({ value: 'from-redis' });
  });
});

describe('resolveTaskInputs — task_summary bindings', () => {
  it('returns the upstream summary string', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { summary: { kind: 'task_summary', taskId: 'upstream' } },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({ taskId: 'upstream', summary: 'all good — committed 12 files' }),
    ]);

    const result = await resolveTaskInputs(task, { run });
    expect(result['summary']).toBe('all good — committed 12 files');
  });

  it('throws when the upstream task has no summary', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { summary: { kind: 'task_summary', taskId: 'upstream' } },
    } as WorkflowTask;
    const run = makeRun([makeTaskRow({ taskId: 'upstream', summary: null })]);

    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/has no summary/);
  });
});

describe('resolveTaskInputs — run_input bindings', () => {
  it('reads a path from the run input snapshot', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { goal: { kind: 'run_input', path: 'goal' } },
    } as WorkflowTask;
    const run = makeRun([]);

    const result = await resolveTaskInputs(task, {
      run,
      runInput: { goal: 'optimize lead scoring', context: { since: '2026-01' } },
    });

    expect(result['goal']).toBe('optimize lead scoring');
  });

  it('throws when run_input is requested but not provided', async () => {
    const task = {
      ...baseOpTask,
      inputBindings: { goal: { kind: 'run_input', path: 'goal' } },
    } as WorkflowTask;
    const run = makeRun([]);

    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/no run_input is available/);
  });
});

describe('resolveTaskInputs — campaign_input bindings (Plan 195 §4.4)', () => {
  const task = {
    ...baseOpTask,
    inputBindings: { competitionSlug: { kind: 'campaign_input', path: 'competitionSlug' } },
  } as WorkflowTask;

  it('reads a path from the campaign config', async () => {
    const result = await resolveTaskInputs(task, {
      run: makeRun([]),
      campaignConfig: { competitionSlug: 'titanic', targetScore: 0.8 },
    });

    expect(result['competitionSlug']).toBe('titanic');
  });

  it('throws the no-campaign teaching error when campaignConfig is absent', async () => {
    await expect(resolveTaskInputs(task, { run: makeRun([]) })).rejects.toThrow(
      /no campaign config is available .* the run has no campaign bound/,
    );
  });

  it('throws a field-naming error when the config lacks the field', async () => {
    await expect(
      resolveTaskInputs(task, {
        run: makeRun([]),
        campaignConfig: { targetScore: 0.8 },
      }),
    ).rejects.toThrow(/no value at "competitionSlug".*declared: targetScore/);
  });

  it('a config-less campaign ({}) fails on the named field, not on "no campaign"', async () => {
    await expect(resolveTaskInputs(task, { run: makeRun([]), campaignConfig: {} })).rejects.toThrow(
      /no value at "competitionSlug"/,
    );
  });
});

describe('resolveTaskInputs — system_feedback bindings (Plan 123 §5.2)', () => {
  const taskWithFeedbackBinding = {
    ...baseOpTask,
    inputBindings: { system_feedback: { kind: 'system_feedback' } },
  } as WorkflowTask;

  it('omits the system_feedback property entirely on first execution (Plan 123 §3.2)', async () => {
    // Absent property — not present-but-undefined. This lets the assemble-time
    // TaskInputContract list system_feedback outside `required[]` so JSON
    // Schema validation in C4 passes without phase-aware special-casing.
    const run = makeRun([]);
    const result = await resolveTaskInputs(taskWithFeedbackBinding, { run });
    expect('system_feedback' in result).toBe(false);
  });

  it('exposes the typed ContractError when the orchestrator populates it on rerun', async () => {
    const run = makeRun([]);
    const feedback: ContractError = {
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId: 'validate-source-coverage',
      contractName: 'draft',
      source: {
        kind: 'binding',
        bindAs: 'draft',
        producerTaskId: 'draft-task-graph',
      },
      expectedSchema: { type: 'object' },
      blame: 'producer-contract',
      zodIssues: [],
    };

    const result = await resolveTaskInputs(taskWithFeedbackBinding, {
      run,
      systemFeedback: feedback,
    });

    expect(result['system_feedback']).toEqual(feedback);
  });
});

describe('resolveTaskInputs — connection_binding bindings (Plan 222 P3)', () => {
  // The realistic shape: a github api.http.call task whose `bindingId` is
  // populated from the run's pinned connection via an inputTemplate $bind.
  const githubTask = {
    ...baseOpTask,
    operation: 'api.http.call',
    inputBindings: { githubConnection: { kind: 'connection_binding' } },
    inputTemplate: {
      apiId: 'github',
      endpointId: 'list_repos',
      bindingId: { $bind: 'githubConnection' },
    },
  } as WorkflowTask;

  it('populates the inputTemplate bindingId $bind with the pinned connection', async () => {
    const result = await resolveTaskInputs(githubTask, {
      run: makeRun([]),
      connectionBindingId: 'gh-conn-7',
    });

    expect(result).toEqual({
      apiId: 'github',
      endpointId: 'list_repos',
      bindingId: 'gh-conn-7',
    });
  });

  it('THROWS when the pin is absent — never a silent omit / no-bindingId op input', async () => {
    // The load-bearing guard: returning ABSENT would let substituteTemplateBinds
    // OMIT the bindingId node, so the api executor scope-resolves an arbitrary
    // github account. The resolver must fail closed instead.
    await expect(resolveTaskInputs(githubTask, { run: makeRun([]) })).rejects.toBeInstanceOf(
      TaskInputResolutionError,
    );
    await expect(resolveTaskInputs(githubTask, { run: makeRun([]) })).rejects.toThrow(
      /no connection is pinned/,
    );
  });

  it('THROWS on an empty-string pin too (every falsy value fails closed)', async () => {
    // An empty pin would resolve to `''`, which the api executor treats as "no
    // hint" → scope-resolution. The guard rejects every falsy value, not just undefined.
    await expect(
      resolveTaskInputs(githubTask, { run: makeRun([]), connectionBindingId: '' }),
    ).rejects.toBeInstanceOf(TaskInputResolutionError);
  });

  it('resolves to the raw bindingId when consumed flatly (no template)', async () => {
    const flatTask = {
      ...baseOpTask,
      inputBindings: { githubConnection: { kind: 'connection_binding' } },
    } as WorkflowTask;

    const result = await resolveTaskInputs(flatTask, {
      run: makeRun([]),
      connectionBindingId: 'gh-conn-9',
    });
    expect(result['githubConnection']).toBe('gh-conn-9');
  });
});

describe('resolveTaskInputs — learning_set bindings', () => {
  const RENDERED_BLOCK =
    '- [trajectory] objective: minimize rmsle; peak so far: 0.128; recent scores: 0.131, 0.128\n' +
    '- [worked] log-transform the target → keep it';

  it('resolves to the rendered block, threading the CONSUMING task id to the resolver', async () => {
    const seenTaskIds: string[] = [];
    const codeTask = {
      ...baseOpTask,
      operation: 'code.agent.run',
      inputBindings: {
        learnings: { kind: 'learning_set' },
      },
      inputTemplate: {
        repo: 'acme/site',
        task: { instructions: { $bind: 'learnings' } },
      },
    } as WorkflowTask;

    const result = await resolveTaskInputs(codeTask, {
      run: makeRun([]),
      resolveLearningSet: async ({ taskId }) => {
        seenTaskIds.push(taskId);
        return RENDERED_BLOCK;
      },
    });

    expect(seenTaskIds).toEqual(['consumer']);
    expect(result).toEqual({
      repo: 'acme/site',
      task: { instructions: RENDERED_BLOCK },
    });
  });

  it('resolves the empty set to an empty string (present, never omitted)', async () => {
    const flatTask = {
      ...baseOpTask,
      inputBindings: { learnings: { kind: 'learning_set' } },
    } as WorkflowTask;

    const result = await resolveTaskInputs(flatTask, {
      run: makeRun([]),
      resolveLearningSet: async () => '',
    });

    expect(result['learnings']).toBe('');
    expect(Object.prototype.hasOwnProperty.call(result, 'learnings')).toBe(true);
  });

  it('THROWS when the caller supplies no resolver — wiring gap, never a silent omit', async () => {
    const flatTask = {
      ...baseOpTask,
      inputBindings: { learnings: { kind: 'learning_set' } },
    } as WorkflowTask;

    await expect(resolveTaskInputs(flatTask, { run: makeRun([]) })).rejects.toBeInstanceOf(
      TaskInputResolutionError,
    );
    await expect(resolveTaskInputs(flatTask, { run: makeRun([]) })).rejects.toThrow(
      /resolveLearningSet/,
    );
  });
});

describe('resolveTaskInputs — no bindings short-circuit', () => {
  it('returns task.inputs untouched when no bindings are declared', async () => {
    const task = {
      ...baseOpTask,
      inputs: { foo: 'bar' },
    } as WorkflowTask;
    const run = makeRun([]);

    const result = await resolveTaskInputs(task, { run });
    expect(result).toEqual({ foo: 'bar' });
    expect(result).not.toBe(task.inputs); // defensive copy
  });
});

describe('resolveTaskInputs — artifact_binding (Plan 158 §4.3 / 5b)', () => {
  // The skill workflow's terminal render-card task carries:
  //   inputBindings: { artifactId: { kind: 'artifact_binding', bundleId, bindingId } }
  // The orchestrator-side caller (taskHelpers) binds
  // `ctx.resolveArtifactBinding` to the cached resolver; tests stub it
  // directly so the resolver tree stays db-free.
  const taskWithBinding = {
    ...baseOpTask,
    operation: 'ui.artifact.render',
    inputBindings: {
      artifactId: {
        kind: 'artifact_binding',
        bundleId: 'alpaca-portfolio-companion',
        bindingId: 'portfolio-review-card',
      },
    },
  } as WorkflowTask;

  it('resolves to the artifactId UUID returned by the callback', async () => {
    const run = makeRun([]);
    const result = await resolveTaskInputs(taskWithBinding, {
      run,
      resolveArtifactBinding: async ({ bundleId, bindingId }) => {
        expect(bundleId).toBe('alpaca-portfolio-companion');
        expect(bindingId).toBe('portfolio-review-card');
        return {
          artifactId: '00000000-0000-0000-0000-000000000042',
          bundleArtifactKey: 'alpaca:portfolio-review-card',
          currentVersion: 1,
          enabled: true,
        };
      },
    });
    expect(result['artifactId']).toBe('00000000-0000-0000-0000-000000000042');
  });

  it('throws when no resolveArtifactBinding callback is wired (caller gap, fail-loud)', async () => {
    const run = makeRun([]);
    await expect(resolveTaskInputs(taskWithBinding, { run })).rejects.toBeInstanceOf(
      TaskInputResolutionError,
    );
    await expect(resolveTaskInputs(taskWithBinding, { run })).rejects.toThrow(
      /requires resolveArtifactBinding in ctx/,
    );
  });

  it('throws when the binding row is missing — bundle uninstalled or bindingId drift', async () => {
    const run = makeRun([]);
    await expect(
      resolveTaskInputs(taskWithBinding, {
        run,
        resolveArtifactBinding: async () => null,
      }),
    ).rejects.toThrow(/no matching row in artifact_bindings/);
  });

  it('throws when the binding is disabled (operator off-switch)', async () => {
    const run = makeRun([]);
    await expect(
      resolveTaskInputs(taskWithBinding, {
        run,
        resolveArtifactBinding: async () => ({
          artifactId: '00000000-0000-0000-0000-000000000042',
          bundleArtifactKey: 'alpaca:portfolio-review-card',
          currentVersion: 1,
          enabled: false,
        }),
      }),
    ).rejects.toThrow(/is disabled on artifact_bindings.enabled/);
  });

  it('composes cleanly with task_output bindings — render-card pulls both artifactId and data', async () => {
    // The canonical Phase 5b shape: terminal `render-card` task has
    // BOTH an artifact_binding (artifactId) and a task_output (data
    // pulled from an upstream synthesize task's structured output).
    const task = {
      ...baseOpTask,
      operation: 'ui.artifact.render',
      inputBindings: {
        artifactId: {
          kind: 'artifact_binding',
          bundleId: 'alpaca-portfolio-companion',
          bindingId: 'portfolio-review-card',
        },
        data: { kind: 'task_output', taskId: 'synthesize-report', path: 'cardData' },
      },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({
        taskId: 'synthesize-report',
        outputRef: inlineRef({
          reportPath: 'reports/2026-05-23-portfolio-review.md',
          reportSummary: { positionCount: 2, policyCompliant: true, flagCount: 0 },
          cardData: {
            account: { cash: 1500, equity: 12000 },
            positions: [{ symbol: 'AAPL', qty: 50 }],
            snapshots: { AAPL: { latestPrice: 185 } },
            summary: { positionCount: 2 },
          },
        }),
      }),
    ]);

    const result = await resolveTaskInputs(task, {
      run,
      resolveArtifactBinding: async () => ({
        artifactId: '00000000-0000-0000-0000-000000000042',
        bundleArtifactKey: 'alpaca:portfolio-review-card',
        currentVersion: 1,
        enabled: true,
      }),
    });

    expect(result['artifactId']).toBe('00000000-0000-0000-0000-000000000042');
    expect(result['data']).toEqual({
      account: { cash: 1500, equity: 12000 },
      positions: [{ symbol: 'AAPL', qty: 50 }],
      snapshots: { AAPL: { latestPrice: 185 } },
      summary: { positionCount: 2 },
    });
  });
});

// ---------------------------------------------------------------------------

describe('resolveTaskInputs — inputTemplate', () => {
  it('deep-substitutes resolved bindings into nested objects and arrays (Kaggle finalize shape)', async () => {
    const task = {
      ...baseOpTask,
      operation: 'mcp.tool.call',
      inputs: { competitionName: 'titanic' },
      inputBindings: {
        blobToken: { kind: 'task_output', taskId: 'upload', path: 'token' },
        message: { kind: 'task_output', taskId: 'prepare', path: 'description' },
      },
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
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({ taskId: 'upload', outputRef: inlineRef({ token: 'tok-123' }) }),
      makeTaskRow({ taskId: 'prepare', outputRef: inlineRef({ description: 'v9 ensemble' }) }),
    ]);

    const result = await resolveTaskInputs(task, { run });

    // The op input is EXACTLY the substituted template — no flat bindAs keys.
    expect(result).toEqual({
      serverId: 'kaggle',
      toolName: 'submit_to_competition',
      arguments: {
        request: {
          competitionName: 'titanic',
          blobFileTokens: ['tok-123'],
          submissionDescription: 'v9 ensemble',
        },
      },
    });
    expect('blobToken' in result).toBe(false);
  });

  it('omits object properties and array elements bound to a skipped upstream (ABSENT)', async () => {
    const task = {
      ...baseOpTask,
      operation: 'mcp.tool.call',
      inputBindings: {
        token: { kind: 'task_output', taskId: 'upload', path: 'token' },
        note: { kind: 'task_output', taskId: 'skipped-branch', path: 'note' },
      },
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit',
        arguments: {
          note: { $bind: 'note' },
          tokens: [{ $bind: 'token' }, { $bind: 'note' }],
        },
      },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({ taskId: 'upload', outputRef: inlineRef({ token: 't1' }) }),
      makeTaskRow({ taskId: 'skipped-branch', status: 'skipped' }),
    ]);

    const result = await resolveTaskInputs(task, { run });

    expect(result).toEqual({
      serverId: 'kaggle',
      toolName: 'submit',
      arguments: { tokens: ['t1'] },
    });
  });

  it('a binding-less template of pure literals is returned as-is (nested literal construction)', async () => {
    const task = {
      ...baseOpTask,
      operation: 'mcp.tool.call',
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'list_competitions',
        arguments: { request: { page: 1 } },
      },
    } as WorkflowTask;

    const result = await resolveTaskInputs(task, { run: makeRun([]) });
    expect(result).toEqual({
      serverId: 'kaggle',
      toolName: 'list_competitions',
      arguments: { request: { page: 1 } },
    });
  });

  it('an unknown $bind throws TaskInputResolutionError (fail loud, never guess)', async () => {
    const task = {
      ...baseOpTask,
      operation: 'mcp.tool.call',
      inputs: { known: 1 },
      inputTemplate: { serverId: 'k', toolName: 't', arguments: { a: { $bind: 'ghost' } } },
    } as WorkflowTask;

    await expect(resolveTaskInputs(task, { run: makeRun([]) })).rejects.toThrow(
      TaskInputResolutionError,
    );
    await expect(resolveTaskInputs(task, { run: makeRun([]) })).rejects.toThrow(/ghost/);
  });

  it('a root bind node resolving to a non-object throws (op inputs are objects)', async () => {
    const task = {
      ...baseOpTask,
      operation: 'mcp.tool.call',
      inputBindings: {
        whole: { kind: 'task_output', taskId: 'upstream', path: 'scalar' },
      },
      inputTemplate: { $bind: 'whole' },
    } as WorkflowTask;
    const run = makeRun([
      makeTaskRow({ taskId: 'upstream', outputRef: inlineRef({ scalar: 'just-a-string' }) }),
    ]);

    await expect(resolveTaskInputs(task, { run })).rejects.toThrow(/must be a JSON object/);
  });

  it('without a template, flat assembly is unchanged (template strictly additive)', async () => {
    const task = {
      ...baseOpTask,
      inputs: { literal: 'x' },
      inputBindings: {
        v: { kind: 'task_output', taskId: 'upstream', path: 'value' },
      },
    } as WorkflowTask;
    const run = makeRun([makeTaskRow({ taskId: 'upstream', outputRef: inlineRef({ value: 42 }) })]);

    const result = await resolveTaskInputs(task, { run });
    expect(result).toEqual({ literal: 'x', v: 42 });
  });
});
