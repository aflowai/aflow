import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Workflow } from '@aflow/schemas';
import type { WorkflowRunDetail, WorkflowTaskRow } from '../ledger/types.js';

const mocks = vi.hoisted(() => ({
  selectActiveLearningSet: vi.fn(),
}));

vi.mock('../ledger/queries.js', () => ({ getRunCampaignId: vi.fn().mockResolvedValue(null) }));
vi.mock('../campaigns.js', () => ({
  getCampaignById: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
}));
vi.mock('../skill.js', () => ({ resolveSkillForWorkflow: vi.fn().mockResolvedValue(null) }));
vi.mock('../activeLearningSet.js', () => ({
  selectActiveLearningSet: mocks.selectActiveLearningSet,
  resolveActiveSetBudget: vi.fn().mockReturnValue(20),
}));
vi.mock('../modelResolution.js', () => ({ loadSpaceDirectives: vi.fn().mockResolvedValue(null) }));

import { buildWorkflowRunResult } from '../runResult.js';

const DB = {} as unknown as PostgresJsDatabase;
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN_ID = '00000000-0000-0000-0000-000000000042';

/** commit → check → push → open-pr, which promotes the run's primary `prUrl`. */
const WORKFLOW = {
  tasks: [
    { taskId: 'commit' },
    { taskId: 'check', dependsOn: ['commit'] },
    { taskId: 'push', dependsOn: ['commit', 'check'] },
    {
      taskId: 'open-pr',
      dependsOn: ['push'],
      promoteOutputs: [{ kind: 'output_path', path: 'prUrl', toState: 'prUrl' }],
    },
  ],
  stateVariables: [{ variableId: 'prUrl', sensitive: false }],
  outcomes: [],
  output: { primary: 'prUrl' },
} as unknown as Workflow;

const OUTPUTS: Record<string, unknown> = {
  'ref:commit:conflict': { state: 'conflict', detail: 'src/a.ts: patch does not apply' },
  'ref:commit:applied': { state: 'applied' },
  'ref:open-pr': { prUrl: 'https://github.com/o/r/pull/7' },
};
const PAYLOAD_STORE = {
  retrieve: vi.fn((ref: string) => Promise.resolve(OUTPUTS[ref])),
} as unknown as PayloadStore;

function row(
  taskId: string,
  status: string,
  minute: number,
  extra: Partial<WorkflowTaskRow> = {},
): WorkflowTaskRow {
  return {
    id: `row-${taskId}`,
    runId: RUN_ID,
    taskId,
    status,
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    dispatchDeadlineAt: null,
    startedAt: null,
    completedAt: new Date(Date.UTC(2026, 10, 7, 0, minute)),
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    inputRef: null,
    reflectionJson: null,
    operationId: null,
    errorCode: null,
    errorClassification: null,
    errorRetryable: null,
    failedAt: null,
    priorFailures: null,
    pollCycle: 0,
    ...extra,
  };
}

function run(status: string, tasks: WorkflowTaskRow[]): WorkflowRunDetail {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
    workflowSlug: 'publish-local-changes',
    runId: RUN_ID,
    sessionId: null,
    status,
    workflowRevision: 1,
    startedAt: new Date('2026-11-07T00:00:00.000Z'),
    completedAt: new Date('2026-11-07T01:00:00.000Z'),
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 0,
    resumeAttemptCount: 0,
    cancelledBy: null,
    cancelReason: null,
    learningCount: 0,
    score: null,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: null,
    tasks,
  };
}

async function resultOf(
  detail: WorkflowRunDetail,
  scope: 'partial' | 'full' = 'full',
  workflow: Workflow = WORKFLOW,
) {
  return buildWorkflowRunResult(
    { db: DB, payloadStore: PAYLOAD_STORE },
    { tenantId: TENANT, run: detail, workflow, scope },
  );
}

/** WORKFLOW with `docs` ahead of it in workflow order, off the path to `open-pr`. */
function withSideTask(side: Record<string, unknown>): Workflow {
  return { ...WORKFLOW, tasks: [{ taskId: 'docs', ...side }, ...WORKFLOW.tasks] } as Workflow;
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  mocks.selectActiveLearningSet.mockResolvedValue({
    selected: [],
    omittedDueToBudget: 0,
    consolidationDue: false,
  });
});

describe('buildWorkflowRunResult — the task that stopped the run', () => {
  it('names a succeeded task whose outcome skipped every task after it', async () => {
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:conflict' }),
        row('check', 'skipped', 2, { summary: 'when evaluated false' }),
        row('push', 'skipped', 2),
        row('open-pr', 'skipped', 2),
      ]),
    );
    expect(result?.primaryOutput).toBeUndefined();
    expect(result?.stoppedBy).toEqual({
      taskId: 'commit',
      status: 'succeeded',
      detail: 'state: conflict — src/a.ts: patch does not apply',
    });
  });

  it('names the failed task with its failure reason, ahead of the tasks it blocked', async () => {
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'failed', 2, { failureReason: 'yarn test exited 1' }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail: 'yarn test exited 1',
    });
  });

  it('names the producer when it ran and promoted nothing', async () => {
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2),
        row('push', 'succeeded', 3),
        row('open-pr', 'succeeded', 4, { summary: 'No pull request opened' }),
      ]),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'open-pr',
      status: 'succeeded',
      detail: 'No pull request opened',
    });
  });

  it('leaves a run that ended with its primary output unchanged', async () => {
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2),
        row('push', 'succeeded', 3),
        row('open-pr', 'succeeded', 4, { outputRef: 'ref:open-pr' }),
      ]),
    );
    expect(result).toEqual({
      output: { prUrl: 'https://github.com/o/r/pull/7' },
      primaryOutput: 'prUrl',
    });
  });

  it('names no task while the run is in flight', async () => {
    const result = await resultOf(
      run('running', [row('commit', 'succeeded', 1, { outputRef: 'ref:commit:conflict' })]),
      'partial',
    );
    expect(result?.stoppedBy).toBeUndefined();
  });
});

describe('buildWorkflowRunResult — tasks that did not stop the run', () => {
  it('passes over an optional task that failed while the run completed', async () => {
    const workflow = {
      ...WORKFLOW,
      tasks: [
        WORKFLOW.tasks[0],
        { taskId: 'lint', dependsOn: ['commit'], optional: true },
        ...WORKFLOW.tasks
          .slice(1)
          .map((t) => (t.taskId === 'check' ? { ...t, dependsOn: ['commit', 'lint'] } : t)),
      ],
    } as Workflow;
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:conflict' }),
        row('lint', 'failed', 3, { failureReason: 'eslint exited 2' }),
        row('check', 'skipped', 4),
        row('push', 'skipped', 4),
        row('open-pr', 'skipped', 4),
      ]),
      'full',
      workflow,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'commit',
      status: 'succeeded',
      detail: 'state: conflict — src/a.ts: patch does not apply',
    });
  });

  it('names the failed task on the path, not an earlier failure off it', async () => {
    const result = await resultOf(
      run('failed', [
        row('docs', 'failed', 1, { failureReason: 'docs build exited 1' }),
        row('commit', 'succeeded', 2, { outputRef: 'ref:commit:applied' }),
        row('check', 'failed', 3, { failureReason: 'yarn test exited 1' }),
        row('push', 'blocked', 3),
        row('open-pr', 'blocked', 3),
      ]),
      'full',
      withSideTask({}),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail: 'yarn test exited 1',
    });
  });

  it('names the failure off the path that the run names when it blocked the path', async () => {
    const result = await resultOf(
      {
        ...run('failed', [
          row('docs', 'failed', 1, { failureReason: 'docs build exited 1' }),
          row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
          row('check', 'blocked', 2),
          row('push', 'blocked', 2),
          row('open-pr', 'blocked', 2),
        ]),
        failureJson: {
          reason: 'task_failed',
          message: 'The run ended on task docs.',
          taskIds: ['docs'],
        },
      },
      'full',
      withSideTask({ failureMode: 'cancel_siblings' }),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'docs',
      status: 'failed',
      detail: 'docs build exited 1',
    });
  });

  it("carries the run's own failure where no task row holds the cause", async () => {
    const result = await resultOf({
      ...run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2),
      ]),
      failureJson: {
        reason: 'workflow_run_orphaned',
        message: 'The run lost its dispatcher.',
      },
    });
    expect(result?.stoppedBy).toEqual({
      taskId: null,
      status: 'failed',
      detail: 'The run lost its dispatcher.',
    });
  });

  it('reports no stop where sanitisation removed a primary that was produced', async () => {
    const workflow = {
      ...WORKFLOW,
      stateVariables: [{ variableId: 'prUrl', sensitive: true }],
    } as Workflow;
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2),
        row('push', 'succeeded', 3),
        row('open-pr', 'succeeded', 4, { outputRef: 'ref:open-pr' }),
      ]),
      'full',
      workflow,
    );
    expect(result?.primaryOutput).toBeUndefined();
    expect(result?.stoppedBy).toBeUndefined();
  });

  it('keeps an output field that fills a sensitive variable out of the detail', async () => {
    const workflow = {
      ...WORKFLOW,
      tasks: WORKFLOW.tasks.map((t) =>
        t.taskId === 'commit'
          ? {
              ...t,
              promoteOutputs: [{ kind: 'output_path', path: 'detail', toState: 'conflictDetail' }],
            }
          : t,
      ),
      stateVariables: [
        ...WORKFLOW.stateVariables,
        { variableId: 'conflictDetail', sensitive: true },
      ],
    } as Workflow;
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, {
          outputRef: 'ref:commit:conflict',
          summary: 'Conflict in src/a.ts: patch does not apply',
        }),
        row('check', 'skipped', 2),
        row('push', 'skipped', 2),
        row('open-pr', 'skipped', 2),
      ]),
      'full',
      workflow,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'commit',
      status: 'succeeded',
      detail: 'state: conflict — Conflict in [redacted]',
    });
  });
});
