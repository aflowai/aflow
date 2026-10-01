/**
 * Contract: what a workflow-dispatched host step streams reaches a session that
 * is watching the run.
 *
 * Every break in this path was found on a live run and none by a test: the
 * executor's grant lacked the progress-stream keys and `ACL LOG` said NOPERM,
 * the wake never landed, the buffer sat unread. Each half had a test of its own
 * and each of those tests faked the half next to it, so the seams — which is
 * where all of it failed — were the part nothing exercised.
 *
 * So this runs the chain rather than its pieces: a real job for
 * `host.harness.run`, claimed by a real `ExecutorRuntime` from a real Redis
 * under the real rendered host grant, then the consumer's decode and wake, then
 * the server's live reader. A step a workflow dispatched has no session of its
 * own, which is the case that broke — the buffer is keyed by the step, the wake
 * travels the task's progress stream, and the session parked on the run is the
 * only reader the buffer has.
 *
 * Skipped without a reachable Redis, and without a sandbox: a harness step that
 * cannot be confined is refused before it prints anything, which would leave
 * this asserting the refusal rather than the feed.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConsumerGroups,
  HarnessActivityLineSchema,
  StreamKeys,
  WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE,
  type ApiSessionEvent,
  type IdempotencyKey,
  type OperationId,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type StepJobMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import {
  addStepJob,
  getWriteApprovalGrant,
  shardFor,
  type BlockingRedisConnection,
} from '@aflow/redis';
import { createRedisPayloadStore } from '@aflow/payload-store';
import {
  DEFAULT_EXECUTOR_CONFIG,
  ExecutorRuntime,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import { decodeLiveDeltaWake, publishWorkflowLiveDeltaWake } from '@aflow/cybernetic-runtime';
import { workflowRuns } from '@aflow/database';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

// The lane's own executor, imported across the workspace seam on purpose: the
// handler under test is the one the paired machine runs, and a stand-in for it
// here would fake exactly the half this file exists to stop faking.
import { createHostHandler } from '../../../../apps/aflow-executor-host/src/handlers/hostHandler.js';
import { sandboxReadiness } from '../../../../apps/aflow-executor-host/src/sandboxedRun.js';
import { createLiveDeltaReader } from '../services/sessionLiveDeltas.js';
import {
  applyHostGrant,
  hostGrantDenials,
  hostGrantUrl,
  hostTestUser,
  redisReachable,
} from './__fixtures__/hostGrantRedis.js';

/** A database of this file's own, and every key in it deleted by name. */
const TEST_DB = 13;
const TEST_USER = hostTestUser('feed');

const TENANT_ID = randomUUID() as TenantId;
const SPACE_ID = randomUUID();
const RUN_ID = randomUUID();
const TASK_ID = 'write-the-note';
const STEP_EXECUTION_ID = randomUUID() as StepExecutionId;
/** The session watching the run — the only reader this step's buffer has. */
const SESSION_ID = randomUUID() as SessionId;

const ANSWER = 'The note is written.';

/** What a `claude-stream-json` harness prints, in the shape the reader parses. */
const EVENTS: readonly Record<string, unknown>[] = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5-1' },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the note first.' },
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'README.md' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'one\ntwo' }],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_ms: 1200,
    total_cost_usd: 0.01,
    result: ANSWER,
  },
];

const ACTIVITY_BUFFER = StreamKeys.liveStreamBuffer(TENANT_ID, STEP_EXECUTION_ID, 'activity');
const PROGRESS_STREAM = StreamKeys.workflowTaskProgressStream(TENANT_ID, RUN_ID, TASK_ID);
const RESULTS_STREAM = StreamKeys.shardResultsStream(shardFor(RUN_ID));
const SESSION_CHANNEL = StreamKeys.pubsubChannel(TENANT_ID, SESSION_ID);

// Resolved at module scope: `describe.skipIf` is evaluated at collection, before
// any `beforeAll` has run.
const AVAILABLE = (await redisReachable(TEST_DB)) && sandboxReadiness().ready;

let admin: Redis | null = null;
let host: Redis | null = null;
let hostBlocking: BlockingRedisConnection | null = null;
let runtime: ExecutorRuntime | null = null;
let policyPath = '';

/**
 * Never a flush: whoever else uses this database keeps their keys.
 *
 * The payload keys are spelled out because nothing exports the ref-to-key
 * mapping the Redis store uses. They carry a TTL of their own, so a spelling
 * that drifts from the store leaves them to expire rather than leaking them.
 */
const PAYLOAD_PREFIX = `aflow:payload:tenants/${TENANT_ID}/runs/${RUN_ID}/steps/${STEP_EXECUTION_ID}/attempt/1`;
const KEYS_THIS_FILE_WRITES = [
  ACTIVITY_BUFFER,
  PROGRESS_STREAM,
  RESULTS_STREAM,
  StreamKeys.jobStream('host'),
  `${PAYLOAD_PREFIX}/input.json`,
  `${PAYLOAD_PREFIX}/output.json`,
  `${PAYLOAD_PREFIX}/activity.json`,
] as const;

/** What the harness's event stream reads as, line for line. */
const EXPECTED_KINDS = ['status', 'thought', 'tool', 'tool_result', 'status'] as const;

function requireAdmin(): Redis {
  if (admin === null) throw new Error('This test needs the admin connection its setup opens.');
  return admin;
}

/**
 * Poll until `done` holds, so a wake that has not landed yet is not a failure.
 *
 * A timeout names what the server refused this identity, because a grant missing
 * a key family is what this waits out: the executor logs the NOPERM as a warning
 * and carries on, so without this the failure is a silence.
 */
async function until(
  what: string,
  done: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return;
    if (Date.now() > deadline) {
      const denials = admin === null ? [] : await hostGrantDenials(admin, TEST_USER);
      throw new Error(
        `Timed out waiting for ${what}.` +
          (denials.length > 0 ? ` Redis refused: ${denials.join('; ')}` : ''),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function fieldsOf(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) out[pairs[i]!] = pairs[i + 1]!;
  return out;
}

async function progressEntries(): Promise<Array<Record<string, string>>> {
  const entries = (await requireAdmin().xrange(PROGRESS_STREAM, '-', '+')) as Array<
    [string, string[]]
  >;
  return entries.map(([, pairs]) => fieldsOf(pairs));
}

async function bufferedFeed(): Promise<string> {
  return (await requireAdmin().get(ACTIVITY_BUFFER)) ?? '';
}

async function activityLines(): Promise<string[]> {
  return (await bufferedFeed()).split('\n').filter((line) => line !== '');
}

beforeAll(async () => {
  if (!AVAILABLE) return;
  admin = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB });
  await applyHostGrant(admin, TEST_USER);
  await admin.del(...KEYS_THIS_FILE_WRITES);

  const base = await mkdtemp(join(tmpdir(), 'host-lane-feed-'));
  const repo = join(base, 'project');
  await mkdir(repo, { recursive: true });
  const vcs = async (...args: string[]): Promise<void> => {
    await promisify(execFile)('git', args, { cwd: repo });
  };
  await vcs('init', '-b', 'main');
  await vcs('config', 'user.email', 'test@example.com');
  await vcs('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8');
  // Committed, so replaying it is not a change the run made.
  await writeFile(
    join(repo, 'stream.ndjson'),
    `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
  await vcs('add', '-A');
  await vcs('commit', '-m', 'initial');

  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: SPACE_ID,
        },
      ],
      harnesses: [
        {
          id: 'streaming',
          executable: '/bin/sh',
          args: ['-c', 'cat stream.ndjson'],
          output: 'claude-stream-json',
        },
      ],
    }),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.stop().catch(() => undefined);
  if (hostBlocking !== null) hostBlocking.disconnect();
  if (host !== null) await host.quit().catch(() => undefined);
  if (admin !== null) {
    await admin.del(...KEYS_THIS_FILE_WRITES).catch(() => undefined);
    await admin
      .srem(StreamKeys.workflowTaskProgressIndexKey, PROGRESS_STREAM)
      .catch(() => undefined);
    await admin.call('ACL', 'DELUSER', TEST_USER).catch(() => undefined);
    await admin.quit();
  }
}, 60_000);

describe.skipIf(!AVAILABLE)('a workflow-dispatched host step feeding a watching session', () => {
  it('streams its feed and indexes the wake, with nothing refused', async () => {
    const url = hostGrantUrl(TEST_USER, TEST_DB);
    host = new Redis(url);
    hostBlocking = new Redis(url) as BlockingRedisConnection;
    const payloadStore = createRedisPayloadStore(host);
    const deps: ExecutorDependencies = { redis: host, redisBlocking: hostBlocking, payloadStore };

    runtime = new ExecutorRuntime(
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        consumerName: `host-lane-feed-${String(process.pid)}`,
        consumerGroup: ConsumerGroups.executor('host'),
        streamKey: StreamKeys.jobStream('host'),
        stepType: 'host',
        concurrency: 1,
        defaultTimeoutMs: 120_000,
        blockMs: 500,
        claimPendingOnStart: false,
      },
      deps,
    );
    runtime.registerHandler(
      createHostHandler(policyPath, (tenantId, runId, requestHash) =>
        getWriteApprovalGrant(deps.redis, tenantId, runId, requestHash),
      ),
    );
    await runtime.start();

    // Written by the appliance, read by the machine — so it goes through the
    // payload store rather than riding inline on the message, which is the only
    // form that touches the payload keyspace the grant has to admit.
    const inputRef = await payloadStore.store({
      tenantId: TENANT_ID,
      runId: RUN_ID as SessionId,
      stepExecutionId: STEP_EXECUTION_ID,
      attempt: 1,
      kind: 'input',
      data: { bindingId: 'hb', harness: 'streaming', task: 'Write the note.', timeoutMs: 60_000 },
    });

    const job: StepJobMessage = {
      messageVersion: 1,
      tenantId: TENANT_ID,
      // No session: this is the dispatch shape whose feed had no road to a reader.
      workflowExecution: {
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        dispatchAttemptToken: `dispatch:${RUN_ID}:${TASK_ID}:1`,
      },
      stepExecutionId: STEP_EXECUTION_ID,
      stepId: 'harness-turn' as StepId,
      stepType: 'host',
      operationId: 'host.harness.run' as OperationId,
      attempt: 1,
      idempotencyKey: `${RUN_ID}:${TASK_ID}:1` as IdempotencyKey,
      inputRef,
      traceId: randomUUID().replace(/-/g, '') as TraceId,
      scheduledAtMs: Date.now(),
      spaceId: SPACE_ID,
    };
    // Enqueued as the appliance, which is the identity the orchestrator holds.
    await addStepJob(requireAdmin(), job);

    const results = async (): Promise<Array<Record<string, string>>> => {
      const entries = (await requireAdmin().xrange(RESULTS_STREAM, '-', '+')) as Array<
        [string, string[]]
      >;
      return entries
        .map(([, pairs]) => fieldsOf(pairs))
        .filter((f) => f['stepExecutionId'] === STEP_EXECUTION_ID);
    };
    await until('the step to report a result', async () => (await results()).length > 0);

    const result = (await results())[0];
    expect(result?.['status']).toBe('SUCCEEDED');

    // The appends and the wake are emitted while the harness runs, so they are
    // awaited rather than assumed to have landed with the result.
    await until(
      "the feed to reach the step's buffer",
      async () => (await activityLines()).length === EXPECTED_KINDS.length,
    );
    const lines = (await activityLines()).map((line) =>
      HarnessActivityLineSchema.parse(JSON.parse(line)),
    );
    expect(lines.map((l) => l.kind)).toEqual([...EXPECTED_KINDS]);

    await until(
      'a wake on the task progress stream',
      async () => (await progressEntries()).length > 0,
    );
    const wakes = (await progressEntries()).filter(
      (f) => f['eventType'] === WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE,
    );
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes[0]?.['stepExecutionId']).toBe(STEP_EXECUTION_ID);
    expect(wakes[0]?.['runId']).toBe(RUN_ID);
    expect(wakes[0]?.['tenantId']).toBe(TENANT_ID);

    // Discovery reads this index rather than scanning the keyspace, so a stream
    // missing from it is a feed nothing consumes.
    expect(
      await requireAdmin().sismember(StreamKeys.workflowTaskProgressIndexKey, PROGRESS_STREAM),
    ).toBe(1);

    // The feed outlives the buffer by reference, so the run view still has it
    // once the live plane has expired.
    const output = (await payloadStore.retrieve(result?.['outputRef'] as PayloadRef)) as Record<
      string,
      unknown
    >;
    expect(typeof output['activityRef']).toBe('string');
    const kept = (await payloadStore.retrieve(output['activityRef'] as PayloadRef)) as unknown[];
    expect(kept.map((l) => HarnessActivityLineSchema.parse(l))).toEqual(lines);

    expect(await hostGrantDenials(requireAdmin(), TEST_USER)).toEqual([]);
  }, 180_000);

  it('turns the stream entry into one live-delta wake on the watching session', async () => {
    const entries = await progressEntries();
    const decoded = entries.map((fields) => decodeLiveDeltaWake(fields)).filter((w) => w !== null);
    expect(decoded[0]).toMatchObject({
      runId: RUN_ID,
      taskId: TASK_ID,
      stepExecutionId: STEP_EXECUTION_ID,
      channel: 'activity',
    });

    const subscriber = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB });
    const received: string[] = [];
    subscriber.on('message', (_channel, message: string) => {
      received.push(message);
    });
    await subscriber.subscribe(SESSION_CHANNEL);

    try {
      await publishWorkflowLiveDeltaWake(
        { db: watchedBy(SESSION_ID), redis: requireAdmin() },
        { tenantId: TENANT_ID, runId: RUN_ID, channel: 'activity' },
      );
      await until(
        'the wake to arrive on the session channel',
        () => Promise.resolve(received.length > 0),
        5_000,
      );
    } finally {
      await subscriber.quit();
    }

    // The shape `subscribeSessionWakeup` tells the two planes apart by: a
    // `LiveDelta:` prefix is what keeps a 150ms flush from driving the durable
    // drain.
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0] ?? '{}')).toMatchObject({
      type: 'event',
      runId: SESSION_ID,
      eventType: 'LiveDelta:activity',
    });
  }, 30_000);

  it('reads the buffer for a run task step it learned from a task update', async () => {
    const reader = createLiveDeltaReader(requireAdmin(), TENANT_ID, SESSION_ID);
    reader.observe(taskUpdateEvent());

    const frames = await reader.read(new AbortController().signal);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      stepExecutionId: STEP_EXECUTION_ID,
      channel: 'activity',
      offset: 0,
    });
    expect(frames[0]?.delta).toBe(await bufferedFeed());
  }, 30_000);
});

/**
 * The event the run surface is built from, which is also how the reader learns
 * that a step belonging to no session is one it should read for.
 */
function taskUpdateEvent(): ApiSessionEvent {
  return {
    eventId: randomUUID(),
    eventType: 'WorkflowTaskUpdate',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    sequenceNumber: 1,
    eventVersion: 1,
    data: {
      workflowTaskUpdate: {
        runId: RUN_ID,
        taskId: TASK_ID,
        label: 'Write the note',
        status: 'running',
        attempt: 1,
        workerSessionId: STEP_EXECUTION_ID,
        taskType: 'operation',
        operationId: 'host.harness.run',
      },
    },
  };
}

/**
 * The run's audience, without a database. `publishWorkflowLiveDeltaWake` resolves
 * it from the waiter rows and the run's originating session; this answers no
 * waiters and one originating session, which is the case a chat watching its own
 * run presents.
 */
function watchedBy(sessionId: SessionId): PostgresJsDatabase {
  const rows = (table: unknown): unknown[] => (table === workflowRuns ? [{ sessionId }] : []);
  const tx = {
    execute: () => Promise.resolve(undefined),
    select: () => ({
      from: (table: unknown) => {
        const answer = Promise.resolve(rows(table));
        return {
          where: () => Object.assign(answer, { limit: () => answer }),
        };
      },
    }),
  };
  return {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PostgresJsDatabase;
}
