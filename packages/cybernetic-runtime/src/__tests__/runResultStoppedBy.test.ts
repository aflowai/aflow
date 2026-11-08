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
  retrieve: vi.fn((ref: string) => {
    const stored = OUTPUTS[ref];
    return stored instanceof Error ? Promise.reject(stored) : Promise.resolve(stored);
  }),
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

/** WORKFLOW where `commit` also fills the sensitive variables named, from its output paths. */
function withCommitSecrets(names: readonly string[]): Workflow {
  return {
    ...WORKFLOW,
    tasks: WORKFLOW.tasks.map((t) =>
      t.taskId === 'commit'
        ? {
            ...t,
            promoteOutputs: names.map((n) => ({ kind: 'output_path', path: n, toState: n })),
          }
        : t,
    ),
    stateVariables: [
      ...WORKFLOW.stateVariables,
      ...names.map((n) => ({ variableId: n, sensitive: true })),
    ],
  } as Workflow;
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

  it('names the outcome that skipped the producer when a failure off the path failed the run', async () => {
    const result = await resultOf(
      {
        ...run('failed', [
          row('docs', 'failed', 1, { failureReason: 'docs build exited 1' }),
          row('commit', 'succeeded', 2, { outputRef: 'ref:commit:conflict' }),
          row('check', 'skipped', 3),
          row('push', 'skipped', 3),
          row('open-pr', 'skipped', 3),
        ]),
        failureJson: {
          reason: 'task_failed',
          message: 'The run ended on task docs.',
          taskIds: ['docs'],
        },
      },
      'full',
      withSideTask({}),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'commit',
      status: 'succeeded',
      detail: 'state: conflict — src/a.ts: patch does not apply',
    });
  });

  it('leaves unrelated text alone when a sensitive value is 1, 0 or true', async () => {
    const workflow = {
      ...WORKFLOW,
      tasks: WORKFLOW.tasks.map((t) =>
        t.taskId === 'commit'
          ? {
              ...t,
              promoteOutputs: [
                { kind: 'output_path', path: 'pin', toState: 'pin' },
                { kind: 'output_path', path: 'retries', toState: 'retries' },
                { kind: 'output_path', path: 'admin', toState: 'admin' },
              ],
            }
          : t,
      ),
      stateVariables: [
        ...WORKFLOW.stateVariables,
        { variableId: 'pin', sensitive: true },
        { variableId: 'retries', sensitive: true },
        { variableId: 'admin', sensitive: true },
      ],
    } as Workflow;
    OUTPUTS['ref:commit:short-secrets'] = { state: 'applied', pin: 1, retries: 0, admin: true };
    const reason =
      'yarn test exited 1 after 0 retries in 10.4s (strict: true), see true-north/1.0 {"pin":1}';
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:short-secrets' }),
        row('check', 'failed', 2, { failureReason: reason }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
      'full',
      workflow,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail:
        'yarn test exited 1 after 0 retries in 10.4s (strict: true), see true-north/1.0 {"pin":"[redacted]"}',
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

  it("carries the operator's cancel reason, not a task the cancel reached", async () => {
    const result = await resultOf({
      ...run('cancelled', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'cancelled', 2, { failureReason: 'Run cancelled' }),
        row('push', 'cancelled', 2),
        row('open-pr', 'cancelled', 2),
      ]),
      cancelledBy: 'operator',
      cancelReason: 'Wrong base branch',
    });
    expect(result?.stoppedBy).toEqual({
      taskId: null,
      status: 'cancelled',
      detail: 'cancelled by operator: Wrong base branch',
    });
  });

  it('redacts a sensitive number and a sensitive object quoted in a failure reason', async () => {
    const workflow = {
      ...WORKFLOW,
      tasks: WORKFLOW.tasks.map((t) =>
        t.taskId === 'commit'
          ? {
              ...t,
              promoteOutputs: [
                { kind: 'output_path', path: 'pin', toState: 'pin' },
                { kind: 'output_path', path: 'account', toState: 'account' },
              ],
            }
          : t,
      ),
      stateVariables: [
        ...WORKFLOW.stateVariables,
        { variableId: 'pin', sensitive: true },
        { variableId: 'account', sensitive: true },
      ],
    } as Workflow;
    const account = { user: 'deploy-bot', token: 'tok-93a1' };
    OUTPUTS['ref:commit:secrets'] = { state: 'applied', pin: 482913, account };
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:secrets' }),
        row('check', 'failed', 2, {
          failureReason: `pin 482913 refused for ${JSON.stringify(account)}`,
        }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
      'full',
      workflow,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail: 'pin [redacted] refused for [redacted]',
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

  it('redacts a short secret that is not a common spelling inside free text', async () => {
    OUTPUTS['ref:commit:otp'] = { state: 'applied', otp: 'k7Qz', retries: 0, admin: true };
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:otp' }),
        row('check', 'failed', 2, {
          failureReason: 'code k7Qz expired after 0 retries (strict: true), exit 1',
        }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
      'full',
      withCommitSecrets(['otp', 'retries', 'admin']),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail: 'code [redacted] expired after 0 retries (strict: true), exit 1',
    });
  });
});

describe('buildWorkflowRunResult — a rejected approval gate', () => {
  /** commit → check → approve → push → open-pr, with `approve` an approval gate. */
  const GATED = {
    ...WORKFLOW,
    tasks: [
      WORKFLOW.tasks[0],
      WORKFLOW.tasks[1],
      { taskId: 'approve', dependsOn: ['check'], type: 'human', intent: 'approve' },
      { taskId: 'push', dependsOn: ['approve'] },
      WORKFLOW.tasks[3],
    ],
  } as Workflow;

  it('names the gate the operator rejected, with the rejection, not the task before it', async () => {
    OUTPUTS['ref:approve:rejected'] = {
      decision: 'rejected',
      decidedAt: '2026-11-07T00:05:00.000Z',
      decidedBy: 'operator-7',
      comment: 'Wrong base branch',
    };
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2, { summary: 'All tests passed' }),
        row('approve', 'skipped', 5, {
          outputRef: 'ref:approve:rejected',
          summary: 'Rejected via workflow.run.resume reject (gated branch skipped).',
        }),
        row('push', 'skipped', 5, { summary: 'Skipped — upstream approval rejected.' }),
        row('open-pr', 'skipped', 5, { summary: 'Skipped — upstream approval rejected.' }),
      ]),
      'full',
      GATED,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'approve',
      status: 'skipped',
      detail: 'rejected by operator-7: Wrong base branch',
    });
  });

  it('passes over a gate its own condition skipped, which holds no decision', async () => {
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:conflict' }),
        row('check', 'skipped', 2),
        row('approve', 'skipped', 2),
        row('push', 'skipped', 2),
        row('open-pr', 'skipped', 2),
      ]),
      'full',
      GATED,
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'commit',
      status: 'succeeded',
      detail: 'state: conflict — src/a.ts: patch does not apply',
    });
  });
});

describe('buildWorkflowRunResult — outputs that did not decode', () => {
  it('reports no stop where the output of the producer could not be decoded', async () => {
    OUTPUTS['ref:open-pr:unreadable'] = new Error('payload store unreachable');
    const result = await resultOf(
      run('completed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:applied' }),
        row('check', 'succeeded', 2),
        row('push', 'succeeded', 3),
        row('open-pr', 'succeeded', 4, { outputRef: 'ref:open-pr:unreadable' }),
      ]),
    );
    expect(result?.primaryOutput).toBeUndefined();
    expect(result?.stoppedBy).toBeUndefined();
  });

  it('redacts a sensitive value read again from an output the first decode missed', async () => {
    OUTPUTS['ref:commit:serialised'] = JSON.stringify({ state: 'applied', token: 'tok-93a1' });
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:serialised' }),
        row('check', 'failed', 2, { failureReason: 'token tok-93a1 refused' }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
      'full',
      withCommitSecrets(['token']),
    );
    expect(result?.stoppedBy).toEqual({
      taskId: 'check',
      status: 'failed',
      detail: 'token [redacted] refused',
    });
  });

  it('withholds the detail where an output filling a sensitive variable could not be decoded', async () => {
    OUTPUTS['ref:commit:unreadable'] = new Error('payload store unreachable');
    const result = await resultOf(
      run('failed', [
        row('commit', 'succeeded', 1, { outputRef: 'ref:commit:unreadable' }),
        row('check', 'failed', 2, { failureReason: 'token tok-93a1 refused' }),
        row('push', 'blocked', 2),
        row('open-pr', 'blocked', 2),
      ]),
      'full',
      withCommitSecrets(['token']),
    );
    expect(result?.stoppedBy).toEqual({ taskId: 'check', status: 'failed' });
  });
});
