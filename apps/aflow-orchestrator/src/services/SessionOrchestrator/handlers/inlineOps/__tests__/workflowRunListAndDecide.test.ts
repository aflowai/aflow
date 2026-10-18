/**
 * Contract: `workflow.run.list` reads one bounded page of a workflow's runs
 * by one input, as the reading session, with its defaults applied; and
 * `workflow.run.decide` answers from its rules alone, refusing a rule outside
 * the grammar as the skill's to correct.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockListRunsByInput = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    listRunsByInput: (...args: unknown[]) => mockListRunsByInput(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: vi.fn(() => ({})) };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logOrchestratorError: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const SESSION = '99999999-2222-3333-4444-555555555555';

function args(operation: string, input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(input),
      store: vi.fn().mockResolvedValue('inline:stored='),
      shouldStore: () => false,
    } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: SESSION,
      traceId: 'trace-1',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: { stepId: 'op', stepType: 'workflow', operation, tags: [] } as never,
    stepExecutionId: 'step-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function result(): { status: string; output?: unknown; error?: { code?: string } } {
  const message = mockAddStepResult.mock.calls[0]![1] as {
    status: string;
    outputRef?: string;
    error?: { code?: string };
  };
  return {
    status: message.status,
    ...(message.outputRef?.startsWith('inline:')
      ? {
          output: JSON.parse(
            Buffer.from(message.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
          ) as unknown,
        }
      : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflow.run.list', () => {
  it('reads the runs in flight by default, as the reading session, and returns its page', async () => {
    const page = {
      runs: [{ id: 'r1', status: 'paused', startedAt: '2026-10-18T07:00:00.000Z', own: false }],
      hasMore: false,
    };
    mockListRunsByInput.mockResolvedValueOnce(page);
    await handleWorkflowCrudInline(
      args('workflow.run.list', {
        slug: 'publish-local-changes',
        input: { field: 'branch', equals: 'aflow/x' },
      }),
    );
    expect(mockListRunsByInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        query: {
          slug: 'publish-local-changes',
          input: { field: 'branch', equals: 'aflow/x' },
          status: ['running', 'paused'],
          limit: 25,
        },
      }),
    );
    expect(result()).toEqual({ status: 'SUCCEEDED', output: page });
  });

  it('refuses a page past 100 without reading', async () => {
    await handleWorkflowCrudInline(
      args('workflow.run.list', {
        slug: 'publish-local-changes',
        input: { field: 'branch', equals: 'aflow/x' },
        limit: 101,
      }),
    );
    expect(mockListRunsByInput).not.toHaveBeenCalled();
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: { code: 'WORKFLOW_RUN_LIST_INPUT_INVALID' },
    });
  });
});

describe('workflow.run.decide', () => {
  const otherwise = { decision: 'fix', reason: 'Nothing held back.' };

  it('answers with the first rule that holds', async () => {
    await handleWorkflowCrudInline(
      args('workflow.run.decide', {
        state: { checks: { state: 'pending' } },
        rules: [
          {
            when: { expression: "state.checks.state != 'failing'" },
            decision: 'wait',
            reason: 'Not red.',
          },
        ],
        otherwise,
      }),
    );
    expect(result()).toEqual({
      status: 'SUCCEEDED',
      output: { decision: 'wait', reason: 'Not red.', rule: 0 },
    });
  });

  it('fails a rule outside the grammar as the skill’s to correct', async () => {
    await handleWorkflowCrudInline(
      args('workflow.run.decide', {
        state: {},
        rules: [{ when: { expression: 'checks.state == 1' }, decision: 'wait', reason: 'x' }],
        otherwise,
      }),
    );
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: { code: 'WORKFLOW_RUN_DECIDE_RULE_INVALID' },
    });
  });
});
