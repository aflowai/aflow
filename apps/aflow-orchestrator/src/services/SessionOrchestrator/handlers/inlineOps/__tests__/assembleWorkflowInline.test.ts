import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepDefinition, StepExecutionId, IdempotencyKey } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';

// emitStepSuccess → addStepResult(redis, ...); capture it. Everything else
// (assembleWorkflow, deriveOpBoundDraftPortShapes) runs for real.
const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
}));

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}
function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const OPTIMIZATION_INPUT = {
  intent: {
    intent: 'optimize a score',
    iterationModel: 'optimization',
    requiredCapabilities: [],
    requiredDataSources: [],
    taskShapeHints: [],
    pauseForUser: { needed: false },
  },
  surface: {
    integrations: [],
    operations: [],
    policies: { compute: true },
    bindableButUnbound: [],
  },
  draft: {
    slug: 'opt-skill',
    name: 'Opt Skill',
    description: 'd',
    goal: 'g',
    // Optimization drafts omit outcomes — the assembler derives them.
    outcomes: [],
    optimization: {
      goalMetric: {
        producedBy: { taskId: 'observe', outputKey: 'score' },
        direction: { $campaign: 'dir' },
      },
      campaign: {
        fields: {
          slug: { schema: { type: 'string' }, identity: true, label: 'Slug' },
          dir: { schema: { type: 'string', enum: ['maximize', 'minimize'] }, label: 'Dir' },
          tgt: { schema: { type: 'number' }, label: 'Target' },
        },
      },
      target: { $campaign: 'tgt' },
    },
    tasks: [
      {
        type: 'agent',
        kind: 'fetcher',
        taskId: 'observe',
        goal: 'observe the score',
        consumes: [{ campaignField: 'slug', bindAs: 'slug' }],
        produces: [{ key: 'score', shape: { type: 'number' }, semantics: 'metric' }],
        context: {
          capabilities: {
            operations: [],
            integrations: [
              { sourceKind: 'api', integrationId: 'x', bindingId: 'b', toolNames: ['t'] },
            ],
          },
        },
      },
    ],
  },
};

function makeArgs(opInput: unknown) {
  const stepDef = {
    stepId: 'wf_task__assemble-workflow__execute__a1',
    stepType: 'skill',
    operation: 'skill.compose.assemble_workflow',
    config: {},
    tags: ['dynamic', '_taskId:assemble-workflow'],
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: '11111111-1111-4111-8111-111111111111',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      traceId: 'trace-1',
      agentDefinition: { steps: [stepDef] },
    },
    stepDef,
    stepExecutionId: 'step-exec-1' as StepExecutionId,
    idempotencyKey: 'idemp-1' as IdempotencyKey,
    resolvedInputRef: inlineRef(opInput),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

describe('handleAssembleWorkflowInline — emit forwards optimization manifest fields (Plan 203/206)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('forwards campaign + goal in the step output so propose can author the manifest', async () => {
    const { handleAssembleWorkflowInline } = await import('../assembleWorkflow.js');
    await handleAssembleWorkflowInline(makeArgs(OPTIMIZATION_INPUT) as never);

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = decodeInline(result.outputRef);
    // The exact gap that failed every optimization compose at propose: the
    // inline handler dropped these, so the manifest had no campaign + a
    // subjective goal, tripping the propose-time archetype check.
    expect(output['campaign']).toBeDefined();
    expect(output['goal']).toEqual({
      type: 'numeric',
      metricKey: 'score',
      direction: { $campaign: 'dir' },
    });
  });

  it('omits campaign + goal for a process (non-optimization) skill', async () => {
    const processInput = {
      ...OPTIMIZATION_INPUT,
      intent: { ...OPTIMIZATION_INPUT.intent, iterationModel: 'process' },
      draft: {
        slug: 'proc-skill',
        name: 'Proc',
        description: 'd',
        goal: 'g',
        outcomes: [{ id: 'p', name: 'P', evaluator: { type: 'manual', instruction: 'x' } }],
        tasks: [{ type: 'agent', kind: 'transformer', taskId: 'main', goal: 'do it' }],
      },
    };
    const { handleAssembleWorkflowInline } = await import('../assembleWorkflow.js');
    await handleAssembleWorkflowInline(makeArgs(processInput) as never);

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = decodeInline(result.outputRef);
    expect(output['campaign']).toBeUndefined();
    expect(output['goal']).toBeUndefined();
  });
});
