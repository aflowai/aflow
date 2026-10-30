import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  describeStagedChangeReadFailure,
  readStagedChange,
  type StagedChangeDocReader,
  type StagedChangeReadResult,
} from './readStagedChange.js';

const TENANT_ID = 'a0000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-000000000003';
const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000a1';
const TENANT_PATH = `/coach/staged/${PROPOSAL_ID}.json`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface StoredDoc {
  inlineContent: string | null;
  deletedAt: Date | null;
}
const store = new Map<string, StoredDoc>();
const readPaths: string[] = [];

const docs: StagedChangeDocReader = {
  getByPath: async (path, spaceId) => {
    readPaths.push(path);
    return store.get(`${spaceId}|${path}`) ?? null;
  },
};

function put(spaceId: string, path: string, content: string | null, deletedAt: Date | null = null) {
  store.set(`${spaceId}|${path}`, { inlineContent: content, deletedAt });
}

function stagedChange(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: PROPOSAL_ID,
    kind: 'workflow_refinement',
    status: 'proposed',
    source: 'coach',
    authorityLevel: 'stage_for_review',
    resolutionRoute: 'tenant_ratification',
    rebaseState: 'clean',
    coachSessionId: '00000000-0000-4000-8000-0000000000b1',
    targetWorkflowSlug: 'wf',
    pinnedRevision: 1,
    proposal: {
      summary: 's',
      rationale: 'r',
      confidence: 'low',
      ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'x' }],
    },
    evidence: { sourceSessionIds: ['00000000-0000-4000-8000-0000000000b2'] },
    proposedAt: '2026-10-30T09:00:00.000Z',
    expiresAt: '2026-11-06T09:00:00.000Z',
    ...overrides,
  });
}

function read(proposalId = PROPOSAL_ID): Promise<StagedChangeReadResult> {
  return readStagedChange(docs, {
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    proposalId,
    reader: 'test',
  });
}

function failure(result: StagedChangeReadResult) {
  if (result.ok) throw new Error('expected the read to fail');
  return result;
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  store.clear();
  readPaths.length = 0;
});

describe('readStagedChange', () => {
  it('returns a readable proposal as stored', async () => {
    put(SPACE_ID, TENANT_PATH, stagedChange());
    const result = await read();
    expect(result).toMatchObject({ ok: true, path: TENANT_PATH, staged: { id: PROPOSAL_ID } });
  });

  it('reports a proposal no document holds as not_found', async () => {
    const result = failure(await read());
    expect(result.reason).toBe('not_found');
  });

  it('reports a proposal held by another space as not_found, as for a stranger', async () => {
    const stranger = failure(await read());
    put(OTHER_SPACE_ID, TENANT_PATH, stagedChange());
    const result = failure(await read());
    expect(result).toEqual(stranger);
    expect(result.reason).toBe('not_found');
    expect(JSON.stringify(result)).not.toContain(OTHER_SPACE_ID);
  });

  it('reports a deleted document as deleted', async () => {
    put(SPACE_ID, TENANT_PATH, stagedChange(), new Date());
    expect(failure(await read()).reason).toBe('deleted');
  });

  it('names the failing field of a document the schema refuses', async () => {
    put(SPACE_ID, TENANT_PATH, stagedChange({ status: 'pending' }));
    const result = failure(await read());
    expect(result).toMatchObject({ reason: 'unparseable', parse: 'schema', path: TENANT_PATH });
    expect(describeStagedChangeReadFailure(result)).toContain('status');
  });

  it('reports a document that is not JSON as unparseable', async () => {
    put(SPACE_ID, TENANT_PATH, '{ not json');
    expect(failure(await read())).toMatchObject({ reason: 'unparseable', parse: 'json' });
  });

  it('refuses a proposal id that resolves into reserved scratch space without reading it', async () => {
    const result = failure(await read('../../run/draft/x'));
    expect(result.reason).toBe('refused_path');
    expect(readPaths.some((p) => p.includes('/run/draft/'))).toBe(false);
    expect(describeStagedChangeReadFailure(result)).toContain('reserved scratch space');
  });

  it('describes every failure without naming an id', async () => {
    put(SPACE_ID, TENANT_PATH, stagedChange({ status: 'pending' }));
    const unparseable = failure(await read());
    store.clear();
    put(SPACE_ID, TENANT_PATH, stagedChange(), new Date());
    const deleted = failure(await read());
    store.clear();
    const notFound = failure(await read());
    const refused = failure(await read('../../run/draft/x'));
    for (const f of [unparseable, deleted, notFound, refused]) {
      expect(describeStagedChangeReadFailure(f)).not.toMatch(UUID);
    }
  });
});
