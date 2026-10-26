import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillUsage, WorkflowPutInput } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const stored = new Map<string, string>();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    resolveCampaignManifestParams: vi.fn().mockResolvedValue(undefined),
    resolveSkillForWorkflow: vi.fn().mockResolvedValue(null),
    resolveCurrentSkillReadiness: vi.fn().mockResolvedValue({ status: 'ready' }),
    listActiveRunsForWorkflow: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: (path: string) => {
        const inlineContent = stored.get(path);
        return Promise.resolve(inlineContent ? { inlineContent } : null);
      },
      put: (doc: { path: string; inlineContent: string }) => {
        stored.set(doc.path, doc.inlineContent);
        return Promise.resolve({ id: 'doc-1', path: doc.path, currentVersion: 1 });
      },
    })),
    createMemoryDirRepository: vi.fn(() => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      ensureParentDirs: vi.fn().mockResolvedValue(undefined),
    })),
    resolveWorkflowForStart: (_db: unknown, _tenant: unknown, _space: unknown, slug: string) => {
      const inlineContent = stored.get(actual.workflowDocPath(slug));
      return Promise.resolve(inlineContent ? (JSON.parse(inlineContent) as unknown) : null);
    },
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
  addControlMessage: vi.fn(),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
}));

vi.mock('../../../../StepService/StepService.js', () => ({
  waitForInput: vi.fn().mockResolvedValue(undefined),
}));

import { handleWorkflowPut } from '../workflowCrud/create.js';
import { handleWorkflowGet } from '../workflowCrud/read.js';

const SLUG = 'triage-inbox';

function putInput(usage: unknown): WorkflowPutInput {
  return {
    slug: SLUG,
    writeMode: 'upsert',
    name: 'Triage inbox',
    description: 'Sort the inbox',
    ...(usage !== undefined ? { usage: usage as SkillUsage } : {}),
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'Done.' } }],
    mode: 'process',
    tasks: [{ taskId: 'triage', name: 'Triage', goal: 'Sort it', type: 'agent' }],
    stateVariables: [],
    status: 'draft',
  };
}

function makeArgs(): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(),
      store: vi.fn(),
      shouldStore: vi.fn().mockReturnValue(false),
    } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: '99999999-2222-3333-4444-555555555555',
      traceId: 'trace-1',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: { stepId: 'wf_op', stepType: 'workflow', operation: 'x', tags: [] } as never,
    stepExecutionId: 'step-exec-1' as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: 'inline:e30=',
    scheduledAtMs: Date.now(),
  };
}

function lastStepResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function lastOutputWorkflow(): Record<string, unknown> {
  const result = lastStepResult();
  expect(result['status']).toBe('SUCCEEDED');
  const ref = result['outputRef'] as string;
  const output = JSON.parse(
    Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'),
  ) as { workflow: Record<string, unknown> };
  return output.workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
});

describe('workflow.manage.put — usage', () => {
  it('persists the usage block, and workflow.manage.get reads it back', async () => {
    const usage = {
      whenToUse: ['A new message lands in the inbox'],
      next: [{ skill: 'reply-drafter', when: 'Once a message needs an answer' }],
      pitfalls: ['Never archive a flagged message'],
    };

    await handleWorkflowPut(makeArgs(), putInput(usage), Date.now());
    expect(lastStepResult()['status']).toBe('SUCCEEDED');

    const expected = { ...usage, whenNotToUse: [] };
    await handleWorkflowGet(makeArgs(), { slug: SLUG, view: 'invocation' } as never, Date.now());
    expect(lastOutputWorkflow()['usage']).toEqual(expected);

    await handleWorkflowGet(makeArgs(), { slug: SLUG } as never, Date.now());
    expect(lastOutputWorkflow()['usage']).toEqual(expected);
  });

  it('writes no usage when the put carries none', async () => {
    await handleWorkflowPut(makeArgs(), putInput(undefined), Date.now());
    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    const [doc] = [...stored.values()];
    expect(JSON.parse(doc!)).not.toHaveProperty('usage');
  });

  it('refuses a usage block WorkflowSchema would refuse, writing nothing', async () => {
    await handleWorkflowPut(
      makeArgs(),
      putInput({
        next: [{ skill: 'reply-drafter', operation: 'agent.schedule.create', when: 'a' }],
      }),
      Date.now(),
    );
    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as Record<string, unknown>)['code']).toBe('WORKFLOW_USAGE_INVALID');
    expect(stored.size).toBe(0);
  });
});
