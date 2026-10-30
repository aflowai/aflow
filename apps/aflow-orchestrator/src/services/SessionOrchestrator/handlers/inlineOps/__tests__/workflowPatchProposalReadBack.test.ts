import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { Workflow } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

/**
 * A patch must return a proposal id that proposal.get reads back. The store
 * here holds documents in memory, keyed by space and path, so the write and
 * the read meet the same bytes the database would hold.
 */
interface StoredDoc {
  inlineContent: string | null;
  deletedAt: Date | null;
}
const store = new Map<string, StoredDoc>();
const key = (spaceId: string, path: string) => `${spaceId}|${path}`;

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: async (path: string, spaceId: string) => {
        const doc = store.get(key(spaceId, path));
        return doc && !doc.deletedAt ? { id: path, path, ...doc } : null;
      },
      put: async (params: {
        path: string;
        inlineContent: string;
        writeMode: string;
        scope: { spaceId: string };
      }) => {
        const k = key(params.scope.spaceId, params.path);
        if (params.writeMode === 'create' && store.has(k)) throw new Error('exists');
        store.set(k, { inlineContent: params.inlineContent, deletedAt: null });
        return { id: params.path, path: params.path, currentVersion: 1 };
      },
    })),
    createMemoryDirRepository: vi.fn(() => ({ ensureParentDirs: vi.fn(), mkdir: vi.fn() })),
    workflowDirPath: (slug: string) => `/workflows/${slug}`,
    workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
  };
});

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    loadProposalValidationSnapshot: vi.fn(async () => ({ apiBindings: [], mcpBindings: [] })),
    listActiveRuns: vi.fn(async () => []),
    resolveCampaignManifestParams: vi.fn(async () => undefined),
    resolveSkillForWorkflow: vi.fn(async () => null),
    createStagedChangeDocReader: () => ({
      getByPath: async (path: string, spaceId: string) => store.get(key(spaceId, path)) ?? null,
    }),
    // The conversation store: DELEGATE is a session the conversation RUN_ID delegated to.
    loadConversationLookup: vi.fn(async () => ({
      sessions: new Map([
        [
          RUN_ID,
          { sessionId: RUN_ID, parentSessionId: null, title: 'Storm warnings', manualTitle: null },
        ],
        [
          DELEGATE,
          { sessionId: DELEGATE, parentSessionId: RUN_ID, title: null, manualTitle: null },
        ],
      ]),
      runSessions: new Map(),
    })),
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  appendEntityEvent: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';
import { handleProposalCrudInline } from '../proposalCrud.js';
import { handleWithdrawProposal } from '../coachWithdrawProposal.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const OTHER_SPACE = '52cf542e-7122-4a6c-b5e3-7ef640b7b1e0';
const RUN_ID = '99999999-2222-3333-4444-555555555555';
const DELEGATE = '77777777-2222-3333-4444-555555555555';
const SLUG = 'cx-chatbot-invoke-direct';
const WHY = 'The chatbot answered with the wrong field.';

/** A composed skill as the assembler stores it: the entry task carries its derived inputContract. */
function composedWorkflow(): Workflow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    slug: SLUG,
    name: 'CX chatbot invoke direct',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'ok' } }],
    mode: 'process',
    tasks: [
      {
        taskId: 'answer',
        name: 'Answer',
        goal: 'Answer the question.',
        type: 'agent',
        inputBindings: { question: { kind: 'run_input', path: 'question' } },
        inputContract: {
          bindings: {
            question: { kind: 'run_input', bindAs: 'question', path: 'question', schema: {} },
          },
        },
      },
    ],
    stateVariables: [],
    runInputs: [],
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    revision: 3,
    status: 'approved',
    origin: 'cloned',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as Workflow;
}

function args(operation: string, stepType: string, input: unknown, spaceId = SPACE) {
  const ref = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(async () => input),
      shouldStore: vi.fn(() => false),
      store: vi.fn(async () => 'inline:e30='),
    } as never,
    context: {
      tenantId: TENANT,
      runId: RUN_ID,
      traceId: 'trace-1',
      spaceId,
      actorContext: {},
      agentDefinition: { steps: [], systemRole: 'cybernetic-helmsman' },
    } as never,
    stepDef: { stepId: 's', stepType, operation, tags: [] } as never,
    stepExecutionId: 'sx-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: ref,
    attempt: 1,
    scheduledAtMs: Date.now(),
  } satisfies InlineHandlerArgs;
}

function lastResult(): { status: string; output?: unknown; error?: Record<string, unknown> } {
  const msg = mockAddStepResult.mock.calls.at(-1)![1] as {
    status: string;
    outputRef?: string;
    error?: Record<string, unknown>;
  };
  const output = msg.outputRef?.startsWith('inline:')
    ? (JSON.parse(Buffer.from(msg.outputRef.slice(7), 'base64').toString('utf8')) as unknown)
    : undefined;
  return { status: msg.status, output, ...(msg.error ? { error: msg.error } : {}) };
}

async function patch(
  operations: unknown[],
  agent: { runId?: string; customAgentName?: string } = {},
): Promise<string> {
  const call = args('workflow.manage.patch', 'workflow', { slug: SLUG, operations, why: WHY });
  const context = call.context as unknown as Record<string, unknown>;
  await handleWorkflowCrudInline({
    ...call,
    context: {
      ...context,
      runId: agent.runId ?? RUN_ID,
      agentDefinition: agent.customAgentName
        ? { steps: [], systemRole: null, metadata: { name: agent.customAgentName } }
        : { steps: [], systemRole: 'cybernetic-helmsman' },
    } as never,
  });
  const result = lastResult();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe('SUCCEEDED');
  return (result.output as { proposalId: string }).proposalId;
}

async function getProposal(proposalId: string, spaceId = SPACE) {
  await handleProposalCrudInline(args('proposal.get', 'proposal', { proposalId }, spaceId));
  return lastResult();
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  store.clear();
  mockAddStepResult.mockReset();
  store.set(key(SPACE, `/workflows/${SLUG}/workflow.json`), {
    inlineContent: JSON.stringify(composedWorkflow()),
    deletedAt: null,
  });
});

describe('a proposal a patch returns is readable through proposal.get', () => {
  it('reads back a replace_task staged from a task that carries its derived inputContract', async () => {
    const proposalId = await patch([
      { op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' },
    ]);

    const read = await getProposal(proposalId);
    expect(read.status).toBe('SUCCEEDED');
    const proposal = (read.output as { proposal: Record<string, unknown> }).proposal;
    expect(proposal['id']).toBe(proposalId);
    expect(proposal['status']).toBe('proposed');
    const ops = (proposal['proposal'] as { ops: Array<Record<string, unknown>> }).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: 'replace_task',
      taskId: 'answer',
      task: { name: 'Answer directly', inputContract: { bindings: { question: {} } } },
    });
  });

  it('stores the reason the agent gave as the rationale, and records the agent as the source', async () => {
    const proposalId = await patch([
      { op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' },
    ]);

    const read = await getProposal(proposalId);
    const proposal = (read.output as { proposal: Record<string, unknown> }).proposal;
    expect(proposal['source']).toBe('agent_patch');
    expect(proposal['coachSessionId']).toBe(RUN_ID);
    expect(proposal['proposedBy']).toBe('Helmsman');
    expect((proposal['proposal'] as { rationale: string }).rationale).toBe(WHY);
  });

  it('records the agent that patched by its own role, not as the Helmsman', async () => {
    const proposalId = await patch(
      [{ op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' }],
      { customAgentName: 'Forecast analyst' },
    );
    const proposal = (
      (await getProposal(proposalId)).output as { proposal: Record<string, unknown> }
    ).proposal;
    expect(proposal['proposedBy']).toBe('Forecast analyst');
  });

  it('returns the reason from a metadata patch, which stages no proposal', async () => {
    await handleWorkflowCrudInline(
      args('workflow.manage.patch', 'workflow', {
        slug: SLUG,
        why: WHY,
        operations: [{ op: 'replace', path: '/name', value: 'Coastal answers' }],
      }),
    );
    const result = lastResult();
    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).toMatchObject({ why: WHY });
    expect([...store.keys()].some((k) => k.includes('/coach/'))).toBe(false);
  });

  it('reads back the contract derived from edited bindings, not the stale one', async () => {
    const proposalId = await patch([
      {
        op: 'replace',
        path: '/tasks/answer/inputBindings/question',
        value: { kind: 'run_input', path: 'query' },
      },
    ]);

    const read = await getProposal(proposalId);
    expect(read.status).toBe('SUCCEEDED');
    const proposal = (read.output as { proposal: Record<string, unknown> }).proposal;
    const ops = (proposal['proposal'] as { ops: Array<Record<string, unknown>> }).ops;
    expect(ops[0]).toMatchObject({
      op: 'replace_task',
      task: {
        inputBindings: { question: { kind: 'run_input', path: 'query' } },
        inputContract: {
          bindings: { question: { kind: 'run_input', bindAs: 'question', path: 'query' } },
        },
      },
    });
  });

  it('fails a bindings edit to a port the producer lacks, and stores nothing', async () => {
    const workflow = composedWorkflow();
    workflow.tasks = [
      {
        taskId: 'lookup',
        name: 'Lookup',
        goal: 'Look the question up.',
        type: 'agent',
        produces: [{ key: 'facts', shape: { type: 'string' }, semantics: 'data' }],
      },
      { ...workflow.tasks[0]!, dependsOn: ['lookup'] },
    ];
    store.set(key(SPACE, `/workflows/${SLUG}/workflow.json`), {
      inlineContent: JSON.stringify(workflow),
      deletedAt: null,
    });
    await handleWorkflowCrudInline(
      args('workflow.manage.patch', 'workflow', {
        slug: SLUG,
        why: WHY,
        operations: [
          {
            op: 'add',
            path: '/tasks/answer/inputBindings/prior',
            value: { kind: 'task_output', taskId: 'lookup', path: 'missing-port' },
          },
        ],
      }),
    );
    expect(lastResult().status).toBe('FAILED');
    expect([...store.keys()].some((k) => k.includes('/coach/'))).toBe(false);
  });

  it('refuses a patch that authors the derived inputContract, and stores nothing', async () => {
    await handleWorkflowCrudInline(
      args('workflow.manage.patch', 'workflow', {
        slug: SLUG,
        why: WHY,
        operations: [{ op: 'remove', path: '/tasks/answer/inputContract' }],
      }),
    );
    const result = lastResult();
    expect(result.status).toBe('FAILED');
    expect(result.error?.['code']).toBe('WORKFLOW_PATCH_UNSUPPORTED');
    expect(String(result.error?.['message'])).toContain('inputContract or system_feedback');
    expect([...store.keys()].some((k) => k.includes('/coach/'))).toBe(false);
  });
});

describe('proposal.get names why a proposal cannot be read', () => {
  const MISSING = '0e0e0e0e-1111-4222-8333-444444444444';

  it('names a missing proposal without leaving the space blank', async () => {
    const read = await getProposal(MISSING);
    expect(read.status).toBe('FAILED');
    expect(read.error?.['code']).toBe('PROPOSAL_NOT_FOUND');
    const message = String(read.error?.['message']);
    expect(message).toContain('No proposal with this id exists in this space');
    expect(message).not.toMatch(/space \./);
    expect(read.error?.['details']).toMatchObject({ proposalId: MISSING, spaceId: SPACE });
  });

  it('says what failed to parse in an unreadable proposal', async () => {
    store.set(key(SPACE, `/coach/staged/${MISSING}.json`), {
      inlineContent: JSON.stringify({ id: MISSING, kind: 'workflow_refinement' }),
      deletedAt: null,
    });
    const read = await getProposal(MISSING);
    expect(read.error?.['code']).toBe('PROPOSAL_UNREADABLE');
    const message = String(read.error?.['message']);
    expect(message).toContain('does not parse as a staged change');
    expect(message).toContain('status: Required');
  });

  it('reads a proposal another space holds as missing, naming no other space', async () => {
    store.set(key(OTHER_SPACE, `/coach/staged/${MISSING}.json`), {
      inlineContent: '{}',
      deletedAt: null,
    });
    const read = await getProposal(MISSING);
    expect(read.error?.['code']).toBe('PROPOSAL_NOT_FOUND');
    expect(JSON.stringify(read.error)).not.toContain(OTHER_SPACE);
  });

  it('says a deleted proposal was deleted', async () => {
    store.set(key(SPACE, `/coach/staged/${MISSING}.json`), {
      inlineContent: '{}',
      deletedAt: new Date(),
    });
    const read = await getProposal(MISSING);
    expect(read.error?.['code']).toBe('PROPOSAL_DELETED');
  });
});

describe('the conversation that proposed a patch can withdraw it', () => {
  const OTHER_CONVERSATION = '88888888-2222-3333-4444-555555555555';

  async function withdraw(
    stagedChangeId: string,
    runId: string,
    systemRole: 'cybernetic-helmsman' | 'cybernetic-coach',
  ) {
    const call = args('learner.propose.withdraw', 'learner', {
      stagedChangeId,
      reason: 'The operator changed the plan.',
    });
    const context = {
      ...(call.context as unknown as Record<string, unknown>),
      runId,
      agentDefinition: { steps: [], systemRole },
    };
    await handleWithdrawProposal(
      { ...call, context: context as never },
      { stagedChangeId, reason: 'The operator changed the plan.' },
      Date.now(),
    );
    return lastResult();
  }

  function storedStatus(proposalId: string): Record<string, unknown> {
    const doc = store.get(key(SPACE, `/coach/staged/${proposalId}.json`));
    return JSON.parse(doc!.inlineContent!) as Record<string, unknown>;
  }

  it('withdraws a proposal its own conversation made', async () => {
    const proposalId = await patch([
      { op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' },
    ]);
    const result = await withdraw(proposalId, RUN_ID, 'cybernetic-helmsman');
    expect(result.status).toBe('SUCCEEDED');
    expect(storedStatus(proposalId)).toMatchObject({
      status: 'withdrawn',
      resolvedBy: 'helmsman',
      withdrawnBy: 'Helmsman',
      withdrawReason: 'The operator changed the plan.',
    });
  });

  it('withdraws a proposal a session it delegated to patched, as the card names that conversation', async () => {
    const proposalId = await patch(
      [{ op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' }],
      { runId: DELEGATE },
    );
    const result = await withdraw(proposalId, RUN_ID, 'cybernetic-helmsman');
    expect(result.status).toBe('SUCCEEDED');
    expect(storedStatus(proposalId)['status']).toBe('withdrawn');
  });

  it('refuses a proposal another conversation made, and leaves it proposed', async () => {
    const proposalId = await patch([
      { op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' },
    ]);
    const result = await withdraw(proposalId, OTHER_CONVERSATION, 'cybernetic-helmsman');
    expect(result.status).toBe('FAILED');
    expect(result.error?.['code']).toBe('PROPOSAL_NOT_WITHDRAWABLE');
    expect(String(result.error?.['message'])).toContain('another conversation');
    expect(storedStatus(proposalId)['status']).toBe('proposed');
  });

  it('lets the Coach withdraw a Helmsman patch, and records the Coach as who withdrew it', async () => {
    const proposalId = await patch([
      { op: 'replace', path: '/tasks/answer/name', value: 'Answer directly' },
    ]);
    const result = await withdraw(proposalId, OTHER_CONVERSATION, 'cybernetic-coach');
    expect(result.status).toBe('SUCCEEDED');
    expect(storedStatus(proposalId)).toMatchObject({
      resolvedBy: 'coach',
      proposedBy: 'Helmsman',
      withdrawnBy: 'Coach',
    });
  });
});
