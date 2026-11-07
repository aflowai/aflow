import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionEvent } from '@aflow/schemas';
import {
  runSurfaceNeedsDetailRead,
  runSurfaceOutputs,
  type RunViewState,
  type WorkflowRunDetailResponse,
} from '@aflow/run-view';
import { foldEventsToSnapshot } from './foldSessionEvents.js';
import { hydrateSnapshotRuns, runsNeedingDetail } from './hydrateSnapshotRuns.js';

/**
 * A conversation with the shape of the one the snapshot was measured on:
 * 22 messages, 5 workflow runs, 4 of them mounted as cards. Its sizes are set
 * so the folded snapshot serializes to the 117 KB that conversation measured,
 * 83 KB of it `workflowRuns`.
 */

const FIXTURE_SESSION_ID = '82f35556-0000-4000-8000-000000000000';

const FIXTURE_RUN_IDS = [
  '82f35556-0000-4000-8000-0000000000a1',
  '82f35556-0000-4000-8000-0000000000a2',
  '82f35556-0000-4000-8000-0000000000a3',
  '82f35556-0000-4000-8000-0000000000a4',
  '82f35556-0000-4000-8000-0000000000a5',
] as const;

/** The runs the conversation mounted as cards — every run but the last. */
const FIXTURE_MOUNTED_RUN_IDS = FIXTURE_RUN_IDS.slice(0, 4);

const FIXTURE_TASKS = [
  { taskId: 'plan', label: 'Plan the change', taskType: 'agent' as const },
  {
    taskId: 'build',
    label: 'Build the change',
    taskType: 'operation' as const,
    operationId: 'host.harness.run',
  },
  {
    taskId: 'verify',
    label: 'Verify the change',
    taskType: 'operation' as const,
    operationId: 'host.command.run',
  },
] as const;

const WORDS =
  'the snapshot carries each run once and the card mounts from it without a read of its own'.split(
    ' ',
  );

/** Deterministic prose of about `bytes` characters. */
function prose(bytes: number, seed = 0): string {
  const out: string[] = [];
  let length = 0;
  let i = seed;
  while (length < bytes) {
    const word = WORDS[i % WORDS.length] ?? 'run';
    out.push(word);
    length += word.length + 1;
    i += 1;
  }
  return out.join(' ').slice(0, bytes);
}

function fixtureRunOutput(runIndex: number): Record<string, unknown> {
  return {
    report: prose(4_900, runIndex),
    findings: Array.from({ length: 12 }, (_, i) => prose(200, runIndex + i)),
    prUrl: `https://example.test/pr/${String(runIndex + 1)}`,
  };
}

let clock = Date.parse('2026-11-01T09:00:00.000Z');
function at(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

function event(
  eventType: string,
  data: Record<string, unknown>,
  extra: { stepExecutionId?: string; metadata?: Record<string, unknown> } = {},
): ApiSessionEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    sessionId: FIXTURE_SESSION_ID,
    timestamp: at(),
    sequenceNumber: 0,
    eventVersion: 1,
    data,
    ...(extra.stepExecutionId ? { stepExecutionId: extra.stepExecutionId } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  } as unknown as ApiSessionEvent;
}

function message(seq: number): ApiSessionEvent {
  return event(
    'RoomMessage',
    {},
    {
      metadata: {
        messageSeq: seq,
        actorUserId: '82f35556-0000-4000-8000-00000000e5a1',
        body: prose(1_300, seq),
        wakeHelmsman: false,
      },
    },
  );
}

function anchorFor(runIndex: number): string {
  return `82f35556-0000-4000-8000-0000000005${String(runIndex).padStart(2, '0')}`;
}

function runEvents(runIndex: number, mounted: boolean): ApiSessionEvent[] {
  const runId = FIXTURE_RUN_IDS[runIndex] ?? FIXTURE_RUN_IDS[0];
  const startedAt = at();
  const events: ApiSessionEvent[] = [];
  if (mounted) {
    events.push(
      event(
        'SessionPaused',
        {
          pauseContract: {
            kind: 'waiting_on_workflow_run',
            runId,
            slug: 'commission-change',
            status: 'running',
          },
          pausedAtStepExecutionId: anchorFor(runIndex),
        },
        { stepExecutionId: anchorFor(runIndex) },
      ),
    );
  }
  events.push(
    event('WorkflowRunUpdate', {
      workflowRunUpdate: {
        runId,
        slug: 'commission-change',
        workflowTitle: 'Commission a change',
        status: 'running',
        pauseVersion: 0,
        startedAt,
      },
    }),
  );
  const output = fixtureRunOutput(runIndex);
  for (const task of FIXTURE_TASKS) {
    const base = {
      runId,
      taskId: task.taskId,
      label: task.label,
      attempt: 1,
      taskType: task.taskType,
      workerSessionId: `${runId.slice(0, 30)}${task.taskId.padEnd(6, '0').slice(0, 6)}`,
      ...('operationId' in task ? { operationId: task.operationId } : {}),
    };
    events.push(
      event('WorkflowTaskUpdate', {
        workflowTaskUpdate: { ...base, status: 'running', startedAt: at() },
      }),
    );
    events.push(
      event('WorkflowTaskUpdate', {
        workflowTaskUpdate: {
          ...base,
          status: 'succeeded',
          completedAt: at(),
          summary: prose(160, runIndex),
          ...(task.taskId === 'build' ? { promotedState: output } : {}),
        },
      }),
    );
  }
  events.push(
    event('WorkflowRunUpdate', {
      workflowRunUpdate: {
        runId,
        slug: 'commission-change',
        workflowTitle: 'Commission a change',
        status: 'completed',
        pauseVersion: 0,
        startedAt,
        completedAt: at(),
        result: {
          goal: 'Ship the change behind a reviewed pull request.',
          output,
          primaryOutput: 'prUrl',
          summary: prose(160, runIndex),
        },
      },
    }),
  );
  return events;
}

/** The durable page of the conversation, in the order its events landed. */
function fixtureSessionEvents(): ApiSessionEvent[] {
  const events: ApiSessionEvent[] = [];
  let seq = 0;
  for (let runIndex = 0; runIndex < FIXTURE_RUN_IDS.length; runIndex++) {
    // 22 messages across 5 runs: 5, 5, 4, 4, 4.
    const messages = runIndex < 2 ? 5 : 4;
    for (let m = 0; m < messages; m++) events.push(message(seq++));
    events.push(...runEvents(runIndex, runIndex < FIXTURE_MOUNTED_RUN_IDS.length));
  }
  return events;
}

function inlineRef(kind: string, bytes: number, seed: number): string {
  return `inline:${kind}:${Buffer.from(JSON.stringify({ text: prose(bytes, seed) })).toString('base64')}`;
}

/**
 * The run detail a card reads on mount, as `GET /workflow-runs/:runId` returns
 * it. Its inline refs are the payloads themselves, which is what puts a real
 * detail at 116-180 KB.
 */
function fixtureRunDetail(runId: string): WorkflowRunDetailResponse {
  const runIndex = FIXTURE_RUN_IDS.indexOf(runId as (typeof FIXTURE_RUN_IDS)[number]);
  return {
    run: {
      runId,
      workflowSlug: 'commission-change',
      workflowTitle: 'Commission a change',
      status: 'completed',
      pauseVersion: 0,
      startedAt: '2026-11-01T09:00:00.000Z',
      completedAt: '2026-11-01T09:30:00.000Z',
    },
    tasks: [
      {
        taskId: 'plan',
        label: 'Plan the change',
        status: 'succeeded',
        attempt: 1,
        taskType: 'agent',
        stepCount: 14,
        totalTokens: 52_000,
        inputRef: inlineRef('input', 30_000, runIndex),
        outputRef: inlineRef('output', 30_000, runIndex + 1),
      },
      {
        taskId: 'build',
        label: 'Build the change',
        status: 'succeeded',
        attempt: 1,
        taskType: 'operation',
        operationId: 'host.harness.run',
        inputRef: inlineRef('input', 2_000, runIndex + 2),
        outputRef: `gs://payloads/tenants/t/runs/${runId}/steps/build/attempt/1/output.json`,
      },
      {
        taskId: 'verify',
        label: 'Verify the change',
        status: 'succeeded',
        attempt: 1,
        taskType: 'operation',
        operationId: 'host.command.run',
        inputRef: inlineRef('input', 300, runIndex + 3),
        outputRef: inlineRef('output', 40_000, runIndex + 4),
      },
    ],
    graphFidelity: 'full',
    workflowGraph: {
      taskIds: ['plan', 'build', 'verify'],
      edges: [
        { from: 'plan', to: 'build' },
        { from: 'build', to: 'verify' },
      ],
    },
    result: {
      goal: 'Ship the change behind a reviewed pull request.',
      output: fixtureRunOutput(runIndex),
      primaryOutput: 'prUrl',
      summary: prose(160, runIndex),
    },
  };
}

/**
 * This fixture's snapshot response as the fold serialized it before the run
 * state held its output bag once and carried the card's mount state: measured
 * on 1ccacf69, with all four cards still reading their run detail on mount.
 */
const SNAPSHOT_BYTES_BEFORE = 117_413;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The response body the snapshot route sends for a snapshot. */
function responseBody(snapshot: RunViewState) {
  return {
    snapshot,
    tailCursor: '1700000000000-0',
    olderCursor: null,
    hasOlder: false,
    foldedEventCount: 0,
    catchupEventCount: 0,
    status: null,
    catchupFailed: false,
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function folded(): RunViewState {
  return foldEventsToSnapshot(fixtureSessionEvents(), []).snapshot;
}

/** Cards whose state cannot render without a read of the run detail. */
function cardsNeedingRead(snapshot: RunViewState): number {
  return snapshot.workflowSurfaceItems.filter((item) =>
    runSurfaceNeedsDetailRead(item.frozenSnapshot ?? snapshot.workflowRuns[item.runId]),
  ).length;
}

describe('hydrateSnapshotRuns — the mount snapshot carries each run once', () => {
  it('folds the fixture to the shape of the measured conversation', () => {
    const snapshot = folded();
    expect(snapshot.messages).toHaveLength(22);
    expect(Object.keys(snapshot.workflowRuns)).toHaveLength(FIXTURE_RUN_IDS.length);
    expect(snapshot.workflowSurfaceItems).toHaveLength(FIXTURE_MOUNTED_RUN_IDS.length);
  });

  it("carries each run's output bag once", async () => {
    const snapshot = await hydrateSnapshotRuns(
      folded(),
      async (runId) => fixtureRunDetail(runId),
      0,
    );
    const wire = JSON.stringify(responseBody(snapshot));
    FIXTURE_RUN_IDS.forEach((runId, runIndex) => {
      const report = fixtureRunOutput(runIndex)['report'] as string;
      expect(occurrences(wire, report)).toBe(1);
      expect(runSurfaceOutputs(snapshot.workflowRuns[runId]!)).toEqual(fixtureRunOutput(runIndex));
      expect(snapshot.workflowRuns[runId]!.result?.output).toBeUndefined();
    });
  });

  it('mounts every card from the snapshot, with no read of the run detail', async () => {
    expect(cardsNeedingRead(folded())).toBe(FIXTURE_MOUNTED_RUN_IDS.length);
    const snapshot = await hydrateSnapshotRuns(
      folded(),
      async (runId) => fixtureRunDetail(runId),
      0,
    );
    expect(cardsNeedingRead(snapshot)).toBe(0);
    for (const runId of FIXTURE_MOUNTED_RUN_IDS) {
      const run = snapshot.workflowRuns[runId]!;
      expect(run.graphFidelity).toBe('full');
      expect(run.tasks['plan']?.stepCount).toBe(14);
    }
  });

  it('reads the detail of the mounted runs only', async () => {
    const loadDetail = vi.fn(async (runId: string) => fixtureRunDetail(runId));
    await hydrateSnapshotRuns(folded(), loadDetail, 0);
    expect(loadDetail.mock.calls.map(([runId]) => runId)).toEqual([...FIXTURE_MOUNTED_RUN_IDS]);
  });

  it('keeps the refs a card reads on mount and leaves out the large ones it reads on demand', async () => {
    const snapshot = await hydrateSnapshotRuns(
      folded(),
      async (runId) => fixtureRunDetail(runId),
      0,
    );
    const detail = fixtureRunDetail(FIXTURE_RUN_IDS[0]);
    const tasks = snapshot.workflowRuns[FIXTURE_RUN_IDS[0]]!.tasks;
    expect(tasks['plan']?.inputRef).toBeUndefined();
    expect(tasks['build']?.inputRef).toBe(detail.tasks[1]?.inputRef);
    expect(tasks['build']?.outputRef).toBe(detail.tasks[1]?.outputRef);
    expect(tasks['verify']).toMatchObject({
      inputRef: detail.tasks[2]?.inputRef,
      refsElided: true,
    });
    expect(tasks['verify']?.outputRef).toBeUndefined();
  });

  it('leaves a run whose detail fails to its card, and hydrates the rest', async () => {
    const [failing] = FIXTURE_MOUNTED_RUN_IDS;
    const snapshot = await hydrateSnapshotRuns(
      folded(),
      async (runId) => {
        if (runId === failing) throw new Error('payload missing');
        return fixtureRunDetail(runId);
      },
      0,
    );
    expect(cardsNeedingRead(snapshot)).toBe(1);
    expect(runSurfaceNeedsDetailRead(snapshot.workflowRuns[failing!])).toBe(true);
    expect(runSurfaceOutputs(snapshot.workflowRuns[failing!]!)).toEqual(fixtureRunOutput(0));
  });

  it('gives a frozen card the graph so it mounts without a read', async () => {
    const base = folded();
    const runId = FIXTURE_MOUNTED_RUN_IDS[0];
    const live = base.workflowRuns[runId]!;
    const snapshot: RunViewState = {
      ...base,
      workflowSurfaceItems: [
        {
          runId,
          anchorStepExecutionId: 'earlier',
          revision: 0,
          createdAtMs: 0,
          frozenSnapshot: { ...live, isFrozen: true },
        },
        ...base.workflowSurfaceItems,
      ],
    };
    const hydrated = await hydrateSnapshotRuns(snapshot, async (id) => fixtureRunDetail(id), 0);
    const frozen = hydrated.workflowSurfaceItems[0]?.frozenSnapshot;
    expect(frozen?.graphFidelity).toBe('full');
    expect(runSurfaceNeedsDetailRead(frozen)).toBe(false);
    expect(cardsNeedingRead(hydrated)).toBe(0);
  });

  it("does not read the detail for a card mounted for an operation's display", () => {
    const base = folded();
    const snapshot: RunViewState = {
      ...base,
      workflowSurfaceItems: base.workflowSurfaceItems.map((item) => ({
        ...item,
        displaySource: 'op' as const,
      })),
    };
    expect(runsNeedingDetail(snapshot)).toEqual([]);
  });

  it('measures the snapshot before and after on the 82f35556 shape', async () => {
    const folding = folded();
    const snapshot = await hydrateSnapshotRuns(
      folding,
      async (runId) => fixtureRunDetail(runId),
      0,
    );
    const measurement = {
      snapshotBytesBefore: SNAPSHOT_BYTES_BEFORE,
      runDetailReadsBefore: FIXTURE_MOUNTED_RUN_IDS.length,
      runDetailBytesEach: FIXTURE_MOUNTED_RUN_IDS.map((runId) => bytes(fixtureRunDetail(runId))),
      foldOnlySnapshotBytes: bytes(responseBody(folding)),
      snapshotBytesAfter: bytes(responseBody(snapshot)),
      workflowRunsBytesAfter: bytes(snapshot.workflowRuns),
      runDetailReadsAfter: cardsNeedingRead(snapshot),
    };
    console.log(`[snapshot measurement] ${JSON.stringify(measurement)}`);
    expect(measurement.runDetailReadsAfter).toBe(0);
    expect(measurement.snapshotBytesAfter).toBeLessThan(SNAPSHOT_BYTES_BEFORE);
  });
});
