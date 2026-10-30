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
      otherSpacesHoldingPath: async (path: string, spaceId: string) =>
        [...store.keys()]
          .map((k) => k.split('|'))
          .filter(([s, p]) => p === path && s !== spaceId)
          .map(([s]) => s!),
    }),
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  appendEntityEvent: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';
import { handleProposalCrudInline } from '../proposalCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const OTHER_SPACE = '52cf542e-7122-4a6c-b5e3-7ef640b7b1e0';
const RUN_ID = '99999999-2222-3333-4444-555555555555';
const SLUG = 'cx-chatbot-invoke-direct';

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
      agentDefinition: { steps: [] },
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

async function patch(operations: unknown[]): Promise<string> {
  await handleWorkflowCrudInline(
    args('workflow.manage.patch', 'workflow', { slug: SLUG, operations }),
  );
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

  it('refuses a patch that authors the derived inputContract, and stores nothing', async () => {
    await handleWorkflowCrudInline(
      args('workflow.manage.patch', 'workflow', {
        slug: SLUG,
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

  it('names the other space that holds the proposal', async () => {
    store.set(key(OTHER_SPACE, `/coach/staged/${MISSING}.json`), {
      inlineContent: '{}',
      deletedAt: null,
    });
    const read = await getProposal(MISSING);
    expect(read.error?.['code']).toBe('PROPOSAL_IN_OTHER_SPACE');
    expect(read.error?.['details']).toMatchObject({ foundInSpaceIds: [OTHER_SPACE] });
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
