/**
 * The Action Center reads a proposal through the same reader proposal.get
 * uses. A proposal a patch stores must show, and one that cannot be shown must
 * say why instead of answering as though it did not exist.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { StagedChange } from '@aflow/schemas';

interface StoredDoc {
  inlineContent: string | null;
  deletedAt: Date | null;
}
const store = new Map<string, StoredDoc>();
const key = (spaceId: string, path: string) => `${spaceId}|${path}`;

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    createStagedChangeDocReader: () => ({
      getByPath: async (path: string, spaceId: string) => store.get(key(spaceId, path)) ?? null,
    }),
  };
});

/** The conversation store: the patching session is a Helmsman conversation with a title. */
const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000c1';
vi.mock('../../cybernetic/proposalProvenance.js', async () => {
  const actual = await vi.importActual<typeof import('../../cybernetic/proposalProvenance.js')>(
    '../../cybernetic/proposalProvenance.js',
  );
  const lookup = {
    sessions: new Map([
      [
        '00000000-0000-4000-8000-0000000000b1',
        {
          sessionId: '00000000-0000-4000-8000-0000000000b1',
          parentSessionId: '00000000-0000-4000-8000-0000000000c1',
          title: null,
          manualTitle: null,
        },
      ],
      [
        '00000000-0000-4000-8000-0000000000c1',
        {
          sessionId: '00000000-0000-4000-8000-0000000000c1',
          parentSessionId: null,
          title: 'Commission change review',
          manualTitle: null,
        },
      ],
    ]),
    runSessions: new Map<string, string>(),
  };
  return {
    ...actual,
    resolveProposalProvenance: async (
      _db: unknown,
      _tenantId: string,
      _spaceId: string,
      staged: StagedChange[],
    ) =>
      new Map(
        staged.map((sc) => [sc.id, actual.provenanceOf(sc, actual.conversationFor(sc, lookup))]),
      ),
  };
});

const { createCoachProposalSource } = await import('../sources/coachProposalSource.js');
const { ActionCenterResolveError } = await import('../types.js');

const TENANT_ID = 'a0000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-000000000003';
const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000b1';

const ctx = {
  tenantId: TENANT_ID as never,
  spaceId: SPACE_ID,
  actorUserId: '00000000-0000-4000-8000-0000000000e1',
  actorSpaceRole: 'editor' as const,
  actorIsTenantAdmin: false,
};

const source = () =>
  createCoachProposalSource({ db: {} as never, redis: {} as never, payloadStore: {} as never });

/** A proposal as `workflow.manage.patch` writes it for a task the assembler built. */
function patchProposal(): StagedChange {
  return {
    id: PROPOSAL_ID,
    kind: 'workflow_refinement',
    source: 'agent_patch',
    status: 'proposed',
    targetWorkflowSlug: 'cx-chatbot-invoke-direct',
    proposal: {
      summary: 'Agent-initiated patch (1 op(s)) for "cx-chatbot-invoke-direct"',
      rationale: 'Agent proposed 1 patch op(s).',
      confidence: 'medium',
      ops: [
        {
          op: 'replace_task',
          taskId: 'answer',
          task: {
            taskId: 'answer',
            name: 'Answer directly',
            goal: 'Answer the question.',
            type: 'agent',
            inputBindings: { question: { kind: 'run_input', path: 'question' } },
            inputContract: {
              bindings: {
                question: { kind: 'run_input', bindAs: 'question', path: 'question', schema: {} },
              },
            },
          },
        },
      ],
    },
    evidence: { sourceSessionIds: [RUN_ID] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-10-30T09:00:00.000Z',
    expiresAt: '2026-11-06T09:00:00.000Z',
    coachSessionId: RUN_ID,
    rebaseState: 'clean',
    pinnedRevision: 3,
    preconditions: [],
  } as StagedChange;
}

function put(spaceId: string, content: string | null, deletedAt: Date | null = null) {
  store.set(key(spaceId, `/coach/staged/${PROPOSAL_ID}.json`), {
    inlineContent: content,
    deletedAt,
  });
}

async function notFoundMessage(itemId: string): Promise<string> {
  try {
    await source().getById(ctx, itemId);
  } catch (err) {
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as InstanceType<typeof ActionCenterResolveError>).code).toBe('NOT_FOUND');
    return (err as Error).message;
  }
  throw new Error('getById did not throw');
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  store.clear();
});

describe('coach proposal source — reading one proposal', () => {
  it('shows a patch proposal whose replace_task carries the derived inputContract', async () => {
    put(SPACE_ID, JSON.stringify(patchProposal(), null, 2));
    const item = await source().getById(ctx, `proposal:${PROPOSAL_ID}`);
    expect(item).toMatchObject({
      id: `proposal:${PROPOSAL_ID}`,
      kind: 'ratification',
      origin: { type: 'proposal', proposalId: PROPOSAL_ID },
    });
  });

  it('answers null for a proposal no space holds', async () => {
    expect(await source().getById(ctx, `proposal:${PROPOSAL_ID}`)).toBeNull();
  });

  it('names what failed to parse', async () => {
    const broken = { ...patchProposal(), status: 'pending' };
    put(SPACE_ID, JSON.stringify(broken));
    const message = await notFoundMessage(`proposal:${PROPOSAL_ID}`);
    expect(message).toContain(SPACE_ID);
    expect(message).toContain('does not parse as a staged change');
    expect(message).toContain('status');
  });

  it('answers null for a proposal another space holds, as for a stranger', async () => {
    put(OTHER_SPACE_ID, JSON.stringify(patchProposal()));
    expect(await source().getById(ctx, `proposal:${PROPOSAL_ID}`)).toBeNull();
  });

  it('says the path is refused', async () => {
    const message = await notFoundMessage('proposal:../../run/draft/x');
    expect(message).toContain('reserved scratch space');
  });

  it('says the proposal was deleted', async () => {
    put(SPACE_ID, JSON.stringify(patchProposal()), new Date());
    const message = await notFoundMessage(`proposal:${PROPOSAL_ID}`);
    expect(message).toContain('has been deleted');
  });
});

describe('coach proposal source — who proposed it', () => {
  it("names an agent patch as the Helmsman's, with the conversation it came from", async () => {
    put(SPACE_ID, JSON.stringify(patchProposal()));
    const item = await source().getById(ctx, `proposal:${PROPOSAL_ID}`);
    expect(item?.requestedBy).toEqual({
      kind: 'agent',
      label: 'Helmsman',
      sessionId: CONVERSATION_ID,
    });
    expect(item?.extension).toMatchObject({
      kind: 'coach_proposal',
      provenance: {
        source: 'agent_patch',
        conversation: { sessionId: CONVERSATION_ID, title: 'Commission change review' },
      },
      rationale: 'Agent proposed 1 patch op(s).',
    });
  });

  it('keeps a Coach review under the Coach, apart from an agent patch', async () => {
    put(SPACE_ID, JSON.stringify({ ...patchProposal(), source: 'coach' }));
    const item = await source().getById(ctx, `proposal:${PROPOSAL_ID}`);
    expect(item?.requestedBy).toMatchObject({ kind: 'coach', label: 'Coach' });
    expect(item?.extension).toMatchObject({ provenance: { source: 'coach' } });
  });
});

describe('coach proposal source — resolving one proposal', () => {
  const item = { id: `proposal:${PROPOSAL_ID}` } as never;

  async function resolveError(): Promise<InstanceType<typeof ActionCenterResolveError>> {
    try {
      await source().resolve(ctx, item, { kind: 'ratify' } as never);
    } catch (err) {
      expect(err).toBeInstanceOf(ActionCenterResolveError);
      return err as InstanceType<typeof ActionCenterResolveError>;
    }
    throw new Error('resolve did not throw');
  }

  it('names what failed to parse, as reading the item does', async () => {
    put(SPACE_ID, JSON.stringify({ ...patchProposal(), status: 'pending' }));
    const err = await resolveError();
    expect(err.code).toBe('NOT_FOUND');
    expect(err.detail).toBe('unparseable');
    expect(err.message).toBe(await notFoundMessage(`proposal:${PROPOSAL_ID}`));
  });

  it('says the proposal was deleted, as reading the item does', async () => {
    put(SPACE_ID, JSON.stringify(patchProposal()), new Date());
    const err = await resolveError();
    expect(err.detail).toBe('deleted');
    expect(err.message).toBe(await notFoundMessage(`proposal:${PROPOSAL_ID}`));
  });

  it('reports a missing proposal as not found', async () => {
    const err = await resolveError();
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe(`Proposal ${PROPOSAL_ID} not found.`);
  });
});
