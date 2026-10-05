/**
 * A run serving a plan node leaves its record on the node as it ends (Plan
 * 322 D5): the run, and the pull request its promoted output names — through
 * the engine's `linkEndedRun`, with only the run's result and the store faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { RUN_PULL_REQUEST_URL_OUTPUT, type PlanNodeLink } from '@aflow/schemas';
import type { NewPlanNodeLink, WorkflowRunDetail } from '@aflow/cybernetic-runtime';

const NODE_ID = '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11';
const SPACE = '00000000-0000-0000-0000-000000000002';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const PR = 'https://github.com/aflowai/aflow/pull/82';

/** `plan_node_links` for one node: keyed by kind and ref, as its primary key is. */
const links: PlanNodeLink[] = [];
const mockBuildWorkflowRunResult = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    buildWorkflowRunResult: (...a: unknown[]) => mockBuildWorkflowRunResult(...a),
    createPlanNodeStore: () => ({
      insertLink: (spaceId: string, link: NewPlanNodeLink) => {
        if (spaceId !== SPACE || link.nodeId !== NODE_ID) {
          return Promise.resolve({ outcome: 'node_not_found' });
        }
        const held = links.find((l) => l.kind === link.kind && l.ref === link.ref);
        if (held) return Promise.resolve({ outcome: 'exists', link: held });
        const inserted = {
          nodeId: link.nodeId,
          kind: link.kind,
          ref: link.ref,
          ...(link.label !== null ? { label: link.label } : {}),
          createdAt: '2026-10-05T10:00:00.000Z',
        };
        links.push(inserted);
        return Promise.resolve({ outcome: 'inserted', link: inserted });
      },
    }),
  };
});

const { linkEndedRunToPlanNode } = await import('../harness/planLinks.js');

let redis: RedisType;

function deps() {
  return { db: {} as never, redis, payloadStore: {} as never };
}

function endedRun(over: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    id: 'row-1',
    spaceId: SPACE,
    workflowSlug: 'publish-local-changes',
    runId: '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6',
    sessionId: null,
    status: 'running',
    workflowRevision: 21,
    startedAt: new Date('2026-10-05T09:00:00.000Z'),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 1,
    resumeAttemptCount: 1,
    cancelledBy: null,
    cancelReason: null,
    learningCount: 0,
    score: null,
    evalBatchId: null,
    planNodeId: NODE_ID,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: {},
    tasks: [],
    ...over,
  };
}

beforeEach(async () => {
  links.length = 0;
  mockBuildWorkflowRunResult.mockReset();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('linkEndedRunToPlanNode', () => {
  it('leaves a publication started for a node, and the pull request it opened, linked to the node', async () => {
    mockBuildWorkflowRunResult.mockResolvedValue({
      output: { [RUN_PULL_REQUEST_URL_OUTPUT]: PR, prNumber: 82 },
    });

    await linkEndedRunToPlanNode(deps(), TENANT, endedRun(), 'completed');

    expect(links.map((l) => [l.kind, l.ref])).toEqual([
      ['run', '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6'],
      ['pull_request', PR],
    ]);
    expect(links[0]?.label).toBe('publish-local-changes completed');
  });

  it('links a commission, which opens no pull request, as the run alone', async () => {
    mockBuildWorkflowRunResult.mockResolvedValue({ output: { patchRef: 'gs://b/p' } });
    await linkEndedRunToPlanNode(
      deps(),
      TENANT,
      endedRun({ workflowSlug: 'commission-change' }),
      'completed',
    );
    expect(links.map((l) => [l.kind, l.label])).toEqual([['run', 'commission-change completed']]);
  });

  it('takes no pull request from an output that is not a URL', async () => {
    mockBuildWorkflowRunResult.mockResolvedValue({ output: { [RUN_PULL_REQUEST_URL_OUTPUT]: 82 } });
    await linkEndedRunToPlanNode(deps(), TENANT, endedRun(), 'failed');
    expect(links.map((l) => l.kind)).toEqual(['run']);
  });

  it('does nothing for a run that serves no node', async () => {
    const { planNodeId: _served, ...servesNone } = endedRun();
    await linkEndedRunToPlanNode(deps(), TENANT, servesNone, 'completed');
    expect(mockBuildWorkflowRunResult).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
  });
});
