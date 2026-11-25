import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();
const mockDocPut = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(async () => null),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: () => ({ put: (...args: unknown[]) => mockDocPut(...args) }),
    createMemoryDirRepository: () => ({ ensureParentDirs: async () => undefined }),
  };
});

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, checkMissingCapabilities: async () => [] };
});

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** A one-task skill whose model is asked to copy documents and judge nothing. */
const COPY_SKILL = {
  slug: 'note-copier',
  name: 'Note Copier',
  goal: 'Gather the notes.',
  mode: 'process',
  status: 'approved',
  outcomes: [
    {
      id: 'notes-read',
      name: 'Notes read',
      evaluator: { type: 'manual', instruction: 'The notes were read.' },
    },
  ],
  tasks: [
    {
      taskId: 'read-notes',
      name: 'Read the notes',
      type: 'agent',
      goal: 'Copy each note under /notes/ from memory into your output, verbatim.',
      outputContract: {
        schema: {
          type: 'object',
          required: ['notes'],
          properties: { notes: { type: 'array', items: { type: 'string' } } },
        },
      },
      context: {
        strategy: 'scoped',
        capabilities: { operations: ['memory.store.get', 'memory.store.query'] },
      },
    },
  ],
};

function makeArgs(): InlineHandlerArgs {
  const stepDef = {
    stepId: 'wf_task__validate-and-propose__execute__a1',
    stepType: 'skill',
    operation: 'skill.compose.propose',
    config: {},
    tags: ['dynamic', '_taskId:validate-and-propose'],
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;
  const opInput = { assembled: { workflow: COPY_SKILL } };
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: '11111111-1111-4111-8111-111111111111',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      traceId: 'trace-1',
      agentDefinition: { steps: [stepDef] },
    } as never,
    stepDef,
    stepExecutionId: 'step-exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: `inline:${Buffer.from(JSON.stringify(opInput)).toString('base64')}`,
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

describe('skill.compose.propose — design pitfalls warn and never block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proposes a skill with a model copy task and names the pitfall in its output', async () => {
    const { handleSkillComposeInline } = await import('../skillCompose.js');
    await handleSkillComposeInline(makeArgs());

    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    expect(mockDocPut).toHaveBeenCalledTimes(1);
    const output = decodeInline(msg.outputRef);
    expect(output['status']).toBe('proposed');
    const advisories = output['advisories'] as Array<Record<string, unknown>>;
    expect(advisories).toContainEqual(
      expect.objectContaining({
        code: 'model_copy_task',
        severity: 'advisory',
        taskId: 'read-notes',
      }),
    );
  });
});
